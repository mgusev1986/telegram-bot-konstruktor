-- AlterTable
ALTER TABLE "owner_settlement_entries" ADD COLUMN "attributed_owner_user_id" TEXT,
ADD COLUMN "payout_wallet_address" TEXT;

-- CreateIndex
CREATE INDEX "owner_settlement_entries_bot_instance_id_attributed_owner_user_id_idx" ON "owner_settlement_entries"("bot_instance_id", "attributed_owner_user_id");

-- AddForeignKey
ALTER TABLE "owner_settlement_entries" ADD CONSTRAINT "owner_settlement_entries_attributed_owner_user_id_fkey" FOREIGN KEY ("attributed_owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "owner_payout_batch_recipients" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "wallet_address" TEXT NOT NULL,
    "net_amount" DECIMAL(18,8) NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_payout_batch_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_payout_batch_recipients_batch_id_idx" ON "owner_payout_batch_recipients"("batch_id");

-- CreateIndex
CREATE INDEX "owner_payout_batch_recipients_owner_user_id_idx" ON "owner_payout_batch_recipients"("owner_user_id");

-- AddForeignKey
ALTER TABLE "owner_payout_batch_recipients" ADD CONSTRAINT "owner_payout_batch_recipients_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "owner_payout_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_payout_batch_recipients" ADD CONSTRAINT "owner_payout_batch_recipients_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
