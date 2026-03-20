#!/usr/bin/env bash
# Скрипт деплоя Telegram Bot Konstruktor на Railway
# Запуск: ./scripts/deploy.sh  или  bash scripts/deploy.sh

set -e
cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

echo "=========================================="
echo "  Деплой Telegram Bot Konstruktor"
echo "  Платформа: Railway"
echo "=========================================="
echo ""

# 1. Проверка Railway CLI
if ! command -v railway &>/dev/null; then
  echo "Railway CLI не установлен. Устанавливаю..."
  if command -v brew &>/dev/null; then
    brew install railway
  else
    npm install -g @railway/cli
  fi
  echo "✓ Railway CLI установлен"
else
  echo "✓ Railway CLI уже установлен"
fi

# 2. Авторизация
echo ""
echo "Шаг 1: Авторизация в Railway"
echo "Откроется браузер для входа. Войдите в аккаунт Railway (или создайте на railway.app)"
railway login
echo "✓ Авторизация прошла успешно"
echo ""

# 3. Инициализация проекта
echo "Шаг 2: Создание проекта Railway"
if ! railway status &>/dev/null; then
  railway init
else
  echo "Проект уже подключён. Продолжаем..."
fi
echo ""

# 4. Добавление PostgreSQL
echo "Шаг 3: Добавление PostgreSQL"
railway add --database postgres -y 2>/dev/null || railway add --database postgres
echo "✓ PostgreSQL настроен"
echo ""

# 5. Добавление Redis
echo "Шаг 4: Добавление Redis"
railway add --database redis -y 2>/dev/null || railway add --database redis
echo "✓ Redis настроен"
echo ""

# 6. Установка переменных окружения
echo "Шаг 5: Настройка переменных окружения"

# Функция: взять значение из .env
get_env() { grep "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r'; }

# Референсы на базы (Railway автоматически подставляет)
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' 2>/dev/null || railway variable set 'DATABASE_URL=${{postgres.DATABASE_URL}}' 2>/dev/null || true
railway variable set 'REDIS_URL=${{Redis.REDIS_URL}}' 2>/dev/null || railway variable set 'REDIS_URL=${{redis.REDIS_URL}}' 2>/dev/null || true

# Переменные из .env
[ -f ".env" ] && {
  v=$(get_env SUPER_ADMIN_TELEGRAM_ID); [ -n "$v" ] && railway variable set "SUPER_ADMIN_TELEGRAM_ID=$v"
  v=$(get_env BOT_TOKEN); [ -n "$v" ] && railway variable set "BOT_TOKEN=$v"
  v=$(get_env BOT_USERNAME); [ -n "$v" ] && railway variable set "BOT_USERNAME=$v"
  v=$(get_env BOT_TOKEN_ENCRYPTION_KEY); [ -n "$v" ] && railway variable set "BOT_TOKEN_ENCRYPTION_KEY=$v"
  v=$(get_env BACKOFFICE_ADMIN_EMAIL); [ -n "$v" ] && railway variable set "BACKOFFICE_ADMIN_EMAIL=$v"
  v=$(get_env BACKOFFICE_ADMIN_PASSWORD); [ -n "$v" ] && railway variable set "BACKOFFICE_ADMIN_PASSWORD=$v"
  v=$(get_env CEREBRAS_API_KEY); [ -n "$v" ] && railway variable set "CEREBRAS_API_KEY=$v"
  v=$(get_env USDT_BEP20_WALLET); [ -n "$v" ] && railway variable set "USDT_BEP20_WALLET=$v"
}

# Обязательные для production
railway variable set "NODE_ENV=production"
railway variable set "TRANSLATION_PROVIDER=cerebras"
railway variable set "DEFAULT_LANGUAGE=$(get_env DEFAULT_LANGUAGE || echo ru)"
railway variable set "APP_TIMEZONE=$(get_env APP_TIMEZONE || echo Europe/Warsaw)"
railway variable set "LOG_LEVEL=$(get_env LOG_LEVEL || echo info)"
railway variable set "PAYMENT_PROVIDER_MODE=$(get_env PAYMENT_PROVIDER_MODE || echo crypto)"

# BACKOFFICE_JWT_SECRET
v=$(get_env BACKOFFICE_JWT_SECRET)
[ -z "$v" ] && v=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64 2>/dev/null)
[ -n "$v" ] && railway variable set "BACKOFFICE_JWT_SECRET=$v"

echo "✓ Переменные установлены"
echo ""

# 7. Домен
echo "Шаг 6: Публичный домен"
railway domain 2>/dev/null || echo "Создайте домен в Dashboard: Settings → Networking → Generate Domain"
echo ""

# 8. Деплой
echo "Шаг 7: Деплой приложения"
echo "Загрузка и сборка могут занять 2–5 минут..."
railway up

echo ""
echo "=========================================="
echo "  ✓ Деплой завершён!"
echo "=========================================="
echo ""
echo "Проверьте URL: railway open"
echo "Backoffice: https://ВАШ-ДОМЕН.railway.app/backoffice"
echo "Health: https://ВАШ-ДОМЕН.railway.app/health"
echo ""
