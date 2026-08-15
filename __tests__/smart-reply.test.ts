/**
 * Smart Reply parser — Unit Tests
 *
 * The parser sits between Gemini and a client's Instagram inbox. Its job is to
 * refuse anything it is not certain about, because the fallback (a campaign
 * message, or silence) is always safer than a malformed DM sent in the client's
 * name. These tests pin that bias down.
 */

import { describe, it, expect } from "vitest";
import { parseSmartReply } from "../lib/ai/smart-reply";

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
