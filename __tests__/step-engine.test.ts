import { describe, expect, it } from "vitest";
import { personalize, renderMessageWithoutLink } from "@/lib/tracking/message";
import {
  buildFollowCheckPayload,
  buildRevealPayload,
  buildStepPayload,
  parsePostback,
} from "@/lib/dm/postback";
import { SMART_REPLY_INTENTS } from "@/lib/ai/smart-reply";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

/**
 * The menu engine's pure parts: the payload that carries a tap back to a step,
 * and the name substitution applied to every step's text.
 *
 * Both fail silently in production if they break — a payload that stops
 * round-tripping turns every button into a no-op, and a merge tag that stops
 * matching sends a stranger the literal characters "{{first_name}}". Neither
 * raises an error, so both are pinned here.
 */

describe("postback payloads", () => {
  it("round-trips all three kinds", () => {
    const id = "clx8k2p9q0000abcd1234efgh";
    expect(parsePostback(buildStepPayload(id))).toEqual({
      kind: "step",
      stepId: id,
    });
    expect(parsePostback(buildRevealPayload(id))).toEqual({
      kind: "reveal",
      automationId: id,
    });
    expect(parsePostback(buildFollowCheckPayload(id))).toEqual({
      kind: "followcheck",
      automationId: id,
    });
  });

  /**
   * The three kinds share one channel and are told apart only by prefix. A
   * `reveal:` read as a step would look up an automation id in the step table,
   * find nothing, and drop the tap with no error anywhere.
   */
  it("never confuses one kind for another", () => {
    expect(parsePostback("reveal:abc")).not.toMatchObject({ kind: "step" });
    expect(parsePostback("followcheck:abc")).not.toMatchObject({
      kind: "reveal",
    });
  });

  it("returns null for an empty id or an unknown prefix", () => {
    expect(parsePostback("step:")).toBeNull();
    expect(parsePostback("step:   ")).toBeNull();
    expect(parsePostback("reveal:")).toBeNull();
    // Meta sends postbacks we never registered; doing nothing is correct.
    expect(parsePostback("GET_STARTED")).toBeNull();
    expect(parsePostback("")).toBeNull();
  });
});

/**
 * These strings live in two places that cannot check each other: the prompt
 * that asks the model to produce one, and AiIntentAsset.intent rows that decide
 * which prepared answer a question gets. Renaming one silently unhooks every
 * mapping using it — no error, the assistant just stops sending the rate card.
 *
 * If this test fails you renamed an intent. Update the prompt in
 * lib/ai/smart-reply.ts and any AiIntentAsset rows before changing it here.
 */
describe("smart reply intents", () => {
  it("matches the list the prompt and the asset mappings rely on", () => {
    expect([...SMART_REPLY_INTENTS]).toEqual([
      "greeting",
      "collab",
      "enquiry",
      "followup",
      "jobseeker",
      "spam",
      "pricing",
      "other",
    ]);
  });
});

describe("personalize", () => {
  it("substitutes the house token with the full name", () => {
    expect(personalize("Hey {username}, welcome", "Rahul Deshmukh")).toBe(
      "Hey Rahul Deshmukh, welcome"
    );
  });

  /**
   * ManyChat's token, supported because migrated copy is pasted in as written.
   * It takes the first word only — it says first_name, and an author who typed
   * it expects "Rahul", not "Rahul Deshmukh".
   */
  it("substitutes ManyChat's token with the first word only", () => {
    expect(personalize("Hey {{first_name}}, welcome", "Rahul Deshmukh")).toBe(
      "Hey Rahul, welcome"
    );
  });

  it("accepts the spacing ManyChat's editor sometimes emits", () => {
    expect(personalize("Hi {{ first_name }}", "Priya Nair")).toBe("Hi Priya");
  });

  /**
   * Instagram only gives us a display name on some events, so absent is the
   * common case, not the edge case. It has to read as ordinary English.
   */
  it("falls back to 'there' when no name was ever captured", () => {
    expect(personalize("Hey {username}!", null)).toBe("Hey there!");
    expect(personalize("Hey {{first_name}}!", undefined)).toBe("Hey there!");
    expect(personalize("Hey {username}!", "   ")).toBe("Hey there!");
  });

  it("still strips the link token in the existing renderer", () => {
    expect(
      renderMessageWithoutLink({
        message: "Hey {{first_name}}, here it is {link}",
        commenterName: "Sana Khan",
      })
    ).toBe("Hey Sana, here it is");
  });
});

/**
 * Not a test of our code so much as a record of why a migrated campaign must
 * NOT be configured the way the ManyChat flow it came from was.
 *
 * Chokar Dhani's ManyChat trigger matches on "contains" against a list that
 * includes "Hi". Substring matching plus a two-letter keyword fires on a large
 * share of ordinary English, so the greeting menu interrupts questions that
 * were never greetings. Our default is whole-word, which does not.
 */
describe("keyword matching: why not to mirror their 'contains' setting", () => {
  const CHOKAR_DHANI_KEYWORDS = [
    "Hello",
    "Hi",
    "Enquiry",
    "Information",
    "Wedding",
    "Village",
    "Price",
    "Tickets",
    "Inquire",
    "Hey",
  ];

  it("substring matching fires the greeting menu on messages that are not greetings", () => {
    for (const message of [
      "Is this available on Sunday?",
      "Something for 40 people",
      "White lawn decoration possible?",
    ]) {
      expect(
        matchKeywords(message, CHOKAR_DHANI_KEYWORDS, false).matched
      ).toBe(true);
    }
  });

  it("whole-word matching does not", () => {
    for (const message of [
      "Is this available on Sunday?",
      "Something for 40 people",
      "White lawn decoration possible?",
    ]) {
      expect(matchKeywords(message, CHOKAR_DHANI_KEYWORDS, true).matched).toBe(
        false
      );
    }
  });

  it("still matches a real greeting", () => {
    expect(matchKeywords("Hi, is it open today?", CHOKAR_DHANI_KEYWORDS, true).matched).toBe(true);
  });

  /**
   * The other half of the problem, and the one no keyword setting fixes: the
   * list has no entry for how people here actually ask a price. Every one of
   * these reaches the AI fallback or nothing at all — which is the entire
   * argument for having a fallback.
   */
  it("misses the ways people actually ask, in any configuration", () => {
    for (const message of [
      "kitna hai?",
      "how much for 2 people",
      "charges kya hai",
      "किंमत काय आहे",
      "entry fee kitna",
      "what's the rate",
    ]) {
      expect(matchKeywords(message, CHOKAR_DHANI_KEYWORDS, true).matched).toBe(
        false
      );
      expect(matchKeywords(message, CHOKAR_DHANI_KEYWORDS, false).matched).toBe(
        false
      );
    }
  });
});
