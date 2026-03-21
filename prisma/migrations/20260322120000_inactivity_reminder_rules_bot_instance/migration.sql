-- Add bot_instance_id to inactivity_reminder_rules for proper multi-bot scoping.
-- Rules are now scoped per bot instance; they persist across deploys within the same bot.
ALTER TABLE "inactivity_reminder_rules" ADD COLUMN IF NOT EXISTS "bot_instance_id" TEXT;

-- Backfill: set bot_instance_id from target menu item's template, or first active bot for "root".
UPDATE "inactivity_reminder_rules" ir
SET "bot_instance_id" = COALESCE(
  (
    SELECT pt."bot_instance_id"
    FROM "menu_items" mi
    JOIN "presentation_templates" pt ON pt."id" = mi."template_id"
    WHERE mi."id" = ir."target_menu_item_id"
    LIMIT 1
  ),
  (SELECT id FROM "bot_instances" WHERE "status" = 'ACTIVE' AND "is_archived" = false ORDER BY "created_at" ASC LIMIT 1)
)
WHERE ir."bot_instance_id" IS NULL;

-- Add FK constraint
ALTER TABLE "inactivity_reminder_rules"
  ADD CONSTRAINT "inactivity_reminder_rules_bot_instance_id_fkey"
  FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Index for efficient lookups by bot + page
CREATE INDEX IF NOT EXISTS "inactivity_reminder_rules_bot_trigger_idx"
  ON "inactivity_reminder_rules"("bot_instance_id", "trigger_page_id");
