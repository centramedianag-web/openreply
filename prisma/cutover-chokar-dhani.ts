/**
 * Chokar Dhani cutover: ManyChat off -> ours live.
 *
 * The keyword list is deliberately SHORTER than ManyChat's. Theirs included
 * "price" and "tickets", so "mujhe tickets ke price hona" matched a keyword and
 * got the top-level menu instead of an answer. Keywords now catch only openers;
 * anything with a real question in it falls through to the assistant, which
 * reads it and answers — and for a price question that means the rate card,
 * which carries its own button back into the menu.
 *
 *   npx tsx --env-file=.env prisma/cutover-chokar-dhani.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const p = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

// Openers only. No topic words: "wedding" alone should open the branch, but
// "do you do weddings for 120 people in feb" must reach a person, and a keyword
// cannot tell those apart. The assistant can.
const OPENERS = ["hi", "hii", "hey", "hello", "helo", "namaste", "menu", "start"];

(async () => {
  const acct = await p.instagramAccount.findFirst({
    where: { username: "chokardhaninagpur" },
    select: { id: true },
  });
  if (!acct) throw new Error("account not found");

  const auto = await p.automation.findFirst({
    where: { name: "Chokar Dhani Nagpur — DM menu" },
    include: { steps: { select: { id: true, name: true, isEntry: true } } },
  });
  if (!auto) throw new Error("campaign not seeded");

  const welcome = auto.steps.find((s) => s.isEntry)!;
  const tickets = auto.steps.find((s) => s.name === "Tickets")!;

  await p.automation.update({
    where: { id: auto.id },
    data: { keywords: OPENERS, isActive: true },
  });

  // A greeting in a language the list misses ("ram ram sa", "kasa kay") is still
  // a greeting. The model recognises it and gets the same menu, so the keyword
  // list stops being the thing that decides whether anyone is answered.
  for (const [intent, stepId] of [
    ["greeting", welcome.id],
    ["pricing", tickets.id],
  ] as const) {
    await p.aiIntentAsset.upsert({
      where: { instagramAccountId_intent: { instagramAccountId: acct.id, intent } },
      create: { instagramAccountId: acct.id, intent, stepId },
      update: { stepId },
    });
  }

  await p.instagramAccount.update({
    where: { id: acct.id },
    data: { aiEnabled: true },   // comments stay off — that is a separate call
  });

  console.log("cutover applied:");
  console.log("  keywords:", OPENERS.join(", "));
  console.log("  greeting ->", welcome.name, "| pricing ->", tickets.name);
  console.log("  aiEnabled: true, aiCommentsEnabled: unchanged (off)");
  await p.$disconnect();
})();
