#!/usr/bin/env bash
# Деплой на Hetzner VPS: git push + обновление бота на сервере
# Запуск: ./scripts/deploy-hetzner.sh [commit_message]
# или:   bash scripts/deploy-hetzner.sh "Мои изменения"

set -e
cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

# Конфигурация (можно переопределить через .env.deploy)
HETZNER_HOST="${HETZNER_HOST:-77.42.79.54}"
HETZNER_USER="${HETZNER_USER:-root}"
HETZNER_APP_DIR="${HETZNER_APP_DIR:-/opt/telegram-bot-konstruktor}"

# Загружаем пароль из .env.deploy (не коммитится в git)
if [ -f ".env.deploy" ]; then
  set -a
  source .env.deploy
  set +a
fi

SSH_TARGET="${HETZNER_USER}@${HETZNER_HOST}"
COMMIT_MSG="${1:-Deploy: update bot}"

echo "=========================================="
echo "  Деплой на Hetzner"
echo "  $SSH_TARGET"
echo "=========================================="
echo ""

# 1. Git: commit и push при наличии изменений
if [ -n "$(git status --porcelain)" ]; then
  echo "Шаг 1: Коммит и push..."
  git add -A
  git commit -m "$COMMIT_MSG"
  git push origin main
  echo "✓ Изменения запушены"
else
  echo "Шаг 1: Нет локальных изменений, пропуск git push"
  # Всё равно обновим сервер (на случай если push был раньше)
fi
echo ""

# 2. Бэкап БД перед деплоем (страховка)
PRE_BACKUP_CMD="cd $HETZNER_APP_DIR && (bash scripts/server-backup-rotating.sh 2>/dev/null || true)"

# 3. Выполнение команд на сервере
# Важно: миграции запускаем ДО старта бота (через run --rm), чтобы при сбое миграции
# бот не уходил в рестарт-луп, а мы видели ошибку в выводе деплоя
RUN_CMD="cd $HETZNER_APP_DIR && git pull && docker compose -f docker-compose.prod.yml build --no-cache bot && docker compose -f docker-compose.prod.yml up -d postgres redis && docker compose -f docker-compose.prod.yml run --rm bot npx prisma migrate deploy && docker compose -f docker-compose.prod.yml up -d --force-recreate bot"

echo "Шаг 2: Бэкап БД перед деплоем..."
if ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_TARGET" "echo ok" 2>/dev/null | grep -q "ok"; then
  ssh "$SSH_TARGET" "$PRE_BACKUP_CMD" 2>/dev/null || true
fi
echo ""

echo "Шаг 3: Обновление на сервере..."
echo "  $RUN_CMD"
echo ""

do_ssh() {
  ssh "$@"
}

do_sshpass() {
  sshpass -e ssh -o StrictHostKeyChecking=accept-new "$@"
}

run_full_deploy() {
  local ssh_cmd="$1"
  $ssh_cmd "$SSH_TARGET" "$PRE_BACKUP_CMD" 2>/dev/null || true
  $ssh_cmd "$SSH_TARGET" "$RUN_CMD"
}

# Проверяем, работает ли SSH по ключу
if ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_TARGET" "echo ok" 2>/dev/null | grep -q "ok"; then
  run_full_deploy "do_ssh"
  echo ""
  echo "✓ Деплой завершён"
  exit 0
fi

# SSH по ключу не сработал — пробуем с паролем через sshpass
if command -v sshpass &>/dev/null; then
  if [ -z "${HETZNER_SSH_PASSWORD}" ]; then
    echo "Ошибка: SSH по ключу не настроен, а HETZNER_SSH_PASSWORD не задан."
    echo ""
    echo "Варианты:"
    echo "  1. Создайте .env.deploy и добавьте:"
    echo "     HETZNER_SSH_PASSWORD=ваш_пароль"
    echo ""
    echo "  2. Или настройте SSH-ключ: ssh-copy-id $SSH_TARGET"
    exit 1
  fi
  export SSHPASS="${HETZNER_SSH_PASSWORD}"
  run_full_deploy "do_sshpass"
  echo ""
  echo "✓ Деплой завершён"
  exit 0
fi

# sshpass не установлен
echo "Ошибка: SSH по ключу не работает, а sshpass не установлен."
echo ""
echo "Варианты:"
echo "  1. Настройте SSH-ключ (рекомендуется):"
echo "     ssh-copy-id $SSH_TARGET"
echo ""
echo "  2. Или установите sshpass и создайте .env.deploy:"
echo "     brew install hudochenkov/sshpass/sshpass"
echo "     cp .env.deploy.example .env.deploy"
echo "     # Добавьте HETZNER_SSH_PASSWORD=ваш_пароль в .env.deploy"
echo ""
exit 1
