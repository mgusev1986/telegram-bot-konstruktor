-- AlterTable
ALTER TABLE "bot_instances" ADD COLUMN "telegram_bot_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "bot_instances_telegram_bot_token_hash_key" ON "bot_instances"("telegram_bot_token_hash");
