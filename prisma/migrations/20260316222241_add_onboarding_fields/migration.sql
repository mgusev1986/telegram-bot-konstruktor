-- AlterTable
ALTER TABLE "users" ADD COLUMN     "onboarding_completed_at" TIMESTAMP(3),
ADD COLUMN     "onboarding_step" INTEGER;
