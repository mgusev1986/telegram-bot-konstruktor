/*
  Warnings:

  - Added the required column `bot_instance_id` to the `presentation_templates` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "BackofficeUserRole" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "BotInstanceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'INVALID_TOKEN');

-- DropIndex
DROP INDEX "presentation_templates_is_active_idx";

-- AlterTable
ALTER TABLE "presentation_templates" ADD COLUMN     "bot_instance_id" TEXT;

-- CreateTable
CREATE TABLE "backoffice_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "BackofficeUserRole" NOT NULL DEFAULT 'ADMIN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backoffice_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_instances" (
    "id" TEXT NOT NULL,
    "owner_backoffice_user_id" TEXT,
    "name" TEXT NOT NULL,
    "telegram_bot_token_encrypted" TEXT NOT NULL,
    "telegram_bot_username" TEXT,
    "status" "BotInstanceStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backoffice_users_email_key" ON "backoffice_users"("email");

-- CreateIndex
CREATE INDEX "bot_instances_owner_backoffice_user_id_status_idx" ON "bot_instances"("owner_backoffice_user_id", "status");

-- CreateIndex
CREATE INDEX "presentation_templates_bot_instance_id_is_active_idx" ON "presentation_templates"("bot_instance_id", "is_active");

-- AddForeignKey
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_owner_backoffice_user_id_fkey" FOREIGN KEY ("owner_backoffice_user_id") REFERENCES "backoffice_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presentation_templates" ADD CONSTRAINT "presentation_templates_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
