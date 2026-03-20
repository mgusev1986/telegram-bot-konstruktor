-- AlterEnum
ALTER TYPE "MenuItemType" ADD VALUE 'SECTION_LINK';

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "target_menu_item_id" TEXT;

-- CreateIndex
CREATE INDEX "menu_items_target_menu_item_id_idx" ON "menu_items"("target_menu_item_id");

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_target_menu_item_id_fkey" FOREIGN KEY ("target_menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
