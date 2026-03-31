ALTER TABLE "broadcast_localizations"
ADD COLUMN IF NOT EXISTS "buttons_json" JSONB;
