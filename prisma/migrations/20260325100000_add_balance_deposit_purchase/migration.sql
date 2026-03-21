-- CreateEnum
CREATE TYPE "DepositTransactionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'DUPLICATE', 'IGNORED');

-- CreateEnum
CREATE TYPE "ProductPurchaseStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "BalanceLedgerEntryType" AS ENUM ('CREDIT', 'DEBIT', 'ADJUSTMENT', 'REFUND_RESERVE', 'REFUND_RELEASE', 'REFUND_DEBIT');

-- CreateTable
CREATE TABLE "user_balance_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "balance" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_balance_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_ledger_entries" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" "BalanceLedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "balance_after" DECIMAL(18,8),
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nowpayments',
    "provider_payment_id" TEXT,
    "order_id" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDT',
    "status" "DepositTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "raw_payload" JSONB,
    "credited_at" TIMESTAMP(3),
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_purchases" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "ledger_entry_id" TEXT NOT NULL,
    "status" "ProductPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "status" "WithdrawalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_event_logs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nowpayments',
    "provider_tx_id" TEXT NOT NULL,
    "order_id" TEXT,
    "raw_payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "processed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_balance_accounts_user_id_key" ON "user_balance_accounts"("user_id");

-- CreateIndex
CREATE INDEX "balance_ledger_entries_account_id_created_at_idx" ON "balance_ledger_entries"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "balance_ledger_entries_reference_type_reference_id_idx" ON "balance_ledger_entries"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_transactions_provider_payment_id_key" ON "deposit_transactions"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_transactions_order_id_key" ON "deposit_transactions"("order_id");

-- CreateIndex
CREATE INDEX "deposit_transactions_user_id_status_idx" ON "deposit_transactions"("user_id", "status");

-- CreateIndex
CREATE INDEX "deposit_transactions_order_id_idx" ON "deposit_transactions"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_purchases_idempotency_key_key" ON "product_purchases"("idempotency_key");

-- CreateIndex
CREATE INDEX "product_purchases_user_id_product_id_idx" ON "product_purchases"("user_id", "product_id");

-- CreateIndex
CREATE INDEX "withdrawal_requests_user_id_status_idx" ON "withdrawal_requests"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_event_logs_provider_provider_tx_id_key" ON "provider_event_logs"("provider", "provider_tx_id");

-- CreateIndex
CREATE INDEX "provider_event_logs_provider_order_id_idx" ON "provider_event_logs"("provider", "order_id");

-- AddForeignKey
ALTER TABLE "user_balance_accounts" ADD CONSTRAINT "user_balance_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_ledger_entries" ADD CONSTRAINT "balance_ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user_balance_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user_balance_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_purchases" ADD CONSTRAINT "product_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_purchases" ADD CONSTRAINT "product_purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_purchases" ADD CONSTRAINT "product_purchases_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user_balance_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "user_balance_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
