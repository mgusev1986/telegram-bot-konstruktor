#!/usr/bin/env bash
# Восстановление PostgreSQL из бэкапа
# Использование: bash scripts/restore-db.sh [путь_к_файлу.sql.gz]
# Если путь не указан — берётся последний бэкап из backups/

set -e

APP_DIR="${APP_DIR:-/opt/telegram-bot-konstruktor}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_NAME="telegram_bot_konstruktor"

cd "$APP_DIR"

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "Ошибка: POSTGRES_PASSWORD не задан в .env" >&2
  exit 1
fi

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/telegram_bot_konstruktor_*.sql.gz 2>/dev/null | head -1)
fi

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Ошибка: бэкап не найден. Укажите путь: $0 /path/to/backup.sql.gz" >&2
  exit 1
fi

echo "Восстановление из: $BACKUP_FILE"
echo "⚠️  Текущие данные БД будут полностью удалены и заменены бэкапом!"
read -p "Продолжить? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Отменено."
  exit 0
fi

export PGPASSWORD="$POSTGRES_PASSWORD"

# Останавливаем бота, чтобы освободить соединения с БД
echo "[$(date -Iseconds)] Остановка бота..."
docker compose -f "$COMPOSE_FILE" stop bot 2>/dev/null || true

# Завершаем все соединения с БД
echo "[$(date -Iseconds)] Завершение соединений с БД..."
docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" 2>/dev/null || true

# Удаляем и создаём БД заново
echo "[$(date -Iseconds)] Пересоздание БД..."
docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE $DB_NAME;"

# Восстанавливаем данные
echo "[$(date -Iseconds)] Восстановление данных..."
gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q

# Запускаем миграции (на случай изменений схемы после бэкапа)
echo "[$(date -Iseconds)] Применение миграций..."
docker compose -f "$COMPOSE_FILE" run --rm bot npx prisma migrate deploy 2>/dev/null || true

# Запускаем бота
echo "[$(date -Iseconds)] Запуск бота..."
docker compose -f "$COMPOSE_FILE" start bot

unset PGPASSWORD
echo "[$(date -Iseconds)] ✓ Готово"
