# Резервное копирование

Система бэкапов PostgreSQL для Telegram Bot Konstruktor.

## Полный бэкап на Mac (код + БД + настройки)

Создаёт папку на рабочем столе со всем необходимым для восстановления:

```bash
bash scripts/full-backup-to-local.sh
```

Результат: `backups/full-BACKUP-YYYY-MM-DD_HH-MM-SS/` (внутри проекта)

Содержимое:
- `project/` — код + .env
- `database.sql.gz` — дамп БД (если SSH настроен)
- `RESTORE.md` — инструкция по восстановлению

Если БД не скачалась автоматически (нет SSH), выполните:

```bash
cd backups/full-BACKUP-xxx/project
bash scripts/fetch-db-from-server.sh ../database.sql.gz
```

(Потребуется ввод пароля SSH при подключении к серверу.)

## Что бэкапится

- **PostgreSQL** — все данные: шаблоны презентаций, меню, пользователи, drip-кампании, рассылки, платежи.
- **Redis** — не бэкапится (кеш и очереди BullMQ, восстанавливаются при работе).

## Быстрый старт (на сервере)

### Ручной бэкап

```bash
cd /opt/telegram-bot-konstruktor
bash scripts/backup-db.sh
```

Бэкап сохраняется в `backups/telegram_bot_konstruktor_YYYY-MM-DD_HH-MM-SS.sql.gz`.

### Автоматический бэкап (cron)

Ежедневно в 3:00 ночи:

```bash
sudo crontab -e
```

Добавьте строку:

```
0 3 * * * cd /opt/telegram-bot-konstruktor && bash scripts/backup-db.sh >> /var/log/telegram-bot-backup.log 2>&1
```

Либо для root (если приложение запущено от root):

```
0 3 * * * cd /opt/telegram-bot-konstruktor && bash scripts/backup-db.sh >> /opt/telegram-bot-konstruktor/logs/backup.log 2>&1
```

Создайте папку для логов при необходимости:

```bash
mkdir -p /opt/telegram-bot-konstruktor/logs
```

### Восстановление

```bash
cd /opt/telegram-bot-konstruktor

# Восстановить последний бэкап
bash scripts/restore-db.sh

# Восстановить конкретный файл
bash scripts/restore-db.sh backups/telegram_bot_konstruktor_2025-03-19_03-00-00.sql.gz
```

Скрипт остановит бота, пересоздаст БД, восстановит данные, применит миграции и запустит бота.

## Параметры

Переменные окружения для скриптов:

| Переменная   | По умолчанию                          | Описание                           |
|--------------|----------------------------------------|------------------------------------|
| `APP_DIR`    | `/opt/telegram-bot-konstruktor`        | Директория проекта                 |
| `BACKUP_DIR` | `$APP_DIR/backups`                     | Директория для бэкапов             |
| `COMPOSE_FILE` | `docker-compose.prod.yml`            | Файл Docker Compose                |
| `KEEP_DAILY` | `7`                                    | Сколько дневных бэкапов хранить    |

Пример: хранить 14 бэкапов:

```bash
KEEP_DAILY=14 bash scripts/backup-db.sh
```

## Внешнее хранение (рекомендуется)

Локальные бэкапы на VPS защищают от ошибок (случайный `down -v`), но не от полного отказа сервера.

### Hetzner Object Storage (S3-совместимый)

1. Создайте Object Storage в [Hetzner Cloud Console](https://console.hetzner.cloud).
2. Создайте Access Key (S3 credentials).
3. Установите `aws-cli` или `s3cmd` на сервере.
4. Добавьте в cron после бэкапа:

```bash
# После backup-db.sh — загрузить последний файл в S3
LATEST=$(ls -t /opt/telegram-bot-konstruktor/backups/*.sql.gz 2>/dev/null | head -1)
[ -n "$LATEST" ] && aws s3 cp "$LATEST" s3://your-bucket/telegram-bot-konstruktor/ --endpoint-url https://fsn1.your-objectstorage.com
```

### rsync на другой сервер

```bash
rsync -avz /opt/telegram-bot-konstruktor/backups/ user@backup-server:/backups/telegram-bot-konstruktor/
```

### Hetzner Cloud Backups

В панели Hetzner включите автоматические снимки VPS (Snapshot). Это бэкап всего диска, включая Docker volumes. Восстановление — только полное (весь сервер).
