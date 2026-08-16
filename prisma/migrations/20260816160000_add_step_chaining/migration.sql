-- AlterTable
ALTER TABLE "AutomationStep" ADD COLUMN "nextStepId" TEXT;

-- CreateIndex
CREATE INDEX "AutomationStep_nextStepId_idx" ON "AutomationStep"("nextStepId");

-- A step cannot follow itself. The worker also stops after a fixed number of
-- hops, but a one-step loop is the easy mistake to make in a builder and it
-- costs nothing to make it impossible.
ALTER TABLE "AutomationStep" ADD CONSTRAINT "AutomationStep_next_is_not_self"
    CHECK ("nextStepId" IS NULL OR "nextStepId" <> "id");

-- SetNull, not Cascade: deleting the follow-up should end the sequence, not
-- delete the message that preceded it.
ALTER TABLE "AutomationStep" ADD CONSTRAINT "AutomationStep_nextStepId_fkey" FOREIGN KEY ("nextStepId") REFERENCES "AutomationStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
