-- Добавляем durationMinutes для тестового режима (1, 5 минут вместо дней)
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "duration_minutes" INTEGER;
