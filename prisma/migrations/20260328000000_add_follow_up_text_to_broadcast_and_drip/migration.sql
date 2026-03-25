ALTER TABLE "broadcast_localizations"
ADD COLUMN "follow_up_text" TEXT NOT NULL DEFAULT '';

ALTER TABLE "drip_step_localizations"
ADD COLUMN "follow_up_text" TEXT NOT NULL DEFAULT '';
