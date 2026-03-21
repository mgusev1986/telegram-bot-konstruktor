#!/usr/bin/env bash
# Скачивает последний дамп БД с Hetzner-сервера в текущую папку
# Запуск: bash scripts/fetch-db-from-server.sh [куда_сохранить]
# Пример: bash scripts/fetch-db-from-server.sh ~/Desktop/Telegram-Bot-Konstruktor-BACKUP-xxx/database.sql.gz

set -e

SERVER_USER="${SERVER_USER:-root}"
SERVER_HOST="${SERVER_HOST:-77.42.79.54}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/telegram-bot-konstruktor}"
TARGET="${1:-./database.sql.gz}"

echo "1. Создание бэкапа на сервере..."
ssh "${SERVER_USER}@${SERVER_HOST}" "cd ${REMOTE_APP_DIR} && bash scripts/backup-db.sh"

echo "2. Скачивание дампа..."
REMOTE_FILE=$(ssh "${SERVER_USER}@${SERVER_HOST}" "ls -t ${REMOTE_APP_DIR}/backups/telegram_bot_konstruktor_*.sql.gz 2>/dev/null | head -1" | tr -d '\r')
if [ -z "$REMOTE_FILE" ]; then
  echo "Ошибка: дамп не найден на сервере" >&2
  exit 1
fi

scp "${SERVER_USER}@${SERVER_HOST}:${REMOTE_FILE}" "$TARGET"
echo "✓ Сохранено: $TARGET"
