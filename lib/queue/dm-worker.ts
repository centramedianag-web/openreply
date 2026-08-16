import { Worker, type Job } from "bullmq";
import {
  getDMQueue,
  getRedisConnection,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
  FOLLOWUP_JOB_NAME,
  type DmQueueJob,
  type ProcessCommentJob,
  type ProcessMessageJob,
  type ProcessPostbackJob,
  type ProcessFollowUpJob,
} from "./client";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
  getUserFollowStatus,
  sendCommentReply,
  sendDirectMessage,
  sendDirectMessageImage,
  sendDirectMessageWithButton,
  sendDirectMessageWithLinkButton,
  sendDirectMessageWithMenu,
  type MenuButton,
  sendPrivateReply,
  sendPrivateReplyWithButton,
  sendPrivateReplyWithLinkButton,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { generateSmartReply, isAiConfigured } from "@/lib/ai/smart-reply";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import {
  buildTrackedUrl,
  personalize,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";
import {
  buildFollowCheckPayload,
  buildRevealPayload,
  buildStepPayload,
  parsePostback,
} from "@/lib/dm/postback";

const BACKOFF_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

// How many auto-advancing steps one tap may deliver. Real sequences are two or
// three messages; ten is far above anything intentional and well below a number
// that would annoy a recipient before the loop is noticed.
const MAX_STEP_CHAIN = 10;

// Jobs processed at once, across every client on the instance. This is the one
// shared resource a busy tenant can starve: a menu step sends its images before
// its text, so it holds a slot for several sequential Meta calls where a flat
// campaign held it for one.
//
// The work is entirely I/O — waiting on Meta — so the ceiling is Meta's rate
// limits and the database pool, not CPU. 5 was low enough that one client's
// burst delayed everyone else's replies, and an Instagram DM is judged on
// arriving in seconds.
const DM_WORKER_CONCURRENCY = Number(process.env.DM_WORKER_CONCURRENCY ?? 15);

// Per-account AI replies allowed per UTC day. 300 is far above any real
// client's inbound volume (the busiest sampled account saw ~60 DMs total) and
// caps a runaway day at roughly ₹25.
const AI_DAILY_REPLY_CAP = Number(process.env.AI_DAILY_REPLY_CAP ?? 300);

function formatError(error: unknown): string {
  if (error instanceof MetaApiError) {
    return `Meta API Error ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

// Meta rejections that a plain-text retry cannot fix: the send was refused for
// the conversation, not for the button template. Retrying as text just burns
// the attempt and — worse — overwrites the real error with a misleading one
// ("invalid for a private reply", because the first attempt already used up the
// comment's single allowed private reply).
const NON_TEMPLATE_REJECTIONS = [
  /outside of allowed window/i,
  /invalid for a private reply/i,
  /requested user cannot be found/i,
];

function isTemplateRejection(error: unknown): boolean {
  if (error instanceof TokenExpiredError || error instanceof RateLimitError) {
    return false;
  }
  const message = error instanceof Error ? error.message : "";
  return !NON_TEMPLATE_REJECTIONS.some((pattern) => pattern.test(message));
}

type WorkerTrackedLink = {
  slug: string;
  label: string | null;
  destinationUrl: string;
};

/**
 * Build the tappable link buttons for a DM. The first link uses the campaign's
 * `linkButtonLabel`; each additional link uses its own stored `label`. Capped at
 * Meta's 3-button limit for a button template.
 */
function buildLinkButtons(
  trackedLinks: WorkerTrackedLink[],
  primaryLabel: string | null
): { title: string; url: string }[] {
  return trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug),
    title: (index === 0 ? primaryLabel : link.label) || link.label || "Open link",
  }));
}

/**
 * Fallback text when Meta rejects the button template: render the primary link
 * inline, then append any extra tracked URLs on their own lines so no link is
 * lost.
 */
function buildInlineLinkFallback(
  message: string,
  commenterName: string | null | undefined,
  trackedLinks: WorkerTrackedLink[],
  bodyText: string
): string {
  const base =
    renderMessageWithTracking({ message, commenterName, trackedLinks }) ||
    bodyText;
  const extraUrls = trackedLinks.slice(1).map((link) => buildTrackedUrl(link.slug));
  return extraUrls.length > 0 ? `${base}\n${extraUrls.join("\n")}` : base;
}

/**
 * Choose the text for a single DM send.
 *
 * With variations configured one is picked at random, so a campaign that fires
 * hundreds of times does not drop the identical string into hundreds of
 * inboxes. `dmMessage` stays the fallback, which keeps every campaign created
 * before variations existed working untouched.
 *
 * Call this ONCE per send and reuse the result: the button template and its
 * inline-link fallback are two attempts at delivering the same message, so
 * re-picking between them could send a different variation than the one the
 * recipient was about to get.
 */
export function pickDmMessage(automation: {
  dmMessage: string;
  dmMessages?: string[];
}): string {
  const pool = automation.dmMessages ?? [];
  if (pool.length === 0) return automation.dmMessage;
  return pool[Math.floor(Math.random() * pool.length)];
}

type RevealAutomation = {
  dmMessage: string;
  dmMessages?: string[];
  dmImageUrl?: string | null;
  linkButtonLabel: string | null;
  trackedLinks: WorkerTrackedLink[];
  instagramAccount: { instagramId: string };
};

/**
 * Send the campaign's image as a follow-on message, if one is configured.
 *
 * Never throws. The text has already been delivered by the time this runs, so
 * a rejected image (URL gone, wrong content type, over 8MB) must not fail the
 * job and trigger a retry — that would send the text a second time.
 */
async function sendRevealImage(
  accessToken: string,
  automation: RevealAutomation,
  userId: string,
  context: string
): Promise<void> {
  if (!automation.dmImageUrl) return;
  try {
    await sendDirectMessageImage(
      accessToken,
      automation.instagramAccount.instagramId,
      userId,
      automation.dmImageUrl
    );
  } catch (imageError) {
    console.error(
      `[DM Worker] Image attachment failed in ${context} (text was delivered):`,
      formatError(imageError)
    );
  }
}

/**
 * Deliver a campaign's reveal message as a direct message. Shared by the
 * button-tap (postback) path and the DM keyword-trigger path — both already
 * have an open conversation with the user, so neither uses a private reply.
 */
async function sendRevealDirectMessage(
  accessToken: string,
  automation: RevealAutomation,
  userId: string,
  commenterName: string | null,
  context: string
): Promise<void> {
  // Resolved once so the button attempt and the inline fallback below deliver
  // the same variation.
  const chosenMessage = pickDmMessage(automation);

  if (automation.trackedLinks.length === 0) {
    await sendDirectMessage(
      accessToken,
      automation.instagramAccount.instagramId,
      userId,
      renderMessageWithTracking({
        message: chosenMessage,
        commenterName,
        trackedLinks: automation.trackedLinks,
      })
    );
    await sendRevealImage(accessToken, automation, userId, context);
    return;
  }

  // Try button template first; if Meta rejects it, fall back to inline links.
  const bodyText =
    renderMessageWithoutLink({
      message: chosenMessage,
      commenterName,
    }) || "Here's your link:";
  const buttons = buildLinkButtons(
    automation.trackedLinks,
    automation.linkButtonLabel
  );

  try {
    await sendDirectMessageWithLinkButton(
      accessToken,
      automation.instagramAccount.instagramId,
      userId,
      bodyText,
      buttons
    );
  } catch (buttonError) {
    // A closed messaging window rejects the text retry too, so don't let it
    // overwrite the original error with a misleading one.
    if (!isTemplateRejection(buttonError)) throw buttonError;

    console.log(
      `[DM Worker] Button template rejected in ${context}, falling back to inline link:`,
      formatError(buttonError)
    );
    try {
      await sendDirectMessage(
        accessToken,
        automation.instagramAccount.instagramId,
        userId,
        buildInlineLinkFallback(
          chosenMessage,
          commenterName,
          automation.trackedLinks,
          bodyText
        )
      );
    } catch {
      throw buttonError;
    }
  }

  await sendRevealImage(accessToken, automation, userId, context);
}

async function processComment(job: Job<ProcessCommentJob>): Promise<void> {
  const {
    instagramAccountId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;

  const automations = await prisma.automation.findMany({
    where: {
      // Match campaigns bound to this specific post, plus any-post campaigns.
      OR: [{ postId: mediaId }, { matchAnyPost: true }],
      isActive: true,
      instagramAccount: {
        instagramId: instagramAccountId,
      },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: {
          slug: true,
          label: true,
          destinationUrl: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Whether any campaign laid claim to this comment. Set on the match itself,
  // not on a successful send: if a campaign matched but its DM failed, the
  // comment still belongs to that campaign and the AI must stay out of it.
  let claimedByCampaign = false;

  for (const automation of automations) {
    // "Any word" campaigns fire on every comment; otherwise require a keyword hit.
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) {
      continue;
    }

    claimedByCampaign = true;

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId,
        },
      },
    });

    const alreadyDmd = existingLog?.status === "SENT";
    const alreadyPublicReplied = Boolean(existingLog?.publicReplySentAt);
    const needsDm = !alreadyDmd;

    // Skip only when there is genuinely nothing left to do. A comment whose DM
    // already sent but whose public reply never posted (e.g. it hit a rate
    // limit) must still come back so the public reply can be retried.
    if (existingLog?.status === "SKIPPED_PLAN_LIMIT") continue;
    if (alreadyDmd && (alreadyPublicReplied || !automation.publicReplyEnabled)) {
      continue;
    }

    if (!automation.instagramAccount.accessToken) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(automation.instagramAccount.accessToken);
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    // Ensure a log row exists before the public reply leg (which updates it).
    // Only (re)set PENDING when the DM will actually be attempted, so a prior
    // SENT is never clobbered while we come back just to retry the public reply.
    if (!existingLog) {
      await prisma.dmLog.create({
        data: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "PENDING",
          attempts: job.attemptsMade + 1,
        },
      });
    } else if (needsDm) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "PENDING",
          attempts: job.attemptsMade + 1,
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: null,
        },
      });
    }

    // Public reply leg — decoupled from the DM and posted first so a DM failure
    // (e.g. a non-follower whose messaging is restricted) never suppresses it.
    // Idempotent across retries via publicReplySentAt.
    const replyPool =
      automation.publicReplyMessages.length > 0
        ? automation.publicReplyMessages
        : automation.publicReplyMessage
          ? [automation.publicReplyMessage]
          : [];
    if (
      automation.publicReplyEnabled &&
      replyPool.length > 0 &&
      !existingLog?.publicReplySentAt
    ) {
      try {
        const chosen = replyPool[Math.floor(Math.random() * replyPool.length)];
        const publicReply = renderMessageWithTracking({
          message: chosen,
          commenterName,
          trackedLinks: automation.trackedLinks,
        });
        await sendCommentReply(accessToken, commentId, publicReply);
        await prisma.dmLog.update({
          where: {
            automationId_commentId: { automationId: automation.id, commentId },
          },
          data: { publicReplySentAt: new Date(), publicReplyError: null },
        });
      } catch (error) {
        console.error(
          "[DM Worker] Public comment reply failed:",
          formatError(error)
        );
        await prisma.dmLog
          .update({
            where: {
              automationId_commentId: { automationId: automation.id, commentId },
            },
            data: { publicReplyError: formatError(error) },
          })
          .catch(() => {});
      }
    }

    // DM already sent on an earlier pass; the public reply retry above was all
    // this run needed. Don't re-send the DM.
    if (!needsDm) continue;

    // Meta allows exactly ONE private reply per comment, ever — across every
    // campaign. When several campaigns match the same comment (duplicated
    // campaigns, or an any-post campaign overlapping a post-specific one), only
    // the first can deliver; the rest would fail with "The comment is invalid
    // for a private reply". Skip them explicitly instead of burning an API call
    // and logging a failure the user can do nothing about. The public reply
    // above still goes out per campaign — only the DM leg is deduped.
    const privateReplyUsedBy = await prisma.dmLog.findFirst({
      where: {
        commentId,
        status: "SENT",
        automationId: { not: automation.id },
      },
      select: { automation: { select: { name: true } } },
    });
    if (privateReplyUsedBy) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Another campaign (${privateReplyUsedBy.automation?.name ?? "unknown"}) already sent the one private reply Instagram allows for this comment`,
        },
      });
      continue;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SKIPPED_PLAN_LIMIT",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    let rateLimit;
    try {
      rateLimit = await reserveDMSlot(instagramAccountId, requeueAttempt);
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
      });
      throw error;
    }

    if (!rateLimit.allowed) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      if (rateLimit.shouldSkip) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "SKIPPED_RATE_LIMIT",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly Instagram DM rate limit reached",
          },
        });
        continue;
      }

      if (rateLimit.shouldRequeue) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "PENDING",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly rate limit hit; retry scheduled",
          },
        });

        await getDMQueue().add(
          "process-comment",
          {
            ...job.data,
            requeueAttempt: requeueAttempt + 1,
          },
          {
            delay: rateLimit.requeueDelayMs,
            jobId: `comment_${instagramAccountId}_${commentId}_retry_${requeueAttempt + 1}`,
          }
        );
        continue;
      }
    }

    // With an opening DM, the private reply is a button message; tapping it
    // fires a postback that delivers the reveal (see processPostback). Without
    // one, we send the reveal text directly as today.
    const useOpeningDm =
      automation.openingDmEnabled &&
      Boolean(automation.openingDmMessage) &&
      Boolean(automation.openingDmButtonLabel);

    // Follow-gating: the link is revealed only after a follow. When an opening
    // DM is enabled it comes FIRST, and its button routes into the follow check
    // (opening DM → follow gate → link). Without an opening DM, we check follow
    // status at comment time: confirmed followers get the link now, everyone
    // else gets the "follow me first" prompt (re-verified on tap).
    let sendFollowPrompt = false;
    if (automation.requireFollow && !useOpeningDm) {
      const alreadyFollows = await getUserFollowStatus(accessToken, commenterId);
      sendFollowPrompt = alreadyFollows !== true;
    }

    try {
      if (useOpeningDm) {
        const openingText = renderMessageWithTracking({
          message: automation.openingDmMessage as string,
          commenterName,
          trackedLinks: [],
        });
        await sendPrivateReplyWithButton(
          accessToken,
          automation.instagramAccount.instagramId,
          commentId,
          openingText,
          automation.openingDmButtonLabel as string,
          automation.requireFollow
            ? buildFollowCheckPayload(automation.id)
            : buildRevealPayload(automation.id)
        );
      } else if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
          commenterName,
        });
        await sendPrivateReplyWithButton(
          accessToken,
          automation.instagramAccount.instagramId,
          commentId,
          promptText,
          automation.followPromptButtonLabel || "i'm following",
          buildFollowCheckPayload(automation.id)
        );
      } else if (automation.trackedLinks.length > 0) {
        // Resolved once so the button attempt and the inline fallback below
        // deliver the same variation.
        const chosenMessage = pickDmMessage(automation);
        // Try button template first; if Meta rejects it, fall back to inline links.
        const bodyText =
          renderMessageWithoutLink({
            message: chosenMessage,
            commenterName,
          }) || "Here's your link:";
        const buttons = buildLinkButtons(
          automation.trackedLinks,
          automation.linkButtonLabel
        );

        try {
          await sendPrivateReplyWithLinkButton(
            accessToken,
            automation.instagramAccount.instagramId,
            commentId,
            bodyText,
            buttons
          );
        } catch (buttonError) {
          // Only a template rejection is worth retrying as text. Anything else
          // (closed window, comment already replied to) fails the same way and
          // would replace the real error with a misleading one.
          if (!isTemplateRejection(buttonError)) throw buttonError;

          console.log(
            "[DM Worker] Button template rejected, falling back to inline link:",
            formatError(buttonError)
          );
          const fallbackMessage = buildInlineLinkFallback(
            chosenMessage,
            commenterName,
            automation.trackedLinks,
            bodyText
          );
          try {
            await sendPrivateReply(
              accessToken,
              automation.instagramAccount.instagramId,
              commentId,
              fallbackMessage
            );
          } catch {
            // The first attempt consumed the comment's single private reply, so
            // this one reports "invalid for a private reply" no matter what the
            // underlying problem was. Surface the original rejection instead.
            throw buttonError;
          }
        }
      } else {
        const dmMessage = renderMessageWithTracking({
          message: pickDmMessage(automation),
          commenterName,
          trackedLinks: automation.trackedLinks,
        });
        await sendPrivateReply(
          accessToken,
          automation.instagramAccount.instagramId,
          commentId,
          dmMessage
        );
      }

      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
      });
      throw error;
    }
  }

  // Last, and only on what no campaign wanted. Reached either because the
  // comment matched no keyword, or because the post has no campaign on it at
  // all — in which case every comment on it arrives here.
  if (!claimedByCampaign) {
    await tryAiCommentReply(
      instagramAccountId,
      commentId,
      commentText,
      commenterId
    );
  }
}

/**
 * Deliver one screen of a branching menu: its images first, then its text with
 * its buttons underneath.
 *
 * Reached from a `step:<stepId>` postback, which is every tap after the first
 * in a menu-driven campaign. Unlike the reveal path this is re-entrant by
 * design — menus loop, so the same user hitting the same step repeatedly is
 * ordinary navigation, not a duplicate to suppress.
 */
async function deliverStep(params: {
  stepId: string;
  instagramAccountId: string;
  userId: string;
  delayApplied?: boolean;
  hop?: number;
}): Promise<void> {
  const { stepId, instagramAccountId, userId, delayApplied, hop = 0 } = params;

  // A chain is a sequence, not a loop, but nothing stops an author wiring one
  // — and a loop here means messaging a real person until the quota runs out.
  // The database forbids a step following itself; this forbids the longer
  // cycles it cannot see.
  if (hop >= MAX_STEP_CHAIN) {
    console.log(
      `[DM Worker] step chain from ${stepId} hit ${MAX_STEP_CHAIN} hops; stopping`
    );
    return;
  }

  const step = await prisma.automationStep.findUnique({
    where: { id: stepId },
    include: {
      buttons: { orderBy: { sort: "asc" } },
      automation: {
        include: {
          instagramAccount: true,
          trackedLinks: {
            select: { slug: true, destinationUrl: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  if (!step) return;
  const { automation } = step;

  if (
    !automation.isActive ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !automation.instagramAccount.accessToken
  ) {
    return;
  }

  // A step with a delay re-queues itself once and returns, rather than holding
  // a worker slot asleep. The deterministic job id means a user hammering the
  // button gets one pending delivery, not one per tap.
  if (step.delaySeconds > 0 && !delayApplied) {
    await getDMQueue().add(
      POSTBACK_JOB_NAME,
      {
        instagramAccountId,
        userId,
        payload: buildStepPayload(step.id),
        delayApplied: true,
        stepHop: hop,
      },
      {
        delay: step.delaySeconds * 1000,
        jobId: `step_${step.id}_${userId}`,
      }
    );
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(automation.instagramAccount.accessToken);
  } catch {
    return;
  }

  // Instagram only gives us a display name on some events, so reuse whatever an
  // earlier interaction captured. Missing is normal; personalize() falls back.
  const priorLog = await prisma.dmLog.findFirst({
    where: { automationId: automation.id, commenterId: userId },
    select: { commenterName: true },
  });
  const commenterName = priorLog?.commenterName ?? null;

  const dedupeId = `step:${step.id}:${userId}`;

  // One reservation per step, not per message, matching the reveal path — an
  // image and the text that explains it are one delivery to the recipient and
  // should cost one against the plan.
  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: `(step: ${step.name ?? step.id})`,
        commentId: dedupeId,
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
      update: { status: "SKIPPED_PLAN_LIMIT" },
    });
    return;
  }

  try {
    // Images before text: the caption should arrive under the thing it
    // captions, and a rate card the user is already looking at reads better
    // than one that appears after the question about it.
    for (const imageUrl of step.imageUrls) {
      await sendDirectMessageImage(
        accessToken,
        automation.instagramAccount.instagramId,
        userId,
        imageUrl
      );
    }

    const buttons: MenuButton[] = step.buttons.map((b) => {
      if (b.targetStepId) {
        return { title: b.label, payload: buildStepPayload(b.targetStepId) };
      }
      // Swap a plain destination for its tracked equivalent when the campaign
      // has one, so a tap through a menu is counted the same as a tap from a
      // flat campaign. Same substitution renderMessageWithTracking does inline.
      const tracked = automation.trackedLinks.find(
        (t) =>
          t.destinationUrl === b.url ||
          t.destinationUrl.replace(/\/$/, "") === b.url?.replace(/\/$/, "")
      );
      return {
        title: b.label,
        url: tracked ? buildTrackedUrl(tracked.slug) : b.url!,
      };
    });

    const text = personalize(step.text, commenterName);

    if (buttons.length > 0) {
      await sendDirectMessageWithMenu(
        accessToken,
        automation.instagramAccount.instagramId,
        userId,
        text,
        buttons
      );
    } else {
      // A leaf with no buttons is a plain message. Sending it as a button
      // template with an empty button array is rejected by Meta.
      await sendDirectMessage(
        accessToken,
        automation.instagramAccount.instagramId,
        userId,
        text
      );
    }

    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: `(step: ${step.name ?? step.id})`,
        commentId: dedupeId,
        status: "SENT",
        dmSentAt: new Date(),
      },
      update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });
  } catch (error) {
    await releaseWorkspaceDMReservation(
      automation.workspaceId,
      usage.periodStart
    );
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: `(step: ${step.name ?? step.id})`,
        commentId: dedupeId,
        status: "FAILED",
        errorMessage: formatError(error),
      },
      update: { status: "FAILED", errorMessage: formatError(error) },
    });
    throw error;
  }

  // Only after a successful send: a follow-up that arrives when the message it
  // follows did not would read as a non-sequitur. Recursing rather than
  // enqueueing keeps the hop count honest — the next step applies its own
  // delaySeconds by re-queueing itself, so a paused chain still yields the
  // worker.
  if (step.nextStepId) {
    await deliverStep({
      stepId: step.nextStepId,
      instagramAccountId,
      userId,
      hop: hop + 1,
    });
  }
}

/**
 * Deliver the reveal message after a user taps an opening DM's button.
 * The postback payload is `reveal:<automationId>`; the sender is the user's
 * IGSID (same id as their comment author id), which we DM directly.
 */
async function processPostback(job: Job<ProcessPostbackJob>): Promise<void> {
  const { instagramAccountId, userId, payload, fallback } = job.data;

  // Unrecognised payloads are not ours — Meta sends postbacks we never
  // registered (GET_STARTED, for one). Doing nothing is the correct response.
  const target = parsePostback(payload);
  if (!target) return;

  // Menu navigation resolves a step rather than an automation, and has no
  // follow-gate or reveal semantics, so it leaves here entirely.
  if (target.kind === "step") {
    await deliverStep({
      stepId: target.stepId,
      instagramAccountId,
      userId,
      delayApplied: job.data.delayApplied,
      hop: job.data.stepHop ?? 0,
    });
    return;
  }

  const isFollowCheck = target.kind === "followcheck";
  const automationId = target.automationId;

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (
    !automation ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !automation.instagramAccount.accessToken
  ) {
    return;
  }

  // Duplicate sends are enabled: every button tap re-sends the reveal
  // instead of only firing once per person.
  const dedupeId = `reveal:${userId}`;

  if (fallback) {
    const existingReveal = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });
    if (existingReveal?.status === "SENT") return;
  }

  // Personalize {username} from the opening DM log for this user, if present.
  const openingLog = await prisma.dmLog.findFirst({
    where: { automationId: automation.id, commenterId: userId },
    select: { commenterName: true },
  });
  const commenterName = openingLog?.commenterName ?? null;

  let accessToken: string;
  try {
    accessToken = decryptToken(automation.instagramAccount.accessToken);
  } catch {
    return;
  }

  // Follow-gate: before revealing the link, verify the user follows. On a
  // `followcheck:` tap a non-follower gets the prompt again (no quota spent);
  // on a read fallback a non-follower is silently skipped — the gate must not
  // be bypassable by just reading the DM and waiting. Following, or
  // unverifiable (null), falls through and delivers the link — fail-open so a
  // real follower is never trapped.
  if ((isFollowCheck || fallback) && automation.requireFollow) {
    const follows = await getUserFollowStatus(accessToken, userId);
    if (follows === false) {
      if (fallback) return;
      const promptText = renderMessageWithoutLink({
        message:
          automation.followPromptMessage ||
          "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
        commenterName,
      });
      try {
        await sendDirectMessageWithButton(
          accessToken,
          automation.instagramAccount.instagramId,
          userId,
          promptText,
          automation.followPromptButtonLabel || "i'm following",
          buildFollowCheckPayload(automation.id)
        );
      } catch (error) {
        console.log(
          "[DM Worker] Failed to re-send follow prompt:",
          formatError(error)
        );
      }
      return;
    }
  }

  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: { automationId: automation.id, commentId: dedupeId },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
      update: { status: "SKIPPED_PLAN_LIMIT" },
    });
    return;
  }

  try {
    await sendRevealDirectMessage(
      accessToken,
      automation,
      userId,
      commenterName,
      "postback"
    );
    // Optional appreciation follow-up: once the link has been delivered, send a
    // short thank-you. It is scheduled as its own delayed job so it can go out
    // some minutes later (followUpDelayMinutes) rather than immediately. The
    // deterministic job id dedupes repeat button taps to one follow-up per user.
    if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
      const delayMs =
        Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000;
      await getDMQueue().add(
        FOLLOWUP_JOB_NAME,
        {
          instagramAccountId: automation.instagramAccount.instagramId,
          userId,
          automationId: automation.id,
          commenterName,
        },
        {
          delay: delayMs,
          jobId: `followup_${automation.id}_${userId}`,
        }
      );
    }
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: { automationId: automation.id, commentId: dedupeId },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SENT",
        dmSentAt: new Date(),
      },
      update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });
  } catch (error) {
    await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);

    // The read fallback is speculative: it only runs when the user read the
    // opening DM and never tapped the button, which means they never messaged
    // us, which means the 24-hour window is closed and Meta rejects the send
    // ("outside of allowed window"). That is the expected outcome here, not a
    // failure the user can act on — so don't log it as FAILED and don't retry
    // it against a window that cannot reopen on its own. It still delivers in
    // the case that does work: the user replied by typing instead of tapping.
    if (fallback) {
      console.log(
        "[DM Worker] Read fallback not delivered (messaging window closed):",
        formatError(error)
      );
      return;
    }

    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: { automationId: automation.id, commentId: dedupeId },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "FAILED",
        errorMessage: formatError(error),
      },
      update: { status: "FAILED", errorMessage: formatError(error) },
    });
    throw error;
  }
}

/**
 * Send the scheduled appreciation follow-up. Runs after its delay elapses.
 * Best-effort: if the message can't be delivered (e.g. the 24-hour messaging
 * window closed because the delay was long), it is logged, not retried forever.
 */
async function processFollowUp(job: Job<ProcessFollowUpJob>): Promise<void> {
  const { instagramAccountId, userId, automationId, commenterName } = job.data;

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true },
    include: { instagramAccount: true },
  });

  if (
    !automation ||
    !automation.followUpEnabled ||
    !automation.followUpMessage?.trim() ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !automation.instagramAccount.accessToken
  ) {
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(automation.instagramAccount.accessToken);
  } catch {
    return;
  }

  try {
    await sendDirectMessage(
      accessToken,
      automation.instagramAccount.instagramId,
      userId,
      renderMessageWithoutLink({
        message: automation.followUpMessage,
        commenterName: commenterName ?? null,
      })
    );
  } catch (error) {
    console.log(
      "[DM Worker] Failed to send follow-up message:",
      formatError(error)
    );
  }
}

/**
 * Reply to an inbound DM whose text matches a campaign's keywords.
 *
 * The user has messaged us, so the conversation is already open: this path
 * skips the opening DM (which exists to work around private-reply limits from
 * comments) and delivers the reveal directly, honouring the follow gate.
 * Dedup is per inbound message id, so each message triggers at most one reply.
 */
/**
 * Answer an inbound DM with an AI-written reply.
 *
 * Runs before the keyword campaigns and, when it sends, stops them: a person
 * who has just had their question answered should not also receive a canned
 * campaign message. Returns false whenever AI is off, unconfigured, or fails,
 * and the caller carries on to the campaigns as though this did not exist.
 */
/**
 * Cost ceiling, shared by the DM and comment paths.
 *
 * Each reply is cheap (~₹0.08), but nothing upstream bounds how much arrives —
 * a spam wave, or one reel that travels, can produce hundreds of events in
 * minutes. Counting DMs and comment replies against one budget is deliberate:
 * the bill is per account, not per channel.
 */
async function isOverDailyAiCap(
  accountId: string,
  username: string
): Promise<boolean> {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const repliesToday = await prisma.aiReply.count({
    where: { instagramAccountId: accountId, createdAt: { gte: startOfDayUtc } },
  });
  if (repliesToday < AI_DAILY_REPLY_CAP) return false;

  console.warn(
    `[AI] daily cap of ${AI_DAILY_REPLY_CAP} reached for @${username}; skipping`
  );
  return true;
}

async function tryAiReply(
  instagramAccountId: string,
  messageId: string,
  messageText: string,
  senderId: string
): Promise<boolean> {
  if (!isAiConfigured()) return false;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: instagramAccountId },
  });

  if (!account?.aiEnabled || !account.aiBrain?.trim()) return false;

  if (await isOverDailyAiCap(account.id, account.username)) return false;

  const generated = await generateSmartReply(account.aiBrain, messageText);
  if (!generated) return false;

  // Written before the send. A retry of this job then collides with the unique
  // messageId and gives up, rather than messaging the person a second time.
  try {
    await prisma.aiReply.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        sourceId: messageId,
        kind: "DM",
        senderId,
        inboundText: messageText,
        intent: generated.intent,
        handoff: generated.handoff,
        replyText: generated.reply,
      },
    });
  } catch {
    console.log(`[AI] ${messageId} already answered, skipping`);
    return true;
  }

  // An intent the client has prepared an answer for is answered with that
  // answer. The model still classified the question and still wrote nothing it
  // was not allowed to write — the difference is that "what's the entry fee?"
  // now returns the rate card instead of a phone number.
  //
  // Deliberately before the text send, not after: sending both would mean
  // "please call us" arriving directly above the card that answers the
  // question, which reads as though we did not understand it.
  const asset = await prisma.aiIntentAsset.findUnique({
    where: {
      instagramAccountId_intent: {
        instagramAccountId: account.id,
        intent: generated.intent,
      },
    },
    select: { stepId: true },
  });

  if (asset) {
    try {
      await deliverStep({
        stepId: asset.stepId,
        instagramAccountId: account.instagramId,
        userId: senderId,
      });
      await prisma.aiReply.update({
        where: { sourceId: messageId },
        data: { status: "SENT", sentAt: new Date() },
      });
      console.log(
        `[AI] answered ${senderId} with prepared asset for ${generated.intent}`
      );
      return true;
    } catch (error) {
      // Fall through to the model's own words. A missing image or a closed
      // messaging window should cost the customer a nicer answer, not the
      // whole reply.
      console.log(
        `[AI] asset delivery failed for ${generated.intent}, falling back to text:`,
        formatError(error)
      );
    }
  }

  try {
    const accessToken = decryptToken(account.accessToken);
    await sendDirectMessage(
      accessToken,
      account.instagramId,
      senderId,
      generated.reply
    );
    await prisma.aiReply.update({
      where: { sourceId: messageId },
      data: { status: "SENT", sentAt: new Date() },
    });
    console.log(
      `[AI] replied to ${senderId} (${generated.intent}, handoff=${generated.handoff})`
    );
    return true;
  } catch (error) {
    await prisma.aiReply.update({
      where: { sourceId: messageId },
      data: { status: "FAILED", errorMessage: formatError(error) },
    });
    console.error(`[AI] send failed for ${messageId}:`, formatError(error));
    // The row stays, so the campaigns do not now fire on top of a failed AI
    // attempt and produce a second, unrelated message.
    return true;
  }
}

/**
 * Post a public reply to a comment that no campaign claimed.
 *
 * The ordering is the whole design. On a keyword reel ("comment PRICE below"),
 * every comment carrying the keyword is claimed by the campaign and never
 * reaches here, so the funnel the client paid to promote is untouched. What
 * reaches here is the remainder — "🔥🔥", "nice work bro", "kuthe ahe he?" —
 * which today gets nothing at all. On a reel with no campaign on it, nothing
 * is claimed, so every comment lands here.
 *
 * That means the AI never has to work out whether a reel is a keyword reel.
 * It cannot, and asking it to would fail on exactly the reel that matters most.
 *
 * Public replies only. Meta permits one private reply per comment for all time,
 * and a campaign may already have spent it; a public reply has no such limit.
 *
 * Never throws: a failed comment reply must not fail the job, because the job's
 * campaign leg has already sent real DMs and a retry would send them twice.
 */
async function tryAiCommentReply(
  instagramAccountId: string,
  commentId: string,
  commentText: string,
  commenterId: string
): Promise<void> {
  if (!isAiConfigured()) return;
  // Unlike DMs, the comments webhook does deliver empty text (a comment that is
  // only a sticker or a mention), and there is nothing for the model to answer.
  if (!commentText.trim()) return;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: instagramAccountId },
  });

  if (!account?.aiCommentsEnabled || !account.aiBrain?.trim()) return;
  if (!account.accessToken) return;
  if (await isOverDailyAiCap(account.id, account.username)) return;

  const generated = await generateSmartReply(
    account.aiBrain,
    commentText,
    "comment"
  );
  if (!generated) return;

  // Written before the send, so a retried job collides on sourceId and gives up
  // rather than posting a second public reply under the client's own post.
  try {
    await prisma.aiReply.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        sourceId: commentId,
        kind: "COMMENT",
        senderId: commenterId,
        inboundText: commentText,
        intent: generated.intent,
        handoff: generated.handoff,
        replyText: generated.reply,
      },
    });
  } catch {
    console.log(`[AI] comment ${commentId} already answered, skipping`);
    return;
  }

  // Spam is classified and then dropped rather than filtered before the call:
  // we only know it is spam because the model read it. Replying would put the
  // spammer's comment in front of the client's whole audience, so the row is
  // kept (retries stay deduped and the cost is recorded) and nothing is sent.
  if (generated.intent === "spam") {
    await prisma.aiReply.update({
      where: { sourceId: commentId },
      data: { status: "SKIPPED_SPAM" },
    });
    console.log(`[AI] comment ${commentId} looks like spam, not replying`);
    return;
  }

  try {
    const accessToken = decryptToken(account.accessToken);
    await sendCommentReply(accessToken, commentId, generated.reply);
    await prisma.aiReply.update({
      where: { sourceId: commentId },
      data: { status: "SENT", sentAt: new Date() },
    });
    console.log(
      `[AI] replied to comment ${commentId} (${generated.intent})`
    );
  } catch (error) {
    await prisma.aiReply.update({
      where: { sourceId: commentId },
      data: { status: "FAILED", errorMessage: formatError(error) },
    });
    console.error(
      `[AI] comment reply failed for ${commentId}:`,
      formatError(error)
    );
  }
}

async function processMessage(job: Job<ProcessMessageJob>): Promise<void> {
  const { instagramAccountId, messageId, messageText, senderId } = job.data;

  const automations = await prisma.automation.findMany({
    where: {
      dmTriggerEnabled: true,
      isActive: true,
      instagramAccount: { instagramId: instagramAccountId },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const dedupeId = `dm:${messageId}`;

  // Same rule as comments: a campaign that matched owns the message, and the
  // AI only sees what no campaign wanted. Set on the match, not on a
  // successful send, so a failed campaign DM doesn't get quietly papered over
  // by an AI reply saying something different.
  //
  // This ordering used to be reversed for DMs — the AI ran first and returned
  // before the loop, so on an AI-enabled account a keyword campaign could
  // never fire at all. That made the two halves impossible to run together,
  // which is exactly what a menu campaign with an AI fallback needs.
  let claimedByCampaign = false;

  for (const automation of automations) {
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          messageText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) continue;

    claimedByCampaign = true;

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });

    // Already replied to this message (or deliberately skipped it) — a retry
    // of the job must not send a second DM.
    if (
      existingLog?.status === "SENT" ||
      existingLog?.status === "SKIPPED_PLAN_LIMIT"
    ) {
      continue;
    }

    const logBase = {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      instagramAccountId: automation.instagramAccountId,
      commenterId: senderId,
      commentText: messageText,
      commentId: dedupeId,
      matchedKeyword: matchResult.matchedKeyword,
    };

    if (!automation.instagramAccount.accessToken) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decryptToken(automation.instagramAccount.accessToken);
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    // Reuse a name captured on an earlier interaction so {username} still
    // renders — the messages webhook carries only the sender's IGSID.
    const priorLog = await prisma.dmLog.findFirst({
      where: { automationId: automation.id, commenterId: senderId },
      select: { commenterName: true },
    });
    const commenterName = priorLog?.commenterName ?? null;

    // A campaign with steps opens its menu instead of the flat dmMessage. This
    // is the only thing that starts a branching flow: every tap after it
    // arrives as a `step:` postback, but the first message has to come from a
    // keyword match.
    const entryStep = await prisma.automationStep.findFirst({
      where: { automationId: automation.id, isEntry: true },
      select: { id: true },
    });

    if (entryStep) {
      // Follow-gating a menu is not supported yet, and the failure would be
      // quiet: the prompt's button carries `followcheck:<automationId>`, which
      // routes to the flat reveal rather than into the menu, so a gated
      // campaign would tap through to the wrong message entirely. Skip loudly
      // instead of delivering something the author did not configure.
      if (automation.requireFollow) {
        console.log(
          `[DM Worker] campaign ${automation.id} has steps and requireFollow; ` +
            `skipping — follow-gated menus are not supported`
        );
        continue;
      }

      // deliverStep reserves its own quota and writes its own DmLog row.
      await deliverStep({
        stepId: entryStep.id,
        instagramAccountId,
        userId: senderId,
      });

      // Recorded against the inbound message id as well, so a retry of this
      // job is caught by the existingLog check above and does not re-open the
      // menu on someone mid-conversation.
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
      });
      continue;
    }

    // Follow gate: anyone not confirmed as a follower gets the prompt instead of
    // the link, with the same `followcheck:` button that re-verifies on tap.
    // `null` (unverifiable) prompts too — this is first contact, exactly like a
    // comment, so it follows processComment's fail-closed rule rather than the
    // postback path's fail-open one. Fail-open is only safe after a tap, where
    // the user has already claimed to follow; here it would hand the link to
    // anyone whose status the API happens not to resolve.
    let sendFollowPrompt = false;
    if (automation.requireFollow) {
      const follows = await getUserFollowStatus(accessToken, senderId);
      sendFollowPrompt = follows !== true;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
        update: {
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    try {
      if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "Almost there! Follow me and tap the button below to grab your link 💛",
          commenterName,
        });
        await sendDirectMessageWithButton(
          accessToken,
          automation.instagramAccount.instagramId,
          senderId,
          promptText,
          automation.followPromptButtonLabel || "I'm following ✅",
          buildFollowCheckPayload(automation.id)
        );
      } else {
        await sendRevealDirectMessage(
          accessToken,
          automation,
          senderId,
          commenterName,
          "message trigger"
        );

        // The link has been delivered, so the appreciation follow-up applies
        // here exactly as it does after a button tap. Not scheduled behind the
        // follow prompt — no link went out yet in that branch.
        if (automation.followUpEnabled && automation.followUpMessage?.trim()) {
          await getDMQueue().add(
            FOLLOWUP_JOB_NAME,
            {
              instagramAccountId: automation.instagramAccount.instagramId,
              userId: senderId,
              automationId: automation.id,
              commenterName,
            },
            {
              delay: Math.max(0, automation.followUpDelayMinutes ?? 0) * 60_000,
              jobId: `followup_${automation.id}_${senderId}`,
            }
          );
        }
      }

      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
        update: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
        },
      });
      throw error;
    }
  }

  // Last, and only on what no campaign wanted — the mirror of the comment
  // path. This is what a menu campaign leans on: the buttons answer the
  // questions worth a button, and anything the tree has no branch for
  // ("do you have veg thali?", "parking?") reaches the AI instead of silence.
  if (!claimedByCampaign) {
    await tryAiReply(instagramAccountId, messageId, messageText, senderId);
  }
}

async function processJob(job: Job<DmQueueJob>): Promise<void> {
  if (job.name === POSTBACK_JOB_NAME) {
    return processPostback(job as Job<ProcessPostbackJob>);
  }
  if (job.name === FOLLOWUP_JOB_NAME) {
    return processFollowUp(job as Job<ProcessFollowUpJob>);
  }
  if (job.name === MESSAGE_JOB_NAME) {
    return processMessage(job as Job<ProcessMessageJob>);
  }
  return processComment(job as Job<ProcessCommentJob>);
}

async function recordWorkerFailure(
  job: Job<DmQueueJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
    const commentId =
      job && "commentId" in job.data ? job.data.commentId : null;
    const account = instagramAccountId
      ? await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId: instagramAccountId ?? null,
          commentId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId,
      commentId: commentId ?? undefined,
    });
  } catch (recordError) {
    console.error(
      "[DM Worker] Failed to record worker failure:",
      formatError(recordError)
    );
  }
}

export function createDMWorker(): Worker<DmQueueJob> {
  const worker = new Worker<DmQueueJob>(
    "dm-processing",
    processJob,
    {
      connection: getRedisConnection(),
      concurrency: DM_WORKER_CONCURRENCY,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          BACKOFF_DELAYS[Math.min(attemptsMade - 1, BACKOFF_DELAYS.length - 1)],
      },
    }
  );

  worker.on("completed", (job) => {
    console.log(`[DM Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[DM Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
    void recordWorkerFailure(job, err);
  });

  worker.on("error", (err) => {
    console.error("[DM Worker] Worker error:", err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `DM worker process error: ${err.message}`,
          payload: { name: err.name },
        },
      })
      .catch((recordError) => {
        console.error(
          "[DM Worker] Failed to record worker process error:",
          formatError(recordError)
        );
      });
  });

  return worker;
}

