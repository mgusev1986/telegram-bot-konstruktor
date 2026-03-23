# Диагностика 404 на POST /webhooks/payments/owner-payout-trigger

Если при вызове `POST /webhooks/payments/owner-payout-trigger?secret=...` сервер возвращает **404 Route not found**, пройдите по чеклисту ниже.

---

## 1. Добавлен ли GET handler для проверки

В коде добавлен **GET** `/webhooks/payments/owner-payout-trigger`, который всегда отвечает (не требует secret). Это нужно для проверки, задеплоен ли маршрут.

**Проверка (без secret):**
```bash
curl -s https://admin.botzik.pp.ua/webhooks/payments/owner-payout-trigger
```

**Ожидаемый ответ при новом коде:**
```json
{"ok":true,"route":"/webhooks/payments/owner-payout-trigger","message":"Use POST with ?secret=xxx to trigger payout","configured":true}
```
или `"configured":false` если `NOWPAYMENTS_PAYOUT_TRIGGER_SECRET` не задан.

- Если получаете такой JSON → маршрут **есть**, код v1 задеплоен. Тогда POST 404 — странно (проверьте, что вызываете именно POST).
- Если получаете **404** или другую страницу → маршрут **не зарегистрирован**, на проде крутится старая версия.

---

## 2. Задеплоены ли изменения NOWPayments v1

- Убедитесь, что коммиты с `owner-payout-trigger` есть в ветке `main` (или той, с которой деплоите).
- Выполните `git log --oneline -5` и проверьте наличие коммитов с route/owner-payout/nowpayments.

---

## 3. Есть ли route в продовой сборке

На сервере Hetzner:

```bash
ssh root@77.42.79.54  # или ваш HETZNER_HOST
cd /opt/telegram-bot-konstruktor
git log -1 --oneline
grep -r "owner-payout-trigger" src/
```

Если `grep` ничего не находит — на сервере старая версия репозитория.

---

## 4. Применена ли миграция Prisma

Миграция `20260326120000_add_nowpayments_v1_owner_settlement` добавляет `PaymentWebhookLog`, `BotPaymentProviderConfig`, `OwnerSettlementEntry`, `OwnerPayoutBatch`.

На сервере:

```bash
cd /opt/telegram-bot-konstruktor
docker compose -f docker-compose.prod.yml run --rm bot npx prisma migrate status
```

Если миграция не применена — приложение может падать при обращении к новым моделям (но тогда обычно не было бы 404, а 500 или crash).

---

## 5. Перезапущен ли backend после деплоя

Проверьте время последнего перезапуска контейнера:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
```

При `deploy-hetzner.sh` используется `docker compose up -d --force-recreate bot`, контейнер должен пересоздаваться. Если деплой выполнялся без `--force-recreate` или вручную без пересборки — может крутиться старый образ.

**Ручной редеплой:**
```bash
cd /opt/telegram-bot-konstruktor
git pull
docker compose -f docker-compose.prod.yml build --no-cache bot
docker compose -f docker-compose.prod.yml run --rm bot npx prisma migrate deploy
docker compose -f docker-compose.prod.yml up -d --force-recreate bot
```

---

## 6. Cloudflare Access и путь webhook

`admin.botzik.pp.ua` может быть защищён Cloudflare Access. Для `owner-payout-trigger` нужен **Bypass**, иначе запросы будут редиректиться на логин.

В Cloudflare Zero Trust → Access → Applications:

- Найдите приложение для `admin.botzik.pp.ua`.
- Добавьте **Bypass** для пути:
  ```
  admin.botzik.pp.ua/webhooks/payments/owner-payout-trigger
  ```
  или для всего webhook-пути:
  ```
  admin.botzik.pp.ua/webhooks/payments/*
  ```

Без bypass cron получит редирект на страницу входа, а не ответ от вашего приложения.

---

## 7. Переменная NOWPAYMENTS_PAYOUT_TRIGGER_SECRET

В `.env` на сервере должно быть:

```env
NOWPAYMENTS_PAYOUT_TRIGGER_SECRET=ваша_длинная_случайная_строка
```

Без неё POST вернёт **400** с сообщением `Payout trigger not configured`, а не 404. Если видите 404 — маршрут, скорее всего, не зарегистрирован (см. п. 1).

---

## Краткий порядок действий

1. Вызвать **GET** `/webhooks/payments/owner-payout-trigger` и проверить ответ (см. п. 1).
2. Убедиться, что код с route задеплоен (git на сервере, пересборка образа).
3. Добавить Bypass в Cloudflare Access для `/webhooks/payments/owner-payout-trigger` (или `/webhooks/payments/*`).
4. Задать `NOWPAYMENTS_PAYOUT_TRIGGER_SECRET` в `.env`.
5. Пересобрать и перезапустить контейнер (см. п. 5).
