-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "UserLifecycleStatus" AS ENUM ('NEW', 'INTERESTED', 'ACTIVE', 'PAID', 'PARTNER', 'LEADER', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MenuItemType" AS ENUM ('TEXT', 'PHOTO', 'VIDEO', 'DOCUMENT', 'LINK', 'SUBMENU');

-- CreateEnum
CREATE TYPE "VisibilityMode" AS ENUM ('SHOW', 'HIDE', 'LOCK');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('NONE', 'PHOTO', 'VIDEO', 'DOCUMENT', 'LINK', 'VOICE', 'VIDEO_NOTE');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AudienceType" AS ENUM ('ALL_USERS', 'OWN_FIRST_LINE', 'OWN_STRUCTURE', 'SPECIFIC_LEVEL', 'LANGUAGE', 'ROLE', 'TAGS', 'PAYMENT_STATUS', 'ACTIVITY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DripTriggerType" AS ENUM ('ON_REGISTRATION', 'ON_PAYMENT', 'ON_TAG_ASSIGNED', 'ON_EVENT');

-- CreateEnum
CREATE TYPE "DelayUnit" AS ENUM ('MINUTES', 'HOURS', 'DAYS');

-- CreateEnum
CREATE TYPE "DripProgressStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('SEND_BROADCAST', 'SEND_BROADCAST_BATCH', 'SEND_DRIP_STEP', 'SEND_NOTIFICATION', 'PROCESS_PAYMENT_EXPIRY');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SECTION', 'COURSE', 'SUBSCRIPTION', 'MEDIA', 'FUNNEL');

-- CreateEnum
CREATE TYPE "BillingType" AS ENUM ('ONE_TIME', 'RECURRING', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('CRYPTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentNetwork" AS ENUM ('USDT_TRC20', 'USDT_BEP20', 'TON', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'EXPIRED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('LIFETIME', 'TEMPORARY', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "AccessStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AccessRuleType" AS ENUM ('FREE', 'PRODUCT_PURCHASE', 'REFERRAL_COUNT', 'MLM_LEVEL', 'SEGMENT', 'LANGUAGE', 'PREVIOUS_PROGRESS', 'CONTACT_SHARED', 'REGISTERED_DAYS', 'HAS_TAG', 'NOT_HAS_TAG', 'USER_STATUS');

-- CreateEnum
CREATE TYPE "ContentProgressStatus" AS ENUM ('VIEWED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AbEntityType" AS ENUM ('WELCOME', 'MENU_ITEM', 'OFFER', 'BROADCAST', 'DRIP', 'PRICE');

-- CreateEnum
CREATE TYPE "AbStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'PAUSED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FIRST_LINE_REGISTRATION', 'GLOBAL_REGISTRATION', 'PAYMENT_CONFIRMED', 'PAYMENT_REQUESTED', 'ACCESS_GRANTED', 'ACCESS_EXPIRING', 'BADGE_AWARDED', 'NEXT_STEP', 'SYSTEM_ALERT');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "full_name" TEXT NOT NULL DEFAULT '',
    "phone" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "referral_code" TEXT NOT NULL,
    "invited_by_user_id" TEXT,
    "mentor_user_id" TEXT,
    "selected_language" TEXT NOT NULL DEFAULT 'ru',
    "status" "UserLifecycleStatus" NOT NULL DEFAULT 'NEW',
    "last_content_message_id" INTEGER,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_permissions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "can_edit_menu" BOOLEAN NOT NULL DEFAULT false,
    "can_send_broadcasts" BOOLEAN NOT NULL DEFAULT false,
    "can_schedule_messages" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_languages" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_payments" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_segments" BOOLEAN NOT NULL DEFAULT false,
    "can_view_global_stats" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_templates" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presentation_templates" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "owner_admin_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presentation_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presentation_localizations" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "welcome_text" TEXT NOT NULL DEFAULT '',
    "welcome_media_type" "MediaType" NOT NULL DEFAULT 'NONE',
    "welcome_media_file_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presentation_localizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "key" TEXT NOT NULL,
    "type" "MenuItemType" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "visibility_mode" "VisibilityMode" NOT NULL DEFAULT 'SHOW',
    "access_rule_id" TEXT,
    "product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_localizations" (
    "id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content_text" TEXT NOT NULL DEFAULT '',
    "media_type" "MediaType" NOT NULL DEFAULT 'NONE',
    "media_file_id" TEXT,
    "external_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_localizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_events" (
    "id" TEXT NOT NULL,
    "inviter_user_id" TEXT NOT NULL,
    "invited_user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_stats_cache" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "first_line_count" INTEGER NOT NULL DEFAULT 0,
    "total_structure_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_stats_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "provided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "audience_type" "AudienceType" NOT NULL,
    "segment_query" JSONB NOT NULL DEFAULT '{}',
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "send_at" TIMESTAMP(3),
    "is_scheduled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_localizations" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "media_type" "MediaType" NOT NULL DEFAULT 'NONE',
    "media_file_id" TEXT,
    "external_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_localizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMP(3),
    "error_message" TEXT,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_campaigns" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trigger_type" "DripTriggerType" NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drip_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_steps" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "delay_value" INTEGER NOT NULL,
    "delay_unit" "DelayUnit" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drip_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drip_step_localizations" (
    "id" TEXT NOT NULL,
    "drip_step_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "media_type" "MediaType" NOT NULL DEFAULT 'NONE',
    "media_file_id" TEXT,
    "external_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drip_step_localizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_drip_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3),
    "status" "DripProgressStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_drip_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "job_type" "JobType" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "run_at" TIMESTAMP(3) NOT NULL,
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "price" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "billing_type" "BillingType" NOT NULL,
    "duration_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_localizations" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "pay_button_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_localizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "network" "PaymentNetwork" NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "reference_code" TEXT NOT NULL,
    "external_tx_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_access_rights" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "access_type" "AccessType" NOT NULL,
    "active_from" TIMESTAMP(3) NOT NULL,
    "active_until" TIMESTAMP(3),
    "status" "AccessStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_access_rights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_rules" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rule_type" "AccessRuleType" NOT NULL,
    "config_json" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tags" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "assigned_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "note_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "button_click_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "button_click_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "status" "ContentProgressStatus" NOT NULL,
    "viewed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "content_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_tests" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entity_type" "AbEntityType" NOT NULL,
    "status" "AbStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_test_variants" (
    "id" TEXT NOT NULL,
    "ab_test_id" TEXT NOT NULL,
    "variant_key" TEXT NOT NULL,
    "config_json" JSONB NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_test_assignments" (
    "id" TEXT NOT NULL,
    "ab_test_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "variant_key" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "badge_id" TEXT NOT NULL,
    "awarded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_action_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "payload_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");
CREATE INDEX "users_invited_by_user_id_idx" ON "users"("invited_by_user_id");
CREATE INDEX "users_mentor_user_id_idx" ON "users"("mentor_user_id");
CREATE INDEX "users_role_idx" ON "users"("role");
CREATE INDEX "users_selected_language_idx" ON "users"("selected_language");
CREATE INDEX "users_status_idx" ON "users"("status");
CREATE UNIQUE INDEX "admin_permissions_user_id_key" ON "admin_permissions"("user_id");
CREATE INDEX "presentation_templates_is_active_idx" ON "presentation_templates"("is_active");
CREATE UNIQUE INDEX "presentation_localizations_template_id_language_code_key" ON "presentation_localizations"("template_id", "language_code");
CREATE UNIQUE INDEX "menu_items_key_key" ON "menu_items"("key");
CREATE INDEX "menu_items_template_id_parent_id_sort_order_idx" ON "menu_items"("template_id", "parent_id", "sort_order");
CREATE INDEX "menu_items_access_rule_id_idx" ON "menu_items"("access_rule_id");
CREATE INDEX "menu_items_product_id_idx" ON "menu_items"("product_id");
CREATE UNIQUE INDEX "menu_item_localizations_menu_item_id_language_code_key" ON "menu_item_localizations"("menu_item_id", "language_code");
CREATE INDEX "referral_events_inviter_user_id_created_at_idx" ON "referral_events"("inviter_user_id", "created_at");
CREATE INDEX "referral_events_invited_user_id_created_at_idx" ON "referral_events"("invited_user_id", "created_at");
CREATE UNIQUE INDEX "referral_stats_cache_user_id_key" ON "referral_stats_cache"("user_id");
CREATE INDEX "contacts_user_id_provided_at_idx" ON "contacts"("user_id", "provided_at");
CREATE INDEX "broadcasts_status_send_at_idx" ON "broadcasts"("status", "send_at");
CREATE UNIQUE INDEX "broadcast_localizations_broadcast_id_language_code_key" ON "broadcast_localizations"("broadcast_id", "language_code");
CREATE INDEX "broadcast_recipients_status_idx" ON "broadcast_recipients"("status");
CREATE UNIQUE INDEX "broadcast_recipients_broadcast_id_user_id_key" ON "broadcast_recipients"("broadcast_id", "user_id");
CREATE INDEX "drip_campaigns_is_active_trigger_type_idx" ON "drip_campaigns"("is_active", "trigger_type");
CREATE UNIQUE INDEX "drip_steps_campaign_id_step_order_key" ON "drip_steps"("campaign_id", "step_order");
CREATE UNIQUE INDEX "drip_step_localizations_drip_step_id_language_code_key" ON "drip_step_localizations"("drip_step_id", "language_code");
CREATE INDEX "user_drip_progress_status_next_run_at_idx" ON "user_drip_progress"("status", "next_run_at");
CREATE UNIQUE INDEX "user_drip_progress_user_id_campaign_id_key" ON "user_drip_progress"("user_id", "campaign_id");
CREATE UNIQUE INDEX "scheduled_jobs_idempotency_key_key" ON "scheduled_jobs"("idempotency_key");
CREATE INDEX "scheduled_jobs_status_run_at_idx" ON "scheduled_jobs"("status", "run_at");
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");
CREATE INDEX "products_is_active_idx" ON "products"("is_active");
CREATE UNIQUE INDEX "product_localizations_product_id_language_code_key" ON "product_localizations"("product_id", "language_code");
CREATE UNIQUE INDEX "payments_reference_code_key" ON "payments"("reference_code");
CREATE INDEX "payments_user_id_status_idx" ON "payments"("user_id", "status");
CREATE INDEX "payments_product_id_status_idx" ON "payments"("product_id", "status");
CREATE INDEX "user_access_rights_user_id_status_active_until_idx" ON "user_access_rights"("user_id", "status", "active_until");
CREATE UNIQUE INDEX "access_rules_code_key" ON "access_rules"("code");
CREATE INDEX "access_rules_is_active_idx" ON "access_rules"("is_active");
CREATE UNIQUE INDEX "tags_code_key" ON "tags"("code");
CREATE INDEX "user_tags_assigned_by_user_id_idx" ON "user_tags"("assigned_by_user_id");
CREATE UNIQUE INDEX "user_tags_user_id_tag_id_key" ON "user_tags"("user_id", "tag_id");
CREATE INDEX "user_notes_user_id_created_at_idx" ON "user_notes"("user_id", "created_at");
CREATE INDEX "button_click_events_menu_item_id_created_at_idx" ON "button_click_events"("menu_item_id", "created_at");
CREATE INDEX "button_click_events_user_id_created_at_idx" ON "button_click_events"("user_id", "created_at");
CREATE UNIQUE INDEX "content_progress_user_id_menu_item_id_key" ON "content_progress"("user_id", "menu_item_id");
CREATE UNIQUE INDEX "ab_tests_code_key" ON "ab_tests"("code");
CREATE UNIQUE INDEX "ab_test_variants_ab_test_id_variant_key_key" ON "ab_test_variants"("ab_test_id", "variant_key");
CREATE UNIQUE INDEX "ab_test_assignments_ab_test_id_user_id_key" ON "ab_test_assignments"("ab_test_id", "user_id");
CREATE INDEX "notifications_user_id_status_created_at_idx" ON "notifications"("user_id", "status", "created_at");
CREATE UNIQUE INDEX "badges_code_key" ON "badges"("code");
CREATE UNIQUE INDEX "user_badges_user_id_badge_id_key" ON "user_badges"("user_id", "badge_id");
CREATE INDEX "admin_action_logs_user_id_created_at_idx" ON "admin_action_logs"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_mentor_user_id_fkey" FOREIGN KEY ("mentor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "presentation_templates" ADD CONSTRAINT "presentation_templates_owner_admin_id_fkey" FOREIGN KEY ("owner_admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "presentation_localizations" ADD CONSTRAINT "presentation_localizations_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "presentation_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "presentation_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_access_rule_id_fkey" FOREIGN KEY ("access_rule_id") REFERENCES "access_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "menu_item_localizations" ADD CONSTRAINT "menu_item_localizations_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_inviter_user_id_fkey" FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_stats_cache" ADD CONSTRAINT "referral_stats_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broadcast_localizations" ADD CONSTRAINT "broadcast_localizations_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drip_campaigns" ADD CONSTRAINT "drip_campaigns_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drip_steps" ADD CONSTRAINT "drip_steps_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "drip_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "drip_step_localizations" ADD CONSTRAINT "drip_step_localizations_drip_step_id_fkey" FOREIGN KEY ("drip_step_id") REFERENCES "drip_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_drip_progress" ADD CONSTRAINT "user_drip_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_drip_progress" ADD CONSTRAINT "user_drip_progress_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "drip_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_localizations" ADD CONSTRAINT "product_localizations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_access_rights" ADD CONSTRAINT "user_access_rights_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_access_rights" ADD CONSTRAINT "user_access_rights_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "button_click_events" ADD CONSTRAINT "button_click_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "button_click_events" ADD CONSTRAINT "button_click_events_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_progress" ADD CONSTRAINT "content_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_progress" ADD CONSTRAINT "content_progress_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ab_test_variants" ADD CONSTRAINT "ab_test_variants_ab_test_id_fkey" FOREIGN KEY ("ab_test_id") REFERENCES "ab_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ab_test_assignments" ADD CONSTRAINT "ab_test_assignments_ab_test_id_fkey" FOREIGN KEY ("ab_test_id") REFERENCES "ab_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ab_test_assignments" ADD CONSTRAINT "ab_test_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_action_logs" ADD CONSTRAINT "admin_action_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
