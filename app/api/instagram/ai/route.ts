import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { isAiConfigured } from "@/lib/ai/smart-reply";

export const runtime = "nodejs";

// A brain is a briefing, not a document. Past a few thousand characters it stops
// improving replies and starts costing real money on every single inbound DM,
// since the whole thing is re-sent as the system prompt each time.
const MAX_BRAIN_LENGTH = 6000;

/**
 * Per-account AI reply settings.
 *
 * The brain lives on the Instagram account, not the workspace, so an agency
 * running several clients from one install keeps one brain per client and can
 * never leak one client's facts into another's replies.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      username: true,
      aiEnabled: true,
      aiCommentsEnabled: true,
      aiBrain: true,
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      // Surfaced so the UI can explain why the toggle does nothing, rather than
      // letting someone switch it on and wait for replies that never come.
      aiConfigured: isAiConfigured(),
      accounts,
    },
  });
}

export async function PATCH(request: Request) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = (await request.json()) as {
    instagramAccountId?: string;
    aiEnabled?: boolean;
    aiCommentsEnabled?: boolean;
    aiBrain?: string;
  };

  if (!body.instagramAccountId) {
    return NextResponse.json(
      { success: false, error: "instagramAccountId is required" },
      { status: 400 }
    );
  }

  // Scoped by workspaceId as well as id, so an account id from another
  // workspace cannot be edited by guessing it.
  const account = await prisma.instagramAccount.findFirst({
    where: { id: body.instagramAccountId, workspaceId },
    select: { id: true, aiBrain: true },
  });

  if (!account) {
    return NextResponse.json(
      { success: false, error: "Account not found" },
      { status: 404 }
    );
  }

  const nextBrain =
    body.aiBrain === undefined ? account.aiBrain : body.aiBrain.trim();

  if (nextBrain && nextBrain.length > MAX_BRAIN_LENGTH) {
    return NextResponse.json(
      {
        success: false,
        error: `Brain is ${nextBrain.length} characters; keep it under ${MAX_BRAIN_LENGTH}.`,
      },
      { status: 400 }
    );
  }

  // Turning AI on without a brain would send the model into a client's inbox
  // with nothing to go on, and it would invent a business. Refuse instead.
  if ((body.aiEnabled === true || body.aiCommentsEnabled === true) && !nextBrain) {
    return NextResponse.json(
      { success: false, error: "Write a brain before turning replies on." },
      { status: 400 }
    );
  }

  const updated = await prisma.instagramAccount.update({
    where: { id: account.id },
    data: {
      ...(body.aiBrain === undefined ? {} : { aiBrain: nextBrain || null }),
      ...(body.aiEnabled === undefined ? {} : { aiEnabled: body.aiEnabled }),
      ...(body.aiCommentsEnabled === undefined
        ? {}
        : { aiCommentsEnabled: body.aiCommentsEnabled }),
    },
    select: {
      id: true,
      username: true,
      aiEnabled: true,
      aiCommentsEnabled: true,
      aiBrain: true,
    },
  });

  return NextResponse.json({ success: true, data: { account: updated } });
}
