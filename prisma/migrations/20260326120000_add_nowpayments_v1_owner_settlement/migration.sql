-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'PROCESS_OWNER_DAILY_PAYOUTS';

-- CreateEnum
CREATE TYPE "OwnerSettlementEntryStatus" AS ENUM ('PENDING', 'BATCHED', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "OwnerPayoutBatchStatus" AS ENUM ('CREATED', 'SENT', 'PARTIAL', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "deposit_transactions" ADD COLUMN "bot_instance_id" TEXT,
ADD COLUMN "provider_status" TEXT,
ADD COLUMN "provider_pay_address" TEXT,
ADD COLUMN "requested_amount_usd" DECIMAL(18,8),
ADD COLUMN "requested_asset_code" TEXT,
ADD COLUMN "credited_balance_amount" DECIMAL(18,8),
ADD COLUMN "actual_outcome_amount" DECIMAL(18,8),
ADD COLUMN "processor_fee_amount" DECIMAL(18,8),
ADD COLUMN "platform_fee_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
ADD COLUMN "owner_accrual_amount" DECIMAL(18,8),
ADD COLUMN "webhook_last_processed_at" TIMESTAMP(3),
ADD COLUMN "confirmed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "payment_webhook_logs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nowpayments',
    "external_event_id" TEXT,
    "deposit_transaction_id" TEXT,
    "headers_json" JSONB NOT NULL,
    "body_json" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processing_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_payment_provider_configs" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'NOWPAYMENTS',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pay_currency" TEXT NOT NULL DEFAULT 'usdtbsc',
    "settlement_currency" TEXT NOT NULL DEFAULT 'usdttrc20',
    "owner_wallet_address" TEXT,
    "owner_wallet_network" TEXT,
    "owner_payout_enabled" BOOLEAN NOT NULL DEFAULT false,
    "platform_fee_percent" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "platform_fee_fixed_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "daily_payout_enabled" BOOLEAN NOT NULL DEFAULT true,
    "daily_payout_min_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "payout_time_zone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "payout_hour_local" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_payment_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_payout_batches" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "run_date" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "status" "OwnerPayoutBatchStatus" NOT NULL DEFAULT 'CREATED',
    "entries_count" INTEGER NOT NULL DEFAULT 0,
    "gross_total" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "processor_fee_total" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "platform_fee_total" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "payout_network_fee_total" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "net_total" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "provider_batch_id" TEXT,
    "provider_response_json" JSONB,
    "error_message" TEXT,
    "executed_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_settlement_entries" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "deposit_transaction_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "gross_amount" DECIMAL(18,8) NOT NULL,
    "processor_fee_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "platform_fee_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "payout_network_fee_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "net_amount_before_payout_fee" DECIMAL(18,8) NOT NULL,
    "final_payout_net_amount" DECIMAL(18,8),
    "status" "OwnerSettlementEntryStatus" NOT NULL DEFAULT 'PENDING',
    "batch_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "owner_settlement_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deposit_transactions_bot_instance_id_status_idx" ON "deposit_transactions"("bot_instance_id", "status");

-- CreateIndex
CREATE INDEX "payment_webhook_logs_provider_external_event_id_idx" ON "payment_webhook_logs"("provider", "external_event_id");

-- CreateIndex
CREATE INDEX "payment_webhook_logs_provider_created_at_idx" ON "payment_webhook_logs"("provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bot_payment_provider_configs_bot_instance_id_key" ON "bot_payment_provider_configs"("bot_instance_id");

-- CreateIndex
CREATE INDEX "owner_payout_batches_bot_instance_id_run_date_idx" ON "owner_payout_batches"("bot_instance_id", "run_date");

-- CreateIndex
CREATE INDEX "owner_payout_batches_status_idx" ON "owner_payout_batches"("status");

-- CreateIndex
CREATE UNIQUE INDEX "owner_settlement_entries_deposit_transaction_id_key" ON "owner_settlement_entries"("deposit_transaction_id");

-- CreateIndex
CREATE INDEX "owner_settlement_entries_bot_instance_id_status_idx" ON "owner_settlement_entries"("bot_instance_id", "status");

-- CreateIndex
CREATE INDEX "owner_settlement_entries_batch_id_idx" ON "owner_settlement_entries"("batch_id");

-- CreateIndex
CREATE INDEX "owner_settlement_entries_status_created_at_idx" ON "owner_settlement_entries"("status", "created_at");

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_payment_provider_configs" ADD CONSTRAINT "bot_payment_provider_configs_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_payout_batches" ADD CONSTRAINT "owner_payout_batches_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_settlement_entries" ADD CONSTRAINT "owner_settlement_entries_deposit_transaction_id_fkey" FOREIGN KEY ("deposit_transaction_id") REFERENCES "deposit_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_settlement_entries" ADD CONSTRAINT "owner_settlement_entries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "owner_payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_settlement_entries" ADD CONSTRAINT "owner_settlement_entries_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
