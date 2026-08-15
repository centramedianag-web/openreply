/**
 * AI smart replies.
 *
 * Reads an inbound Instagram DM and writes the reply, in whatever language the
 * sender used. Keyword campaigns cannot do this: a Nagpur buyer writes "kitna",
 * "किंमत" or "Hi" for the same intent, and a collab pitch opens with the same
 * "Hello Team!" a real enquiry does.
 *
 * The model never states a price, a size, an availability, a date or anything
 * legal, even when those facts sit in the brain. That is a liability rule, not
 * a style preference: a wrong figure sent in writing from the client's own
 * account is worse than a slower human answer. Those messages come back with
 * handoff set, and the caller decides what to send.
 *
 * Every failure path returns null rather than throwing. The worker falls back
 * to the campaign's own message, so a Gemini outage degrades to the behaviour
 * that existed before this file.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 20_000;

export type SmartReplyIntent =
  | "greeting"
  | "collab"
  | "enquiry"
  | "followup"
  | "jobseeker"
  | "spam"
  | "other";

export interface SmartReply {
  intent: SmartReplyIntent;
  handoff: boolean;
  reply: string;
}

/**
 * Which channel the reply is for.
 *
 * "dm" is a private one-to-one conversation: it can be a few sentences and can
 * ask for a phone number. "comment" is published under the post for the whole
 * audience, so it must be short and must never ask anyone to post personal
 * details in public.
 */
export type SmartReplyMode = "dm" | "comment";

export function isAiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Exported for testing. The liability rules have to hold in BOTH modes, and the
 * only cheap way to stop a future edit quietly dropping them from one of them
 * is to assert on the assembled prompt.
 */
export function buildSystemPrompt(brain: string, mode: SmartReplyMode): string {
  const channelRules =
    mode === "comment"
      ? [
          "You are writing a PUBLIC reply under an Instagram post. Everyone who",
          "sees the post sees your reply, including the person's own followers.",
          "",
          "Reply in the same language the commenter used, including Hinglish and",
          "romanised Marathi. Keep it under 12 words — a comment reply is a nod,",
          "not a pitch. At most one emoji.",
          "",
          "NEVER ask anyone to post a phone number, email or address in a public",
          "comment. If they want something that needs those, invite them to send",
          "a DM instead.",
          "Do not paste the same sentence you would send in a DM; this is a",
          "public acknowledgement, so it should read like a person replying.",
        ]
      : [
          "You are replying to an Instagram direct message. The conversation is",
          "private, between you and one person.",
          "",
          "Reply in the same language the person wrote in, including Hinglish and",
          "romanised Marathi. Keep replies under 40 words. Warm and plain. At most",
          "one emoji, and none at all in a reply that declines something.",
        ];

  return [
    "You are replying on Instagram as the business described below.",
    "You are the business itself, not an assistant, and never mention being an AI.",
    "",
    "=== WHAT YOU KNOW ===",
    brain.trim(),
    "=== END ===",
    "",
    ...channelRules,
    "",
    "Return ONLY JSON, shaped exactly like this:",
    '{"intent":"greeting|collab|enquiry|followup|jobseeker|spam|other","handoff":true|false,"reply":"..."}',
    "",
    "NEVER state a price, a rate, a plot or unit size, a payment plan, a discount,",
    "an availability, a possession or completion date, a registration or licence",
    "number, or anything legal or contractual. This holds even if the fact appears",
    "above. If someone asks for any of it, set handoff true and write a reply that",
    "points them to the contact given in the brain. Never invent a figure and never",
    "estimate one.",
    "",
    "Set handoff true whenever you are unsure, and whenever the person needs a",
    "commitment only a person can give.",
    "",
    "Do not offer anything the brain does not mention: no callbacks you cannot",
    "promise, no email address for a purpose it was not given for, no meeting times.",
    "If someone asks about a job and the brain gives no careers contact, tell them",
    "roles are not handled through direct messages and give no address at all.",
    "",
    "Decline collaboration and promotion pitches politely, in one sentence, without",
    "asking for their details and without promising to keep them on file.",
  ].join("\n");
}

/**
 * Ask Gemini for a reply. Returns null when AI is unavailable, times out, or
 * answers with something that is not usable, so callers can fall back.
 */
export async function generateSmartReply(
  brain: string,
  message: string,
  mode: SmartReplyMode = "dm"
): Promise<SmartReply | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !brain.trim() || !message.trim()) return null;

  const model = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      `${ENDPOINT}/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(brain, mode) }] },
          contents: [{ role: "user", parts: [{ text: message.slice(0, 4000) }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 8000,
            responseMimeType: "application/json",
            // Thinking tokens are billed as output and dominate the bill:
            // measured at 266/reply on the default setting versus 41 tokens of
            // actual reply. "low" halves them to ~105 and costs nothing in
            // quality — across 27 runs per setting (9 message types x 3), both
            // produced 0 malformed replies and, over 15 price questions each,
            // 0 invented figures. Retest before raising it.
            //
            // Do NOT swap this for `thinkingBudget: 0`. That is the Gemini 2.5
            // parameter; on 3.x it is silently ignored and still burns ~142.
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error(
        `[AI] Gemini returned ${response.status}: ${detail.slice(0, 300)}`
      );
      return null;
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const raw =
      payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("") ?? "";

    return parseSmartReply(raw);
  } catch (error) {
    const reason = (error as Error).name === "AbortError" ? "timed out" : "failed";
    console.error(`[AI] Gemini call ${reason}:`, (error as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exported for testing. A reply with no text is treated as unusable, because
 * sending an empty DM is worse than sending the campaign's fallback.
 */
export function parseSmartReply(raw: string): SmartReply | null {
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  const reply = typeof candidate.reply === "string" ? candidate.reply.trim() : "";
  if (!reply) return null;

  const intents: SmartReplyIntent[] = [
    "greeting",
    "collab",
    "enquiry",
    "followup",
    "jobseeker",
    "spam",
    "other",
  ];
  const intent = intents.includes(candidate.intent as SmartReplyIntent)
    ? (candidate.intent as SmartReplyIntent)
    : "other";

  return {
    intent,
    // Anything other than an explicit false is treated as a handoff, so a
    // malformed value fails towards a human rather than away from one.
    handoff: candidate.handoff !== false,
    reply,
  };
}
