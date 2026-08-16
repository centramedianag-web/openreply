-- CreateTable
CREATE TABLE "AiIntentAsset" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiIntentAsset_pkey" PRIMARY KEY ("id")
);

-- One asset per intent per account: two rows for "pricing" would make which
-- rate card a customer sees depend on row order.
CREATE UNIQUE INDEX "AiIntentAsset_instagramAccountId_intent_key" ON "AiIntentAsset"("instagramAccountId", "intent");

-- CreateIndex
CREATE INDEX "AiIntentAsset_stepId_idx" ON "AiIntentAsset"("stepId");

-- AddForeignKey
ALTER TABLE "AiIntentAsset" ADD CONSTRAINT "AiIntentAsset_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade: if the step is deleted the mapping points at nothing, and a mapping
-- that resolves to nothing would silently drop the reply instead of falling
-- back to the model's text.
ALTER TABLE "AiIntentAsset" ADD CONSTRAINT "AiIntentAsset_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AutomationStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
