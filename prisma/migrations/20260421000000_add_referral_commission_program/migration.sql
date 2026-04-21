-- Multi-level referral/partner commission program.
-- Adds per-bot configuration, level-by-level commission rates, per-purchase accruals,
-- and extends WithdrawalRequest to support automated NOWPayments Mass Payout flow.

-- AlterEnum
ALTER TYPE "BalanceLedgerEntryType" ADD VALUE 'REFERRAL_COMMISSION';
ALTER TYPE "BalanceLedgerEntryType" ADD VALUE 'WITHDRAWAL_DEBIT';
ALTER TYPE "BalanceLedgerEntryType" ADD VALUE 'WITHDRAWAL_REVERSAL';

-- AlterEnum (Postgres requires ADD VALUE one at a time in older versions; each is idempotent-safe in fresh DBs)
ALTER TYPE "WithdrawalRequestStatus" ADD VALUE 'SENT';
ALTER TYPE "WithdrawalRequestStatus" ADD VALUE 'FAILED';

-- CreateEnum
CREATE TYPE "ReferralCommissionAccrualStatus" AS ENUM ('CREDITED', 'REVERSED');

-- AlterTable: WithdrawalRequest — payout routing + NOWPayments tracking
ALTER TABLE "withdrawal_requests"
  ADD COLUMN "bot_instance_id" TEXT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USDT',
  ADD COLUMN "payout_address" TEXT,
  ADD COLUMN "payout_currency" TEXT,
  ADD COLUMN "debit_ledger_entry_id" TEXT,
  ADD COLUMN "provider_batch_id" TEXT,
  ADD COLUMN "provider_payout_id" TEXT,
  ADD COLUMN "provider_status" TEXT,
  ADD COLUMN "provider_response" JSONB,
  ADD COLUMN "error_message" TEXT,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "sent_at" TIMESTAMP(3),
  ADD COLUMN "completed_at" TIMESTAMP(3),
  ADD COLUMN "failed_at" TIMESTAMP(3);

CREATE INDEX "withdrawal_requests_bot_instance_id_status_idx" ON "withdrawal_requests"("bot_instance_id", "status");
CREATE INDEX "withdrawal_requests_provider_batch_id_idx" ON "withdrawal_requests"("provider_batch_id");

ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_bot_instance_id_fkey"
  FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: ReferralProgramConfig
CREATE TABLE "referral_program_configs" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "min_withdrawal_amount" DECIMAL(18,8) NOT NULL DEFAULT 5,
    "min_balance_reserve" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "auto_approve_withdrawals" BOOLEAN NOT NULL DEFAULT false,
    "payout_currency" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_program_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_program_configs_bot_instance_id_key" ON "referral_program_configs"("bot_instance_id");

ALTER TABLE "referral_program_configs" ADD CONSTRAINT "referral_program_configs_bot_instance_id_fkey"
  FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: ReferralCommissionLevel
CREATE TABLE "referral_commission_levels" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "percent" DECIMAL(7,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_commission_levels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_commission_levels_config_id_level_key" ON "referral_commission_levels"("config_id", "level");
CREATE INDEX "referral_commission_levels_config_id_idx" ON "referral_commission_levels"("config_id");

ALTER TABLE "referral_commission_levels" ADD CONSTRAINT "referral_commission_levels_config_id_fkey"
  FOREIGN KEY ("config_id") REFERENCES "referral_program_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: ReferralCommissionAccrual
CREATE TABLE "referral_commission_accruals" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "config_id" TEXT,
    "partner_user_id" TEXT NOT NULL,
    "source_user_id" TEXT NOT NULL,
    "product_purchase_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "percent" DECIMAL(7,4) NOT NULL,
    "basis_amount" DECIMAL(18,8) NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "ledger_entry_id" TEXT,
    "status" "ReferralCommissionAccrualStatus" NOT NULL DEFAULT 'CREDITED',
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_commission_accruals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_commission_accruals_product_purchase_id_partner_user_id_level_key" ON "referral_commission_accruals"("product_purchase_id", "partner_user_id", "level");
CREATE INDEX "referral_commission_accruals_partner_user_id_created_at_idx" ON "referral_commission_accruals"("partner_user_id", "created_at");
CREATE INDEX "referral_commission_accruals_bot_instance_id_created_at_idx" ON "referral_commission_accruals"("bot_instance_id", "created_at");
CREATE INDEX "referral_commission_accruals_source_user_id_idx" ON "referral_commission_accruals"("source_user_id");

ALTER TABLE "referral_commission_accruals" ADD CONSTRAINT "referral_commission_accruals_bot_instance_id_fkey"
  FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referral_commission_accruals" ADD CONSTRAINT "ref_comm_accrual_config_fk"
  FOREIGN KEY ("config_id") REFERENCES "referral_program_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "referral_commission_accruals" ADD CONSTRAINT "referral_commission_accruals_partner_user_id_fkey"
  FOREIGN KEY ("partner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referral_commission_accruals" ADD CONSTRAINT "referral_commission_accruals_source_user_id_fkey"
  FOREIGN KEY ("source_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referral_commission_accruals" ADD CONSTRAINT "referral_commission_accruals_product_purchase_id_fkey"
  FOREIGN KEY ("product_purchase_id") REFERENCES "product_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
