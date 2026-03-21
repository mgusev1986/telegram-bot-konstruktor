# Деплой на Hetzner VPS

Пошаговая инструкция для CPX11 (2 vCPU, 2 GB RAM) или CPX21 (4 GB RAM для 10k пользователей).

---

## Шаг 1: Создать VPS на Hetzner

1. Зайди на [hetzner.com](https://www.hetzner.com) → Cloud → Create Server
2. **Локация:** Falkenstein или Nuremberg (Европа)
3. **Образ:** Ubuntu 24.04
4. **Тариф:**
   - **CPX11** (2 vCPU, 2 GB) — €4.49/мес — до ~2–3k активных
   - **CPX21** (4 vCPU, 4 GB) — €7.49/мес — для 10k пользователей
5. Создай сервер, сохрани **IP-адрес** и **root-пароль**

---

## Шаг 2: Подключиться по SSH

```bash
ssh root@ВАШ_IP
```

Введи пароль при запросе.

---

## Шаг 3: Загрузить проект на сервер

### Вариант A: Через GitHub (рекомендуется)

1. Закоммить проект в GitHub (если ещё не сделано):

```bash
# На своём компьютере:
cd "/Users/maksimgusev/Desktop/Автоматизация/Telegram Bot - Konstruktor"
git add .
git commit -m "Deploy"
git remote add origin https://github.com/ВАШ_USERNAME/telegram-bot-konstruktor.git
git push -u origin main
```

2. На сервере:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/ВАШ_USERNAME/telegram-bot-konstruktor.git /opt/telegram-bot-konstruktor
cd /opt/telegram-bot-konstruktor
```

### Вариант B: Через SCP (без GitHub)

На своём компьютере:

```bash
scp -r "/Users/maksimgusev/Desktop/Автоматизация/Telegram Bot - Konstruktor" root@ВАШ_IP:/opt/telegram-bot-konstruktor
```

Затем на сервере: `cd /opt/telegram-bot-konstruktor`

---

## Шаг 4: Настроить .env

```bash
cd /opt/telegram-bot-konstruktor
cp .env.production.example .env
nano .env
```

Заполни:
- `POSTGRES_PASSWORD` — придумай надёжный пароль (32+ символов)
- `DATABASE_URL` — замени `ПАРОЛЬ_ИЗ_POSTGRES_PASSWORD` на тот же пароль
- `BOT_TOKEN`, `BOT_USERNAME` — от BotFather
- `SUPER_ADMIN_TELEGRAM_ID` — твой Telegram ID
- `BOT_TOKEN_ENCRYPTION_KEY` — случайная строка 32+ символов
- `BACKOFFICE_ADMIN_EMAIL`, `BACKOFFICE_ADMIN_PASSWORD` — вход в админку
- `BACKOFFICE_JWT_SECRET` — случайная строка 32+ символов
- `CEREBRAS_API_KEY` — ключ Cerebras

Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`

---

## Шаг 5: Запустить установку

```bash
sudo bash scripts/hetzner-setup.sh
```

Скрипт установит Docker, соберёт образы и запустит приложение.

---

## Шаг 6: Проверить работу

- **Backoffice:** `http://ВАШ_IP:3000/backoffice`
- **Health:** `http://ВАШ_IP:3000/health`

---

## Полезные команды

| Действие | Команда |
|----------|---------|
| Логи | `docker compose -f docker-compose.prod.yml logs -f` |
| Остановить | `docker compose -f docker-compose.prod.yml down` |
| Запустить | `docker compose -f docker-compose.prod.yml up -d` |
| Обновить код | `git pull && docker compose -f docker-compose.prod.yml up -d --build` |

---

## Домен и HTTPS (рекомендуется)

### Вариант A: Cloudflare Tunnel (без Nginx, порт 3000 не открыт)

См. **[docs/CLOUDFLARE_TUNNEL.md](CLOUDFLARE_TUNNEL.md)** — пошаговая инструкция.

- Домен в Cloudflare, Tunnel → `https://admin.твойдомен.com`
- Порт 3000 остаётся только на localhost
- SSL через Cloudflare, бесплатно

### Вариант B: Nginx + Certbot

1. Укажи DNS: A-запись `app.твойдомен.com` → IP сервера
2. Установи Nginx и Certbot:

```bash
apt install -y nginx certbot python3-certbot-nginx
certbot --nginx -d app.твойдомен.com
```

3. Настрой Nginx как reverse proxy на `localhost:3000`

---

## Firewall (рекомендуется)

**С Cloudflare Tunnel** (порт 3000 не открыт):

```bash
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # опционально
ufw allow 443/tcp  # опционально
# 3000 не добавляем
ufw enable
```

**Без Tunnel** (прямой доступ по IP):

```bash
ufw allow 22/tcp   # SSH
ufw allow 3000/tcp # Backoffice
ufw enable
```
