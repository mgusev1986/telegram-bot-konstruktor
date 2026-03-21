#!/usr/bin/env bash
# Полный бэкап Telegram Bot Konstruktor на Mac (код + БД + настройки)
# Создаёт папку backups/ внутри проекта со всем необходимым для восстановления.
#
# Использование:
#   bash scripts/full-backup-to-local.sh
#   SERVER_USER=root SERVER_HOST=77.42.79.54 bash scripts/full-backup-to-local.sh
#
# Требуется: SSH-доступ к серверу для выгрузки БД (или выполните шаги вручную — см. RESTORE.md в бэкапе)

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_NAME="full-BACKUP-${TIMESTAMP}"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_ROOT/backups/$BACKUP_NAME}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_HOST="${SERVER_HOST:-77.42.79.54}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/telegram-bot-konstruktor}"

echo "=========================================="
echo "  Полный бэкап Telegram Bot Konstruktor"
echo "=========================================="
echo ""
echo "Папка бэкапа: $BACKUP_ROOT"
echo ""

mkdir -p "$BACKUP_ROOT"

# 1. Копирование проекта (без node_modules, dist, .git)
echo "1. Копирование кода проекта..."
rsync -a --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='backups' \
  --exclude='coverage' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  "$PROJECT_ROOT/" "$BACKUP_ROOT/project/"
echo "   ✓ Код скопирован"

# 2. Копирование .env (настройки)
if [ -f "$PROJECT_ROOT/.env" ]; then
  echo "2. Копирование .env..."
  cp "$PROJECT_ROOT/.env" "$BACKUP_ROOT/project/.env"
  echo "   ✓ .env скопирован"
else
  echo "2. .env не найден — скопируйте вручную в project/.env"
fi

# 3. Выгрузка БД с сервера
echo "3. Выгрузка базы данных с сервера..."
DB_FETCHED=0
if command -v ssh &>/dev/null && ssh -o ConnectTimeout=5 -o BatchMode=yes "${SERVER_USER}@${SERVER_HOST}" "exit" 2>/dev/null; then
  # Создаём дамп на сервере и скачиваем
  REMOTE_BACKUP=$(ssh "${SERVER_USER}@${SERVER_HOST}" \
    "cd ${REMOTE_APP_DIR} && bash scripts/backup-db.sh 2>/dev/null && ls -t backups/telegram_bot_konstruktor_*.sql.gz 2>/dev/null | head -1" 2>/dev/null | tr -d '\r')
  if [ -n "$REMOTE_BACKUP" ]; then
    scp "${SERVER_USER}@${SERVER_HOST}:${REMOTE_APP_DIR}/${REMOTE_BACKUP}" "$BACKUP_ROOT/database.sql.gz" 2>/dev/null && DB_FETCHED=1
  fi
fi

if [ "$DB_FETCHED" -eq 1 ]; then
  echo "   ✓ База данных скачана: database.sql.gz"
else
  echo "   ⚠ Не удалось скачать БД автоматически (нет SSH или сервер недоступен)"
  echo "   Выполните (когда будет SSH):"
  echo "     cd $BACKUP_ROOT/project"
  echo "     bash scripts/fetch-db-from-server.sh ../database.sql.gz"
  echo ""
  touch "$BACKUP_ROOT/DB_FETCH_MANUALLY.txt"
  cat > "$BACKUP_ROOT/DB_FETCH_MANUALLY.txt" << EOF
БД нужно скачать вручную. Когда настроите SSH-доступ к серверу:

  cd $(dirname "$BACKUP_ROOT")/$(basename "$BACKUP_ROOT")/project
  bash scripts/fetch-db-from-server.sh ../database.sql.gz

Либо см. RESTORE.md для других способов.
EOF
fi

# 4. Создание инструкции по восстановлению
echo "4. Создание инструкции RESTORE.md..."
cat > "$BACKUP_ROOT/RESTORE.md" << 'RESTOREEOF'
# Восстановление Telegram Bot Konstruktor из бэкапа

## Что в бэкапе

- `project/` — полный код проекта
- `project/.env` — настройки (токены, пароли)
- `database.sql.gz` — дамп PostgreSQL (меню, пользователи, всё содержимое бота)

## Восстановление на новый сервер (Hetzner VPS)

### 1. Подготовка сервера

```bash
# Установка Docker
curl -fsSL https://get.docker.com | sh
apt-get install -y docker-compose-plugin
```

### 2. Копирование проекта

```bash
scp -r project/ root@ВАШ_СЕРВЕР:/opt/telegram-bot-konstruktor/
```

Или через git: скопируйте project/ на сервер, затем в папке проекта:

```bash
cd /opt/telegram-bot-konstruktor
# .env уже в project/, проверьте его
```

### 3. Запуск контейнеров (без восстановления БД — сначала пустая БД)

```bash
cd /opt/telegram-bot-konstruktor
docker compose -f docker-compose.prod.yml up -d
```

### 4. Восстановление базы данных

```bash
# Скопируйте database.sql.gz на сервер
scp database.sql.gz root@ВАШ_СЕРВЕР:/opt/telegram-bot-konstruktor/

# На сервере
cd /opt/telegram-bot-konstruktor
bash scripts/restore-db.sh database.sql.gz
```

Скрипт restore-db.sh остановит бота, пересоздаст БД, восстановит данные и запустит бота снова.

### 5. Проверка

- Health: http://ВАШ_IP:3000/health
- Backoffice: http://ВАШ_IP:3000/backoffice
- Бот в Telegram: /start

## Восстановление локально (для разработки)

```bash
cd project
npm install
cp .env.example .env   # или используйте сохранённый .env
nano .env              # укажите DATABASE_URL на локальный Postgres
npx prisma generate
npx prisma migrate deploy
gunzip -c ../database.sql.gz | psql -U postgres -d telegram_bot_konstruktor -h localhost
npm run dev
```

## Если database.sql.gz отсутствует

Скачайте с сервера (из папки project/ бэкапа или основного проекта):

```bash
cd project   # или cd /path/to/telegram-bot-konstruktor
bash scripts/fetch-db-from-server.sh ../database.sql.gz
```

Или вручную:

```bash
ssh root@77.42.79.54 "cd /opt/telegram-bot-konstruktor && bash scripts/backup-db.sh"
scp root@77.42.79.54:/opt/telegram-bot-konstruktor/backups/telegram_bot_konstruktor_*.sql.gz ./database.sql.gz
```
RESTOREEOF
echo "   ✓ RESTORE.md создан"

echo ""
echo "=========================================="
echo "  ✓ Бэкап готов"
echo "=========================================="
echo ""
echo "Папка: $BACKUP_ROOT"
echo ""
ls -la "$BACKUP_ROOT"
if [ -f "$BACKUP_ROOT/database.sql.gz" ]; then
  echo ""
  echo "Размер БД: $(du -h "$BACKUP_ROOT/database.sql.gz" | cut -f1)"
fi
echo ""
echo "Сохраните эту папку в безопасном месте (облако, внешний диск)."
echo ""
