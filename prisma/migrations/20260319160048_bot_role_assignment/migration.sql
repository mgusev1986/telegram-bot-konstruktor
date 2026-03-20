-- CreateEnum
CREATE TYPE "BotScopedRole" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "BotRoleAssignmentStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "bot_instances" ADD COLUMN     "is_archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paid_access_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "bot_role_assignments" (
    "id" TEXT NOT NULL,
    "bot_instance_id" TEXT NOT NULL,
    "telegram_username_raw" TEXT,
    "telegram_username_normalized" TEXT NOT NULL,
    "role" "BotScopedRole" NOT NULL,
    "status" "BotRoleAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "user_id" TEXT,
    "granted_by_user_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_role_assignments_bot_instance_id_status_idx" ON "bot_role_assignments"("bot_instance_id", "status");

-- CreateIndex
CREATE INDEX "bot_role_assignments_bot_instance_id_role_idx" ON "bot_role_assignments"("bot_instance_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "bot_role_assignments_bot_instance_id_telegram_username_norm_key" ON "bot_role_assignments"("bot_instance_id", "telegram_username_normalized");

-- AddForeignKey
ALTER TABLE "bot_role_assignments" ADD CONSTRAINT "bot_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_role_assignments" ADD CONSTRAINT "bot_role_assignments_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_role_assignments" ADD CONSTRAINT "bot_role_assignments_bot_instance_id_fkey" FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
