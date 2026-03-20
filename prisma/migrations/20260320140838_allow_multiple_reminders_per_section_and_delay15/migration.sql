-- DropIndex
DROP INDEX "inactivity_reminder_rules_trigger_page_id_key";

-- CreateIndex
CREATE INDEX "inactivity_reminder_rules_trigger_page_id_idx" ON "inactivity_reminder_rules"("trigger_page_id");
