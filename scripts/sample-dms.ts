/**
 * DM sampler — read-only.
 *
 * Pulls every conversation for a connected Instagram account and dumps the
 * inbound messages as JSON + a flat text file, so real phrasings can be read
 * in bulk instead of clicked through one thread at a time. Used to design
 * keyword lists from what people actually send rather than from guesses.
 *
 *   npx tsx --env-file=.env scripts/sample-dms.ts mauli.ngpofficial
 *
 * Sends nothing and writes nothing back to Instagram. Meta only returns full
 * content for the 20 most recent messages per conversation.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import {
  getConversations,
  getConversationMessages,
} from "../lib/meta/client";
import { decryptToken } from "../lib/meta/oauth";
import { writeFileSync, mkdirSync } from "node:fs";

const username = process.argv[2];
if (!username) {
  console.error("usage: tsx scripts/sample-dms.ts <instagram-username>");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(process.env.DATABASE_URL as string),
});

async function main() {
  const account = await prisma.instagramAccount.findFirst({
    where: { username },
  });

  if (!account?.accessToken) {
    console.error(`No connected account "${username}" with a token.`);
    process.exit(1);
  }

  const token = decryptToken(account.accessToken);
  const conversations = await getConversations(token, account.instagramId);
  console.log(`${conversations.length} conversations for @${username}\n`);

  const threads: {
    participants: string[];
    inbound: { from: string; text: string; at: string }[];
  }[] = [];

  for (const conversation of conversations) {
    const participants = (conversation.participants?.data ?? []).map(
      (p) => p.username ?? p.id
    );

    let messages;
    try {
      messages = await getConversationMessages(token, conversation.id);
    } catch (error) {
      console.error(`  skipped ${conversation.id}:`, (error as Error).message);
      continue;
    }

    // Only what THEY sent. Our own replies are already known and would
    // otherwise dominate the sample.
    const inbound = messages
      .filter((m) => m.message && m.from?.username !== username)
      .map((m) => ({
        from: m.from?.username ?? m.from?.id ?? "unknown",
        text: (m.message ?? "").replace(/\s+/g, " ").trim(),
        at: m.created_time ?? "",
      }))
      .filter((m) => m.text.length > 0);

    if (inbound.length > 0) threads.push({ participants, inbound });
  }

  mkdirSync("output", { recursive: true });

  writeFileSync(
    "output/dm-sample.json",
    JSON.stringify(threads, null, 2),
    "utf8"
  );

  // Flat list, longest first — the long messages are the collab pitches and
  // the short ones are the real enquiries, and that contrast is the point.
  const flat = threads
    .flatMap((t) => t.inbound.map((m) => `[@${m.from}] ${m.text}`))
    .sort((a, b) => b.length - a.length);

  writeFileSync("output/dm-sample.txt", flat.join("\n\n"), "utf8");

  console.log(`threads with inbound text: ${threads.length}`);
  console.log(`inbound messages: ${flat.length}`);
  console.log("wrote output/dm-sample.json and output/dm-sample.txt");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
