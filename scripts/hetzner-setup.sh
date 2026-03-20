#!/usr/bin/env bash
# Установка Telegram Bot Konstruktor на Hetzner VPS (Ubuntu/Debian)
# Запуск на сервере: curl -sSL https://... | bash
# или: bash hetzner-setup.sh

set -e

echo "=========================================="
echo "  Установка на Hetzner VPS"
echo "  Telegram Bot Konstruktor"
echo "=========================================="

# Проверка root
if [ "$EUID" -ne 0 ]; then
  echo "Запустите с sudo: sudo bash $0"
  exit 1
fi

# 1. Обновление и установка Docker
echo ""
echo "Шаг 1: Установка Docker..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git
curl -fsSL https://get.docker.com | sh
apt-get install -y -qq docker-compose-plugin 2>/dev/null || true

# 2. Создание директории приложения
APP_DIR="/opt/telegram-bot-konstruktor"
echo ""
echo "Шаг 2: Директория приложения: $APP_DIR"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# 3. Клонирование или проверка кода
echo ""
echo "Шаг 3: Получение кода..."
if [ -d ".git" ]; then
  echo "Репозиторий уже есть. Обновляю..."
  git pull --quiet 2>/dev/null || true
else
  read -p "Введите URL GitHub-репозитория (или Enter, если загрузите вручную): " REPO_URL
  if [ -n "$REPO_URL" ]; then
    tmp=$(mktemp -d)
    git clone "$REPO_URL" "$tmp"
    cp -ra "$tmp"/. .
    rm -rf "$tmp"
  else
    echo "Загрузите проект в $APP_DIR (scp, rsync или git clone)"
    echo "Затем запустите снова: sudo bash scripts/hetzner-setup.sh"
    exit 0
  fi
fi

# 4. Файл .env
echo ""
echo "Шаг 4: Настройка .env..."
if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    cp .env.production.example .env
    echo "Создан .env из шаблона. ОТРЕДАКТИРУЙТЕ его: nano $APP_DIR/.env"
  else
    cp .env.example .env 2>/dev/null || true
  fi
  echo ""
  echo "⚠️  ОБЯЗАТЕЛЬНО отредактируйте .env перед запуском!"
  echo "   nano $APP_DIR/.env"
  echo ""
  read -p "Отредактировали .env? (y/n): " OK
  if [ "$OK" != "y" ] && [ "$OK" != "Y" ]; then
    echo "Отредактируйте .env и запустите: cd $APP_DIR && docker compose -f docker-compose.prod.yml up -d"
    exit 0
  fi
fi

# 5. Добавить POSTGRES_PASSWORD в .env если нет
if ! grep -q "^POSTGRES_PASSWORD=" .env 2>/dev/null; then
  PW=$(openssl rand -base64 24 2>/dev/null || head -c 24 /dev/urandom | base64)
  echo "POSTGRES_PASSWORD=$PW" >> .env
  echo "Сгенерирован POSTGRES_PASSWORD. Обновите DATABASE_URL в .env: postgresql://postgres:$PW@postgres:5432/telegram_bot_konstruktor?schema=public"
fi

# 6. Запуск
echo ""
echo "Шаг 5: Сборка и запуск..."
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "=========================================="
echo "  ✓ Установка завершена"
echo "=========================================="
echo ""
echo "Backoffice: http://ВАШ_IP:3000/backoffice"
echo "Health:     http://ВАШ_IP:3000/health"
echo ""
echo "Логи:       docker compose -f docker-compose.prod.yml logs -f"
echo "Остановка:  docker compose -f docker-compose.prod.yml down"
echo ""
