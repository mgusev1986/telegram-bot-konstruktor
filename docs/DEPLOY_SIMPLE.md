# Деплой за 5 минут — Hetzner VPS

## Шаг 1: Открой терминал в папке проекта

```bash
cd "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor"
```

## Шаг 2: Запусти деплой

```bash
npm run deploy
```

или с сообщением коммита:

```bash
npm run deploy "Мои изменения"
```

## Шаг 3: Что происходит

1. **Git** — если есть изменения, скрипт закоммитит и запушит их.
2. **SSH** — подключение к Hetzner VPS (нужен SSH-ключ или пароль в `.env.deploy`).
3. **Бэкап БД** — перед обновлением создаётся резервная копия.
4. **Обновление** — `git pull`, сборка Docker, миграции, перезапуск бота.

---

## Настройка (.env.deploy)

Если SSH по ключу не настроен, создайте `.env.deploy` (не коммитится в git):

```
HETZNER_HOST=77.42.79.54
HETZNER_USER=root
HETZNER_APP_DIR=/opt/telegram-bot-konstruktor
HETZNER_SSH_PASSWORD=ваш_пароль
```

Или настройте SSH-ключ:

```bash
ssh-copy-id root@77.42.79.54
```

---

## Готово

- **Backoffice:** `https://ваш-домен/backoffice`
- **Health:** `https://ваш-домен/health`

---

## Логи на сервере

```bash
ssh root@77.42.79.54 "cd /opt/telegram-bot-konstruktor && docker compose -f docker-compose.prod.yml logs -f bot --tail 50"
```
