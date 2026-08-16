/**
 * Postback payloads — the strings Meta echoes back when someone taps a button.
 *
 * Three kinds share one channel, and until now only one of them had a parser:
 * `reveal:` and `followcheck:` were matched with inline startsWith/slice at the
 * call site, so the prefixes existed in two places with nothing tying them
 * together. Renaming one half would not fail to compile — every tap would just
 * stop resolving, silently, with no error anywhere.
 *
 * Everything that builds or reads a payload goes through here, so the prefixes
 * exist exactly once.
 */

const REVEAL = "reveal:";
const FOLLOW_CHECK = "followcheck:";
const STEP = "step:";

export type PostbackTarget =
  | { kind: "reveal"; automationId: string }
  | { kind: "followcheck"; automationId: string }
  | { kind: "step"; stepId: string };

export function buildRevealPayload(automationId: string): string {
  return `${REVEAL}${automationId}`;
}

export function buildFollowCheckPayload(automationId: string): string {
  return `${FOLLOW_CHECK}${automationId}`;
}

export function buildStepPayload(stepId: string): string {
  return `${STEP}${stepId}`;
}

/**
 * Returns null for anything unrecognised — an empty id, an unknown prefix, or
 * a payload from a Meta feature we do not handle (`GET_STARTED`, say). Callers
 * must treat null as "not ours" and do nothing, rather than guessing.
 *
 * `step:` is checked first only for clarity; the prefixes are disjoint.
 */
export function parsePostback(payload: string): PostbackTarget | null {
  if (payload.startsWith(STEP)) {
    const stepId = payload.slice(STEP.length).trim();
    return stepId ? { kind: "step", stepId } : null;
  }

  if (payload.startsWith(FOLLOW_CHECK)) {
    const automationId = payload.slice(FOLLOW_CHECK.length).trim();
    return automationId ? { kind: "followcheck", automationId } : null;
  }

  if (payload.startsWith(REVEAL)) {
    const automationId = payload.slice(REVEAL.length).trim();
    return automationId ? { kind: "reveal", automationId } : null;
  }

  return null;
}
