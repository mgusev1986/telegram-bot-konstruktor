-- CreateEnum
CREATE TYPE "LanguageGenerationTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "LanguageGenerationTaskItemType" AS ENUM ('PRESENTATION', 'MENU_ITEM');

-- CreateEnum
CREATE TYPE "LanguageGenerationTaskItemStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'GENERATE_LANGUAGE_VERSION_AI';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "external_referral_link" TEXT;

-- CreateTable
CREATE TABLE "language_generation_tasks" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "started_by_user_id" TEXT NOT NULL,
    "source_language_code" TEXT NOT NULL,
    "target_language_code" TEXT NOT NULL,
    "status" "LanguageGenerationTaskStatus" NOT NULL DEFAULT 'PENDING',
    "total_items" INTEGER NOT NULL,
    "completed_items" INTEGER NOT NULL DEFAULT 0,
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "language_generation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "language_generation_task_items" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "entity_type" "LanguageGenerationTaskItemType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "status" "LanguageGenerationTaskItemStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "language_generation_task_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "language_generation_tasks_template_id_target_language_code_idx" ON "language_generation_tasks"("template_id", "target_language_code");

-- CreateIndex
CREATE INDEX "language_generation_tasks_status_started_at_idx" ON "language_generation_tasks"("status", "started_at");

-- CreateIndex
CREATE INDEX "language_generation_task_items_task_id_status_idx" ON "language_generation_task_items"("task_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "language_generation_task_items_task_id_entity_type_entity_i_key" ON "language_generation_task_items"("task_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "language_generation_task_items" ADD CONSTRAINT "language_generation_task_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "language_generation_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
