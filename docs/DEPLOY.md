# Деплой Telegram Bot Konstruktor

Проект — Node.js с PostgreSQL, Redis, BullMQ и Telegraf. Cloudflare Workers **не подходит** (нет полноценного Node.js и долгоживущих процессов).

## Варианты деплоя

| Платформа | PostgreSQL | Redis | Сложность | Рекомендация |
|-----------|------------|-------|-----------|--------------|
| **Hetzner VPS** | Docker | Docker | Низкая | ✅ Рекомендуется |
| **Render** | ✅ Blueprint | ✅ Blueprint | Низкая | Альтернатива |
| **Cloudflare Tunnel** | — | — | Средняя | Прокси к приложению на VPS/Render |

---

## 1. Деплой на Hetzner VPS

**Быстрый старт:**

```bash
npm run deploy
```

Скрипт `scripts/deploy-hetzner.sh`:
1. Коммитит и пушит изменения (если есть)
2. Подключается по SSH к серверу
3. Делает бэкап БД
4. Обновляет код, собирает Docker, применяет миграции, перезапускает бота

**Настройка** (если SSH по ключу не настроен):

Создайте `.env.deploy` (не коммитится в git):

```
HETZNER_HOST=77.42.79.54
HETZNER_USER=root
HETZNER_APP_DIR=/opt/telegram-bot-konstruktor
HETZNER_SSH_PASSWORD=ваш_пароль
```

Или настройте SSH-ключ: `ssh-copy-id root@77.42.79.54`

Подробнее: `docs/DEPLOY_GUIDE.md`, `docs/DEPLOY_SIMPLE.md`

---

## 2. Деплой на Render

1. Залейте код в GitHub.
2. На [render.com](https://render.com) → **New** → **Blueprint**.
3. Подключите репозиторий — Render подхватит `render.yaml`.
4. Укажите в Dashboard значения для переменных с `sync: false`:
   - `SUPER_ADMIN_TELEGRAM_ID`
   - `BACKOFFICE_ADMIN_EMAIL`
   - `BACKOFFICE_ADMIN_PASSWORD`
   - `CEREBRAS_API_KEY`
   - `BOT_TOKEN`, `BOT_USERNAME` (если есть дефолтный бот)
5. Нажмите **Apply** — создадутся PostgreSQL, Redis и веб-сервис.
6. URL будет вида `telegram-bot-konstruktor.onrender.com`.

---

## 3. Cloudflare перед приложением

### Вариант A: DNS + прокси (без Tunnel)

Если приложение уже на VPS/Render:

1. Добавьте домен в Cloudflare (DNS).
2. Создайте CNAME: `app` → IP или домен вашего VPS (или `xxx.onrender.com`).
3. Включите оранжевое облако (прокси) — трафик пойдёт через Cloudflare (DDoS, SSL).

### Вариант B: Cloudflare Tunnel

Когда нужно скрыть origin (без белого IP) или использовать Zero Trust:

1. Установите `cloudflared`:
   ```bash
   brew install cloudflared  # macOS
   ```
2. Авторизация:
   ```bash
   cloudflared tunnel login
   ```
3. Создание туннеля:
   ```bash
   cloudflared tunnel create telegram-bot-konstruktor
   cloudflared tunnel route dns telegram-bot-konstruktor app.example.com
   ```
4. Конфиг — скопируйте `.cloudflared/config.yml.example` в `config.yml`, подставьте `tunnel` ID и `credentials-file`.
5. Запуск (например, на VPS рядом с приложением или в отдельном процессе):
   ```bash
   cloudflared tunnel run telegram-bot-konstruktor
   ```
6. `service` в конфиге укажите на URL вашего приложения, например:
   ```yaml
   service: https://ваш-домен.com
   ```
   Или `http://localhost:3000`, если cloudflared и приложение на одной машине.

---

## 4. Production переменные

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `DATABASE_URL` | да | Строка подключения PostgreSQL |
| `REDIS_URL` | да | URL Redis |
| `SUPER_ADMIN_TELEGRAM_ID` | да | Telegram ID суперадмина |
| `BOT_TOKEN_ENCRYPTION_KEY` | да | Ключ шифрования токенов (32+ символов) |
| `BACKOFFICE_JWT_SECRET` | да | Секрет для JWT backoffice |
| `BOT_TOKEN` / `BOT_USERNAME` | для старта | Токен и username дефолтного бота |
| `BACKOFFICE_ADMIN_EMAIL` / `_PASSWORD` | для входа | Первый админ backoffice |
| `TRANSLATION_PROVIDER` | рекоменд. | `cerebras` (без Ollama в проде) |
| `CEREBRAS_API_KEY` | при cerebras | Ключ Cerebras API |
| `NODE_ENV` | рекоменд. | `production` |

---

## 5. Проверка после деплоя

1. **Health**: `https://ваш-домен/health` → `{"ok":true,"timestamp":"..."}`.
2. **Backoffice**: `https://ваш-домен/backoffice` — вход по email/паролю.
3. **Telegram**: бот отвечает в чате при long-polling (webhook не обязателен).
4. **Webhooks**: для платежей — `POST /webhooks/payments/crypto` должен быть доступен по HTTPS.

---

## 6. Почему не Cloudflare Workers

- Нет полноценного Node.js и нативных модулей.
- Нет долгоживущих TCP-соединений к PostgreSQL и Redis.
- BullMQ и Telegraf требуют постоянно работающего процесса.
- Cloudflare Containers (бета) могут засыпать — фоновые job'ы будут теряться.

Поэтому приложение размещается на VPS (Hetzner) или Render и при необходимости выставляется через Cloudflare (DNS/прокси или Tunnel).
