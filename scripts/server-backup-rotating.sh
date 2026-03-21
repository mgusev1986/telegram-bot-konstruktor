#!/usr/bin/env bash
# Полный бэкап бота на сервере: БД + настройки + schema
# Каждый бэкап в отдельной папке с датой и временем
# Ротация: храним максимум 12 бэкапов, старейший удаляется
#
# Запуск: bash scripts/server-backup-rotating.sh
# Cron (каждые 2 часа): 0 */2 * * * cd /opt/telegram-bot-konstruktor && bash scripts/server-backup-rotating.sh
#
# Папка бэкапов: /root/bot-backups (не в веб-доступе, только root)

set -e

APP_DIR="${APP_DIR:-/opt/telegram-bot-konstruktor}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/bot-backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
KEEP_COUNT="${KEEP_COUNT:-12}"
DB_NAME="telegram_bot_konstruktor"

cd "$APP_DIR"

# Загрузка .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "[$(date -Iseconds)] Ошибка: POSTGRES_PASSWORD не задан в .env" >&2
  exit 1
fi

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR="$BACKUP_ROOT/backup-$TIMESTAMP"

mkdir -p "$BACKUP_ROOT"
mkdir -p "$BACKUP_DIR"

# Права: только root
chmod 700 "$BACKUP_ROOT" 2>/dev/null || true

echo "[$(date -Iseconds)] Создание бэкапа: $BACKUP_DIR"

# 1. Дамп БД
echo "[$(date -Iseconds)] Дамп PostgreSQL..."
export PGPASSWORD="$POSTGRES_PASSWORD"
if ! docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U postgres -F p --no-owner --no-acl "$DB_NAME" 2>/dev/null | gzip > "$BACKUP_DIR/database.sql.gz"; then
  echo "[$(date -Iseconds)] Ошибка дампа БД" >&2
  rm -rf "$BACKUP_DIR"
  unset PGPASSWORD
  exit 1
fi
unset PGPASSWORD
chmod 600 "$BACKUP_DIR/database.sql.gz"

# 2. .env (настройки, токены)
if [ -f .env ]; then
  cp .env "$BACKUP_DIR/.env"
  chmod 600 "$BACKUP_DIR/.env"
fi

# 3. Prisma schema (структура БД)
if [ -f prisma/schema.prisma ]; then
  cp prisma/schema.prisma "$BACKUP_DIR/prisma-schema.prisma"
  chmod 600 "$BACKUP_DIR/prisma-schema.prisma"
fi

# 4. Манифест
cat > "$BACKUP_DIR/manifest.txt" << EOF
Бэкап Telegram Bot Konstruktor
Создан: $(date -Iseconds)
Сервер: $(hostname)

Содержимое:
- database.sql.gz — полный дамп PostgreSQL (пользователи, меню, шаблоны, всё)
- .env — настройки и секреты
- prisma-schema.prisma — схема БД

Восстановление: см. RESTORE.txt
EOF
chmod 600 "$BACKUP_DIR/manifest.txt"

# 5. Инструкция по восстановлению
cat > "$BACKUP_DIR/RESTORE.txt" << 'RESTOREEOF'
Восстановление из бэкапа (на сервере):

1. cd /opt/telegram-bot-konstruktor
2. cp ПУТЬ_К_БЭКАПУ/.env .env
3. bash scripts/restore-db.sh ПУТЬ_К_БЭКАПУ/database.sql.gz
4. docker compose -f docker-compose.prod.yml up -d
RESTOREEOF
chmod 600 "$BACKUP_DIR/RESTORE.txt"

echo "[$(date -Iseconds)] Бэкап создан: $(du -sh "$BACKUP_DIR" | cut -f1)"

# Ротация: оставить последние KEEP_COUNT бэкапов
cd "$BACKUP_ROOT"
EXISTING=$(ls -d backup-* 2>/dev/null | wc -l)
if [ "$EXISTING" -gt "$KEEP_COUNT" ]; then
  TO_REMOVE=$((EXISTING - KEEP_COUNT))
  ls -d backup-* 2>/dev/null | tail -n "$TO_REMOVE" | while read -r old; do
    echo "[$(date -Iseconds)] Удаление старого бэкапа: $old"
    rm -rf "$old"
  done
fi

REMAINING=$(ls -d backup-* 2>/dev/null | wc -l)
echo "[$(date -Iseconds)] Ротация: сохранено $REMAINING из $KEEP_COUNT бэкапов"
echo "[$(date -Iseconds)] Готово: $BACKUP_DIR"
