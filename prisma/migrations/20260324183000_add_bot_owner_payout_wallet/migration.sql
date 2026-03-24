-- CreateTable
CREATE TABLE "bot_owner_payout_wallets" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_owner_payout_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_owner_payout_wallets_bot_instance_id_owner_user_id_key" ON "bot_owner_payout_wallets"("bot_instance_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "bot_owner_payout_wallets_bot_instance_id_idx" ON "bot_owner_payout_wallets"("bot_instance_id");

-- AddForeignKey
ALTER TABLE "bot_owner_payout_wallets" ADD CONSTRAINT "bot_owner_payout_wallets_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_owner_payout_wallets" ADD CONSTRAINT "bot_owner_payout_wallets_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
