-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "total_recipients" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "processed_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "success_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "failed_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "pending_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "started_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "finished_at" TIMESTAMP(3);

