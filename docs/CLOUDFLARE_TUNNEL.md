# Cloudflare Tunnel — HTTPS для Backoffice на Hetzner

Безопасный доступ к backoffice через HTTPS без открытия порта 3000 наружу.

---

## Analysis Summary

| Компонент | Результат анализа |
|-----------|-------------------|
| **Docker compose** | `docker-compose.prod.yml`: bot публикует 3000:3000; postgres/redis только в botnet |
| **Слушает 3000** | Fastify в контейнере `0.0.0.0:3000`; Docker маппит на хост |
| **Reverse proxy** | Отсутствует — прямой доступ по IP |
| **Firewall** | В hetzner-setup не настраивается; порт 3000 открыт |
| **Cookie/Session** | `Secure` включается при `NODE_ENV=production` — ОК для HTTPS |
| **Webhooks** | `/webhooks/payments/nowpayments`, `/webhooks/payments/crypto` — на том же порту |
| **Публичный URL** | Фиксируется в `NOWPAYMENTS_IPN_CALLBACK_URL` (env) и Cloudflare hostname |

**Изменения (минимальные):** порт `127.0.0.1:3000:3000`, docs, скрипт cloudflared, firewall рекомендации. Приложение и deploy flow не трогаем.

---

## Анализ текущего setup

| Компонент | Текущее состояние |
|-----------|-------------------|
| **docker-compose.prod.yml** | bot публикует `3000:3000` — порт доступен снаружи |
| **Приложение** | Fastify слушает `0.0.0.0:3000` внутри контейнера |
| **Reverse proxy** | Нет (прямой доступ по IP:3000) |
| **Firewall** | Не настроен в hetzner-setup (порт 3000 открыт) |
| **Cookie Secure** | Включён при `NODE_ENV=production` |
| **Webhooks** | `/webhooks/payments/nowpayments`, `/webhooks/payments/crypto` на том же порту |

## Целевая архитектура

```
Интернет → Cloudflare (HTTPS) → Tunnel → localhost:3000
                                      ↑
                           cloudflared на хосте
                           bot (Docker) отдаёт только на 127.0.0.1:3000
```

- Порт 3000 **не доступен** снаружи (только localhost).
- Доступ только через `https://admin.MY_DOMAIN.com`.

---

# Часть 1: Ручные шаги в Cloudflare Dashboard

Выполните **до** установки cloudflared на сервере.

## Шаг 1.1: Добавить домен в Cloudflare

1. Зайдите на [dash.cloudflare.com](https://dash.cloudflare.com)
2. **Add site** → введите ваш домен (например `example.com`)
3. Выберите **Free** план
4. Cloudflare покажет NS-записи — обновите их у регистратора домена
5. Дождитесь активного статуса (оранжевое облако)

## Шаг 1.2: Создать Tunnel

1. В левом меню: **Zero Trust** (или **Networks** → **Tunnels**)
   - Если Zero Trust не активен: [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Access** → **Tunnels**
2. **Create a tunnel** → **Cloudflared**
3. Имя: `telegram-bot-konstruktor` (или любое)
4. **Save tunnel** — появится **Tunnel token** (длинная строка, начинается с `eyJ...`)

**Сохраните tunnel token** — он понадобится для systemd.

## Шаг 1.3: Привязать Public Hostname

1. В настройках созданного tunnel → **Public Hostname**
2. **Add a public hostname**:
   - **Subdomain:** `admin` (или другое) → получится `admin.MY_DOMAIN.com`
   - **Domain:** выберите ваш домен
   - **Service type:** `HTTP`
   - **URL:** `localhost:3000` (cloudflared на сервере подключится к этому адресу)
3. **Save hostname**

После этого tunnel в Dashboard будет в статусе "Pending" до тех пор, пока cloudflared не подключится на сервере.

## Шаг 1.4: Если backoffice защищён Cloudflare Access — исключить webhook из login flow

Если вы защищаете `admin.MY_DOMAIN.com` через Cloudflare Access, **не пускайте NOWPayments
через общий login challenge**. Для webhook нужен публичный POST без email-кода.

Сделайте отдельное правило/app для пути:

```text
admin.MY_DOMAIN.com/webhooks/payments/nowpayments*
```

Рекомендуемый вариант:

1. **Zero Trust** → **Access** → **Applications**
2. Создайте отдельное Self-hosted приложение для
   `admin.MY_DOMAIN.com/webhooks/payments/nowpayments*`
3. Политика: **Bypass**
4. Убедитесь, что это правило стоит **выше** общего приложения на `admin.MY_DOMAIN.com/*`

Итог:

- `https://admin.MY_DOMAIN.com/backoffice` остаётся под Cloudflare Access
- `https://admin.MY_DOMAIN.com/webhooks/payments/nowpayments` доступен публично для NOWPayments

---

# Часть 2: Установка и настройка на сервере

## Шаг 2.1: Установить cloudflared

На сервере (Hetzner):

```bash
# Скачать и установить
curl -L --output /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

## Шаг 2.2: Создать systemd service

### Вариант A: Скрипт (рекомендуется)

```bash
# На сервере, после получения token из Cloudflare Dashboard
cd /opt/telegram-bot-konstruktor
sudo bash scripts/cloudflared-install.sh YOUR_TUNNEL_TOKEN
```

### Вариант B: Вручную

Создайте token file и service:

```bash
sudo mkdir -p /etc/cloudflared
echo "TUNNEL_TOKEN=ваш_token_из_шага_1.2" | sudo tee /etc/cloudflared/tunnel-token.env
sudo chmod 600 /etc/cloudflared/tunnel-token.env

sudo tee /etc/systemd/system/cloudflared-tunnel.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel for Telegram Bot Konstruktor
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cloudflared/tunnel-token.env
ExecStart=/usr/local/bin/cloudflared tunnel run --token ${TUNNEL_TOKEN}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable cloudflared-tunnel
sudo systemctl start cloudflared-tunnel
sudo systemctl status cloudflared-tunnel
```

## Шаг 2.3: Проверить связь

В логах cloudflared должно быть:
```
INF Connection established
```

В Cloudflare Dashboard статус tunnel сменится на **Healthy**.

---

# Часть 3: Изменения в проекте (применены в репозитории)

## 3.1 Docker: привязка порта к localhost

В `docker-compose.prod.yml` порт изменён на `127.0.0.1:3000:3000` — доступ только с хоста, не извне.

**После обновления репозитория** выполните на сервере:

```bash
cd /opt/telegram-bot-konstruktor
git pull
docker compose -f docker-compose.prod.yml up -d --force-recreate bot
```

## 3.2 Firewall: не пускать трафик на 3000 снаружи

```bash
# На сервере
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # опционально, если нужен HTTP
sudo ufw allow 443/tcp  # Cloudflare Tunnel использует outbound, но на всякий случай
# 3000 НЕ добавляем — доступ только через tunnel
sudo ufw enable
sudo ufw status
```

## 3.3 Переменные окружения

В `.env` на сервере:

```bash
NODE_ENV=production
# Cookie Secure включится автоматически
```

Для NOWPayments (если используете):

```bash
NOWPAYMENTS_IPN_CALLBACK_URL=https://admin.MY_DOMAIN.com/webhooks/payments/nowpayments
```

Подставьте ваш реальный домен вместо `admin.MY_DOMAIN.com`.

---

# Часть 4: Проверки

## Локально на сервере

```bash
# Приложение живо
curl -s http://localhost:3000/health
# Ожидаемо: {"ok":true,"timestamp":"..."}

# Tunnel работает
sudo systemctl status cloudflared-tunnel
```

## Снаружи (HTTPS)

```bash
# Health
curl -s https://admin.MY_DOMAIN.com/health

# Backoffice (в браузере)
open https://admin.MY_DOMAIN.com/backoffice
```

## Webhooks

NOWPayments будет слать IPN на:
```
https://admin.MY_DOMAIN.com/webhooks/payments/nowpayments
```

Убедитесь, что `NOWPAYMENTS_IPN_CALLBACK_URL` в .env совпадает.
Также убедитесь, что этот путь **не редиректит** на `botzik.cloudflareaccess.com`.

---

# Часть 5: Rollback

Если что-то пошло не так:

1. **Вернуть порт наружу** (временно):
   ```bash
   # В docker-compose.prod.yml вернуть ports: ["3000:3000"]
   cd /opt/telegram-bot-konstruktor
   git checkout HEAD -- docker-compose.prod.yml
   docker compose -f docker-compose.prod.yml up -d --force-recreate bot
   ```
   Доступ снова по `http://SERVER_IP:3000`.

2. **Остановить tunnel**:
   ```bash
   sudo systemctl stop cloudflared-tunnel
   sudo systemctl disable cloudflared-tunnel
   ```

3. **Откатить firewall** (если блокировали 3000 и нужно снова открыть):
   ```bash
   sudo ufw allow 3000/tcp
   sudo ufw reload
   ```

---

# Чеклист

- [ ] Домен добавлен в Cloudflare, NS обновлены
- [ ] Tunnel создан, token сохранён
- [ ] Public hostname `admin.MY_DOMAIN.com` → `http://localhost:3000`
- [ ] cloudflared установлен, systemd service создан с token
- [ ] `docker-compose.prod.yml` обновлён (127.0.0.1:3000)
- [ ] `docker compose up -d` выполнен
- [ ] ufw настроен (22, без 3000)
- [ ] `NODE_ENV=production` в .env
- [ ] `NOWPAYMENTS_IPN_CALLBACK_URL` указан (если нужен)
- [ ] https://admin.MY_DOMAIN.com/health возвращает OK
- [ ] https://admin.MY_DOMAIN.com/backoffice открывается
