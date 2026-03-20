-- CreateTable
CREATE TABLE "telegram_media_assets" (
    "id" TEXT NOT NULL,
    "channel_id" BIGINT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "media_type" "MediaType" NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_unique_id" TEXT,
    "caption" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telegram_media_assets_channel_id_created_at_idx" ON "telegram_media_assets"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "telegram_media_assets_media_type_created_at_idx" ON "telegram_media_assets"("media_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_media_assets_channel_id_message_id_key" ON "telegram_media_assets"("channel_id", "message_id");
