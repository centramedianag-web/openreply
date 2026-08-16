-- CreateTable
CREATE TABLE "AutomationStep" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "name" TEXT,
    "text" TEXT NOT NULL,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "delaySeconds" INTEGER NOT NULL DEFAULT 0,
    "isEntry" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationStepButton" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "targetStepId" TEXT,
    "url" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AutomationStepButton_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationStep_automationId_idx" ON "AutomationStep"("automationId");

-- A campaign has exactly one entry step, or none at all (in which case it runs
-- the flat dmMessage path). A partial unique index says that in one line and
-- makes the database refuse a second entry, which application code checking
-- "is there already one?" cannot do safely under concurrent writes.
CREATE UNIQUE INDEX "AutomationStep_one_entry_per_automation"
    ON "AutomationStep"("automationId") WHERE "isEntry";

-- CreateIndex
CREATE INDEX "AutomationStepButton_stepId_idx" ON "AutomationStepButton"("stepId");

-- CreateIndex
CREATE INDEX "AutomationStepButton_targetStepId_idx" ON "AutomationStepButton"("targetStepId");

-- A button navigates OR opens a link, never both and never neither. Without
-- this a half-saved button renders as a dead control that silently does
-- nothing when tapped, which is indistinguishable from a delivery failure.
ALTER TABLE "AutomationStepButton" ADD CONSTRAINT "AutomationStepButton_exactly_one_action"
    CHECK (("targetStepId" IS NULL) <> ("url" IS NULL));

-- AddForeignKey
ALTER TABLE "AutomationStep" ADD CONSTRAINT "AutomationStep_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationStepButton" ADD CONSTRAINT "AutomationStepButton_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AutomationStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade, not SET NULL: a button whose target is gone would violate the
-- exactly-one-action constraint above, so the button has to go with it.
ALTER TABLE "AutomationStepButton" ADD CONSTRAINT "AutomationStepButton_targetStepId_fkey" FOREIGN KEY ("targetStepId") REFERENCES "AutomationStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
