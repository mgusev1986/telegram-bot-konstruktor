#!/usr/bin/env bash
# Резервное копирование PostgreSQL для Telegram Bot Konstruktor
# Запуск: bash scripts/backup-db.sh
# Cron: 0 3 * * * cd /opt/telegram-bot-konstruktor && bash scripts/backup-db.sh

set -e

APP_DIR="${APP_DIR:-/opt/telegram-bot-konstruktor}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
KEEP_DAILY="${KEEP_DAILY:-7}"
DB_NAME="telegram_bot_konstruktor"

cd "$APP_DIR"

# Загрузка .env (POSTGRES_PASSWORD нужен для pg_dump)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "Ошибка: POSTGRES_PASSWORD не задан в .env" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="$BACKUP_DIR/telegram_bot_konstruktor_${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] Создание бэкапа: $BACKUP_FILE"

export PGPASSWORD="$POSTGRES_PASSWORD"
if docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U postgres -F p --no-owner --no-acl "$DB_NAME" 2>/dev/null | gzip > "$BACKUP_FILE"; then
  echo "[$(date -Iseconds)] Бэкап создан: $(du -h "$BACKUP_FILE" | cut -f1)"
else
  echo "[$(date -Iseconds)] Ошибка создания бэкапа" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi
unset PGPASSWORD

# Ротация: оставить последние KEEP_DAILY бэкапов
cd "$BACKUP_DIR"
ls -t telegram_bot_konstruktor_*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f
echo "[$(date -Iseconds)] Ротация: оставлено до $KEEP_DAILY бэкапов"
