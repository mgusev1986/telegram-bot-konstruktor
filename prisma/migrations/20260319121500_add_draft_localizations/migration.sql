-- Draft tables for language-version editor (draft vs published content)

-- CreateTable
CREATE TABLE "presentation_localizations_draft" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "welcome_text" TEXT NOT NULL DEFAULT '',
    "welcome_media_type" "MediaType" NOT NULL DEFAULT 'NONE',
    "welcome_media_file_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "presentation_localizations_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "presentation_localizations_draft_template_id_language_code_key"
ON "presentation_localizations_draft"("template_id", "language_code");

-- AddForeignKey
ALTER TABLE "presentation_localizations_draft"
ADD CONSTRAINT "presentation_localizations_draft_template_id_fkey"
FOREIGN KEY ("template_id") REFERENCES "presentation_templates"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "menu_item_localizations_draft" (
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

    CONSTRAINT "menu_item_localizations_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_localizations_draft_menu_item_id_language_code_key"
ON "menu_item_localizations_draft"("menu_item_id", "language_code");

-- AddForeignKey
ALTER TABLE "menu_item_localizations_draft"
ADD CONSTRAINT "menu_item_localizations_draft_menu_item_id_fkey"
FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

