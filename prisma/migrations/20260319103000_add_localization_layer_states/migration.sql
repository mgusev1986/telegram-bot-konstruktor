-- CreateEnum
CREATE TYPE "LocalizationLayerStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "localization_layer_states" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "status" "LocalizationLayerStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" TEXT,
    "last_edited_by_user_id" TEXT,
    "draft_saved_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "localization_layer_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "localization_layer_states_template_id_language_code_key"
ON "localization_layer_states"("template_id", "language_code");

-- CreateIndex
CREATE INDEX "localization_layer_states_template_id_status_idx"
ON "localization_layer_states"("template_id", "status");

-- AddForeignKey
ALTER TABLE "localization_layer_states"
ADD CONSTRAINT "localization_layer_states_template_id_fkey"
FOREIGN KEY ("template_id") REFERENCES "presentation_templates"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
