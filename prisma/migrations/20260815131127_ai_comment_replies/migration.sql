-- AlterTable
ALTER TABLE "AiReply" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'DM';

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "aiCommentsEnabled" BOOLEAN NOT NULL DEFAULT false;
