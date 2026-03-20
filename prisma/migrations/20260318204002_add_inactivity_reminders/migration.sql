-- CreateEnum
CREATE TYPE "InactivityReminderTemplateCategory" AS ENUM ('SOFT', 'MOTIVATING', 'BUSINESS', 'LIGHT_HUMOR', 'HOOKING');

-- CreateEnum
CREATE TYPE "InactivityReminderCtaTargetType" AS ENUM ('ROOT', 'NEXT_PAGE');

-- CreateEnum
CREATE TYPE "InactivityReminderStateStatus" AS ENUM ('PENDING', 'CANCELLED', 'SENT', 'EXPIRED');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'SEND_INACTIVITY_REMINDER';

-- CreateTable
CREATE TABLE "reminder_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" "InactivityReminderTemplateCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "default_cta_label" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "language_code" TEXT NOT NULL DEFAULT 'ru',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inactivity_reminder_rules" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "trigger_page_id" TEXT NOT NULL,
    "target_menu_item_id" TEXT NOT NULL,
    "delay_minutes" INTEGER NOT NULL,
    "cta_label" TEXT NOT NULL,
    "cta_target_type" "InactivityReminderCtaTargetType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inactivity_reminder_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_inactivity_reminder_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "trigger_page_id" TEXT NOT NULL,
    "target_menu_item_id" TEXT NOT NULL,
    "status" "InactivityReminderStateStatus" NOT NULL DEFAULT 'PENDING',
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "scheduler_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_inactivity_reminder_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_templates_key_key" ON "reminder_templates"("key");

-- CreateIndex
CREATE INDEX "reminder_templates_is_active_language_code_category_sort_or_idx" ON "reminder_templates"("is_active", "language_code", "category", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "inactivity_reminder_rules_trigger_page_id_key" ON "inactivity_reminder_rules"("trigger_page_id");

-- CreateIndex
CREATE INDEX "inactivity_reminder_rules_is_active_idx" ON "inactivity_reminder_rules"("is_active");

-- CreateIndex
CREATE INDEX "user_inactivity_reminder_states_status_scheduled_for_idx" ON "user_inactivity_reminder_states"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "user_inactivity_reminder_states_user_id_rule_id_key" ON "user_inactivity_reminder_states"("user_id", "rule_id");

-- AddForeignKey
ALTER TABLE "inactivity_reminder_rules" ADD CONSTRAINT "inactivity_reminder_rules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "reminder_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_inactivity_reminder_states" ADD CONSTRAINT "user_inactivity_reminder_states_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "inactivity_reminder_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_inactivity_reminder_states" ADD CONSTRAINT "user_inactivity_reminder_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
