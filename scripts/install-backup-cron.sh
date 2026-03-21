#!/usr/bin/env bash
# Установка cron для автобэкапов на сервере
# Запускать НА СЕРВЕРЕ (root): bash scripts/install-backup-cron.sh
#
# Или с Mac одной командой:
#   ssh root@77.42.79.54 "cd /opt/telegram-bot-konstruktor && bash scripts/install-backup-cron.sh"

set -e

APP_DIR="${APP_DIR:-/opt/telegram-bot-konstruktor}"
CRON_LINE="0 */2 * * * cd $APP_DIR && bash scripts/server-backup-rotating.sh >> /var/log/telegram-bot-backup.log 2>&1"

cd "$APP_DIR"

if [ ! -f scripts/server-backup-rotating.sh ]; then
  echo "Ошибка: scripts/server-backup-rotating.sh не найден. Запустите из корня проекта." >&2
  exit 1
fi

# Проверяем, есть ли уже эта задача
if crontab -l 2>/dev/null | grep -q "server-backup-rotating"; then
  echo "Cron для бэкапов уже установлен."
  crontab -l | grep server-backup-rotating
  exit 0
fi

# Создаём лог-файл
touch /var/log/telegram-bot-backup.log 2>/dev/null || true

# Добавляем в crontab
(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -

echo "✓ Cron установлен: бэкап каждые 2 часа"
echo ""
echo "Строка в crontab:"
echo "  $CRON_LINE"
echo ""
echo "Проверить: crontab -l"
echo "Логи: tail -f /var/log/telegram-bot-backup.log"
echo ""
echo "Тестовый запуск:"
echo "  cd $APP_DIR && bash scripts/server-backup-rotating.sh"
echo ""
