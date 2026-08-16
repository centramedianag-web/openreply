/**
 * Smart Reply parser — Unit Tests
 *
 * The parser sits between Gemini and a client's Instagram inbox. Its job is to
 * refuse anything it is not certain about, because the fallback (a campaign
 * message, or silence) is always safer than a malformed DM sent in the client's
 * name. These tests pin that bias down.
 */

import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  parseSmartReply,
  SMART_REPLY_INTENTS,
} from "../lib/ai/smart-reply";

describe("buildSystemPrompt", () => {
  const brain = "Mauli Infra builds homes in Nagpur. Sales: +91 90000 00000.";

  it("embeds the brain in both modes", () => {
    expect(buildSystemPrompt(brain, "dm")).toContain("Mauli Infra builds homes");
    expect(buildSystemPrompt(brain, "comment")).toContain(
      "Mauli Infra builds homes"
    );
  });

  // The rule that stops a wrong number going out under the client's name. It
  // has to survive in every channel, not just the one it was written for.
  it.each(["dm", "comment"] as const)(
    "keeps the never-state-a-figure rule in %s mode",
    (mode) => {
      const prompt = buildSystemPrompt(brain, mode);
      expect(prompt).toContain("NEVER state a price");
      expect(prompt).toContain("Never invent a figure");
      expect(prompt).toContain("even if the fact appears");
    }
  );

  it("tells comment mode it is public and DM mode it is private", () => {
    expect(buildSystemPrompt(brain, "comment")).toContain("PUBLIC reply");
    expect(buildSystemPrompt(brain, "dm")).toContain("private");
    expect(buildSystemPrompt(brain, "dm")).not.toContain("PUBLIC reply");
  });

  it("asks for a far shorter reply in comment mode", () => {
    expect(buildSystemPrompt(brain, "comment")).toContain("under 12 words");
    expect(buildSystemPrompt(brain, "dm")).toContain("under 40 words");
  });

  // Asking someone to post a phone number under a public post exposes them to
  // every other reader of that post.
  it("forbids asking for personal details publicly, in comment mode only", () => {
    const comment = buildSystemPrompt(brain, "comment");
    expect(comment).toContain("NEVER ask anyone to post a phone number");
    expect(comment).toContain("invite them to send");
    expect(buildSystemPrompt(brain, "dm")).not.toContain(
      "NEVER ask anyone to post a phone number"
    );
  });

  it("defaults to dm mode", () => {
    // generateSmartReply's default parameter must not silently become the
    // public-facing prompt.
    expect(buildSystemPrompt(brain, "dm")).not.toContain("PUBLIC");
  });

  /**
   * The published-figures carve-out. A client with a printed rate card gains
   * nothing from an assistant that refuses to read it out — but the carve-out
   * must be exactly that, a carve-out, not a way to switch the liability rules
   * off. These assert both halves.
   */
  describe("published figures", () => {
    const FIGURES = "Village entry: Adult ₹850, Child (2.5-4ft) ₹450, under 2.5ft free.";

    it("keeps the blanket rule when no figures are published", () => {
      for (const mode of ["dm", "comment"] as const) {
        const prompt = buildSystemPrompt(brain, mode);
        expect(prompt).not.toContain("PUBLISHED FIGURES");
        expect(prompt).not.toContain("EXCEPTION");
        expect(prompt).toContain("NEVER state a price");
      }
    });

    it("treats null and blank as no figures", () => {
      for (const value of [null, undefined, "", "   "]) {
        expect(buildSystemPrompt(brain, "dm", value)).not.toContain("EXCEPTION");
      }
    });

    it("includes the figures and the carve-out when published", () => {
      const prompt = buildSystemPrompt(brain, "dm", FIGURES);
      expect(prompt).toContain("PUBLISHED FIGURES");
      expect(prompt).toContain("Adult ₹850");
      expect(prompt).toContain("EXCEPTION");
    });

    /**
     * The rule that matters. Naming quotable figures must not disarm the
     * restriction on everything else — a resort's entry fee is fixed and
     * printed; its room tariffs move by season and its wedding packages are
     * negotiated per event.
     */
    it("still forbids every figure that was not published", () => {
      const prompt = buildSystemPrompt(brain, "dm", FIGURES);
      expect(prompt).toContain("NEVER state a price");
      expect(prompt).toContain("Never invent a figure and never");
      expect(prompt).toContain("never round, convert, estimate");
    });

    it("applies in comment mode too", () => {
      // A published rate is on the client's own printed card either way.
      const prompt = buildSystemPrompt(brain, "comment", FIGURES);
      expect(prompt).toContain("PUBLISHED FIGURES");
      expect(prompt).toContain("NEVER ask anyone to post a phone number");
    });
  });
});

describe("parseSmartReply intent coverage", () => {
  /**
   * Every intent the prompt can ask for must survive parsing. This existed as a
   * second hardcoded list once, and when "pricing" was added everywhere except
   * there, the parser rewrote it to "other" — so the rate card silently stopped
   * being attached and nothing errored. One list, asserted whole.
   */
  it("round-trips every declared intent", () => {
    for (const intent of SMART_REPLY_INTENTS) {
      const parsed = parseSmartReply(
        JSON.stringify({ intent, handoff: false, reply: "ok" })
      );
      expect(parsed?.intent, `intent "${intent}" was not preserved`).toBe(intent);
    }
  });

  it("still falls back to other for an unknown intent", () => {
    const parsed = parseSmartReply(
      JSON.stringify({ intent: "not_a_real_intent", handoff: false, reply: "ok" })
    );
    expect(parsed?.intent).toBe("other");
  });
});

describe("parseSmartReply", () => {
  it("parses a well-formed reply", () => {
    const result = parseSmartReply(
      '{"intent":"enquiry","handoff":true,"reply":"Please share your number."}'
    );
    expect(result).toEqual({
      intent: "enquiry",
      handoff: true,
      reply: "Please share your number.",
    });
  });

  it("keeps handoff false when the model explicitly says so", () => {
    const result = parseSmartReply(
      '{"intent":"greeting","handoff":false,"reply":"Hey! How can we help?"}'
    );
    expect(result?.handoff).toBe(false);
  });

  it("preserves Devanagari replies unchanged", () => {
    const reply = "आम्ही नागपूरमध्ये आहोत. कृपया तुमचा नंबर शेअर करा.";
    const result = parseSmartReply(
      JSON.stringify({ intent: "enquiry", handoff: true, reply })
    );
    expect(result?.reply).toBe(reply);
  });

  it("trims surrounding whitespace from the reply", () => {
    const result = parseSmartReply(
      '{"intent":"other","handoff":true,"reply":"  spaced out  "}'
    );
    expect(result?.reply).toBe("spaced out");
  });

  // --- Everything below must fail towards a human, or towards no send at all ---

  it("returns null for empty input", () => {
    expect(parseSmartReply("")).toBeNull();
    expect(parseSmartReply("   ")).toBeNull();
  });

  it("returns null when the model answers with prose instead of JSON", () => {
    expect(parseSmartReply("Sure! Here's a good reply for you.")).toBeNull();
  });

  it("returns null on truncated JSON", () => {
    expect(
      parseSmartReply('{"intent":"enquiry","handoff":true,"reply":"Please sh')
    ).toBeNull();
  });

  it("returns null when reply is missing, empty, or not a string", () => {
    expect(parseSmartReply('{"intent":"greeting","handoff":false}')).toBeNull();
    expect(
      parseSmartReply('{"intent":"greeting","handoff":false,"reply":"   "}')
    ).toBeNull();
    expect(
      parseSmartReply('{"intent":"greeting","handoff":false,"reply":42}')
    ).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    expect(parseSmartReply('"just a string"')).toBeNull();
    expect(parseSmartReply("null")).toBeNull();
    expect(parseSmartReply("[1,2,3]")).toBeNull();
  });

  it("defaults an unrecognised intent to other rather than rejecting the reply", () => {
    const result = parseSmartReply(
      '{"intent":"purchase_order","handoff":true,"reply":"Noted."}'
    );
    expect(result?.intent).toBe("other");
    expect(result?.reply).toBe("Noted.");
  });

  it("treats a missing handoff as a handoff", () => {
    expect(parseSmartReply('{"intent":"enquiry","reply":"Noted."}')?.handoff).toBe(
      true
    );
  });

  it("treats a non-boolean handoff as a handoff", () => {
    // "false" the string, 0, and null are all things a model might emit under
    // pressure. None of them are an explicit false, so none of them may quietly
    // route a commercial question away from a person.
    for (const value of ['"false"', "0", "null", '"no"']) {
      const raw = `{"intent":"enquiry","handoff":${value},"reply":"Noted."}`;
      expect(parseSmartReply(raw)?.handoff).toBe(true);
    }
  });
});
