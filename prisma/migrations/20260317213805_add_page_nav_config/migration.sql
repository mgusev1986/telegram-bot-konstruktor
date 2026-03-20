-- CreateTable
CREATE TABLE "page_nav_configs" (
    "id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "slot_order" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_nav_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "page_nav_configs_menu_item_id_key" ON "page_nav_configs"("menu_item_id");
