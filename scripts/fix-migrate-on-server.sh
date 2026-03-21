#!/usr/bin/env bash
# Быстрый фикс: применить миграции и перезапустить бота на сервере
# Используйте, если бот не работает после деплоя (миграция не применилась)
#
# Запуск: ./scripts/fix-migrate-on-server.sh

set -e
cd "$(dirname "$0")/.."

if [ -f ".env.deploy" ]; then
  set -a
  source .env.deploy
  set +a
fi

HETZNER_HOST="${HETZNER_HOST:-77.42.79.54}"
HETZNER_USER="${HETZNER_USER:-root}"
HETZNER_APP_DIR="${HETZNER_APP_DIR:-/opt/telegram-bot-konstruktor}"
SSH_TARGET="${HETZNER_USER}@${HETZNER_HOST}"

echo "Применение миграций и перезапуск бота на $SSH_TARGET"
echo ""

ssh "$SSH_TARGET" "cd $HETZNER_APP_DIR && \
  docker compose -f docker-compose.prod.yml up -d postgres redis && \
  docker compose -f docker-compose.prod.yml run --rm bot npx prisma migrate deploy && \
  docker compose -f docker-compose.prod.yml up -d --force-recreate bot"

echo ""
echo "✓ Готово. Проверьте логи: ssh $SSH_TARGET 'cd $HETZNER_APP_DIR && docker compose -f docker-compose.prod.yml logs -f bot'"
