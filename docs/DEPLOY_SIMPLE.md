# Деплой за 5 минут — сделай это

## Шаг 1: Открой терминал в папке проекта

```bash
cd "/Users/maksimgusev/Desktop/Автоматизация/Telegram Bot - Konstruktor"
```

## Шаг 2: Запусти скрипт деплоя

```bash
bash scripts/deploy.sh
```

## Шаг 3: Следуй подсказкам

1. **Авторизация** — откроется браузер. Войди в Railway (или зарегистрируйся на [railway.app](https://railway.app)).
2. **Создание проекта** — если спросят, выбери "Create new project".
3. **PostgreSQL и Redis** — скрипт добавит их сам.
4. **Деплой** — подожди 2–5 минут.

## Шаг 4: Получи ссылку

В конце скрипт покажет URL. Или выполни:

```bash
railway open
```

И в настройках сервиса: **Settings → Networking → Generate Domain**.

---

## Готово

- **Backoffice:** `https://твой-домен.railway.app/backoffice`  
- **Health:** `https://твой-домен.railway.app/health`

Логин в backoffice — email и пароль из твоего `.env` (BACKOFFICE_ADMIN_EMAIL, BACKOFFICE_ADMIN_PASSWORD).

---

## Если что-то пошло не так

### Ошибка "DATABASE_URL" или "REDIS_URL"

Зайди в [railway.app](https://railway.app) → твой проект → сервис приложения → **Variables**.  
Нажми **Add Reference** и подключи:
- `DATABASE_URL` от сервиса Postgres  
- `REDIS_URL` от сервиса Redis  

### Ошибка при деплое

Посмотри логи: `railway logs`

### Нужен Cloudflare перед Railway

Когда приложение работает, добавь свой домен в Cloudflare DNS:
- Тип: **CNAME**
- Имя: `app` (или любое)
- Значение: `твой-проект.railway.app`
- Proxy: включён (оранжевое облако)
