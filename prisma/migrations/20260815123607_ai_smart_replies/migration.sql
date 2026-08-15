-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "aiBrain" TEXT,
ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "inboundText" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "handoff" BOOLEAN NOT NULL DEFAULT false,
    "replyText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiReply_messageId_key" ON "AiReply"("messageId");

-- CreateIndex
CREATE INDEX "AiReply_workspaceId_idx" ON "AiReply"("workspaceId");

-- CreateIndex
CREATE INDEX "AiReply_instagramAccountId_createdAt_idx" ON "AiReply"("instagramAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "AiReply_handoff_idx" ON "AiReply"("handoff");

-- AddForeignKey
ALTER TABLE "AiReply" ADD CONSTRAINT "AiReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReply" ADD CONSTRAINT "AiReply_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
