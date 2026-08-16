-- Figures a client publishes and keeps current, which the assistant may state.
-- Null (the default) keeps the blanket no-figures rule, so every existing
-- account behaves exactly as before.
ALTER TABLE "InstagramAccount" ADD COLUMN "aiPublishedFigures" TEXT;
