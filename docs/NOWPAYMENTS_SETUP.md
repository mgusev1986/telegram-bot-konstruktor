# Подключение NOWPayments и тест оплаты

---

## Часть 1: Регистрация в NOWPayments

1. Зайдите на **https://nowpayments.io**
2. Зарегистрируйтесь
3. В личном кабинете:
   - **Settings** → **API Keys** — создайте API Key, **скопируйте** его
   - **Settings** → **IPN** — включите IPN, укажите **IPN Callback URL** (см. ниже), скопируйте **IPN Secret**

---

## Часть 2: Переменные окружения на сервере

Отредактируйте файл `.env` **на сервере** (Hetzner):

```bash
ssh root@77.42.79.54
nano /opt/telegram-bot-konstruktor/.env
```

Добавьте или измените строки:

```
NOWPAYMENTS_API_KEY=ваш_api_key_из_nowpayments
NOWPAYMENTS_IPN_SECRET=ваш_ipn_secret_из_nowpayments
NOWPAYMENTS_IPN_CALLBACK_URL=https://admin.botzik.pp.ua/webhooks/payments/nowpayments
```

**Что куда вставить:**
- `NOWPAYMENTS_API_KEY` — API Key из NOWPayments → Settings → API Keys
- `NOWPAYMENTS_IPN_SECRET` — IPN Secret из NOWPayments → Settings → IPN
- `NOWPAYMENTS_IPN_CALLBACK_URL` — оставьте как есть (ваш backoffice URL)

Важно: если `admin.botzik.pp.ua` защищён через Cloudflare Access, webhook-путь
`/webhooks/payments/nowpayments` нужно вынести в **Bypass**. Иначе NOWPayments будет
получать редирект на `botzik.cloudflareaccess.com`, а не ваш webhook.

Сохраните (Ctrl+O, Enter, Ctrl+X).

Перезапустите бота:

```bash
cd /opt/telegram-bot-konstruktor
docker compose -f docker-compose.prod.yml restart bot
```

---

## Часть 3: IPN Callback в NOWPayments

1. В NOWPayments: **Settings** → **IPN** (Instant Payment Notification)
2. **IPN Callback URL:** вставьте:
   ```
   https://admin.botzik.pp.ua/webhooks/payments/nowpayments
   ```
3. Если в Cloudflare Access есть общий login для `admin.botzik.pp.ua`, создайте отдельный
   **Bypass** для пути:
   ```
   admin.botzik.pp.ua/webhooks/payments/nowpayments*
   ```
4. Сохраните настройки
5. Скопируйте **IPN Secret** и вставьте в `NOWPAYMENTS_IPN_SECRET` в `.env` на сервере

---

## Часть 4: Настройка в Backoffice

### 4.1. Включить платный доступ

1. Откройте **https://admin.botzik.pp.ua/backoffice**
2. Выберите бота (например, **MyTest1mg**)
3. Нажмите **Платные продукты**
4. В блоке **«Платный доступ»** включите переключатель **«Включить платные разделы»**
5. Сохраните

### 4.2. Создать продукт

1. В блоке **«Продукты»** нажмите **«Создать продукт»**
2. Заполните:
   - **Название (ru):** `Тестовый продукт`
   - **Текст кнопки (ru):** `💳 Оплатить`
   - **Кошелёк USDT BEP20:** ваш адрес кошелька (или оставьте пусто, если указан в .env)
   - **Цена:** `1` (для теста)
   - **Валюта:** `USDT`
   - **Тип:** Разовая оплата
   - **Дней доступа:** `30`
3. Нажмите **«Создать»**

### 4.3. Привязать продукт к разделу

1. В блоке **«Блокировка пунктов меню»** выберите раздел (например, «Обучение» или создайте новый)
2. В выпадающем списке **«Продукт»** выберите созданный продукт
3. Нажмите **«Заблокировать»**

---

## Часть 5: Тест

### Вариант A: Симуляция (без реальной оплаты)

1. В Backoffice → Платные продукты → напротив продукта найдите **«Симуляция оплаты»**
2. Введите **Telegram User ID** (ваш ID в Telegram — узнайте у @userinfobot)
3. Нажмите **«Симулировать оплату»**
4. Зайдите в бота — доступ к разделу должен открыться

### Вариант B: Реальная оплата через NOWPayments

1. Зайдите в бота **обычным пользователем** (не админом)
2. Откройте закрытый раздел
3. Должны появиться кнопки:
   - **«Пополнить баланс»** — создаст платёж через NOWPayments
   - **«Оплатить из баланса»** — если баланс > 0
4. Нажмите **«Пополнить баланс»** → выберите сеть (BEP20/TRC20)
5. Бот отправит ссылку/адрес для оплаты от NOWPayments
6. После оплаты NOWPayments отправит webhook → баланс зачислится автоматически
7. Нажмите **«Оплатить из баланса»** — доступ откроется

---

## Проверка webhook

### 1. Проверка самого route из приложения

На сервере:

```bash
curl -s http://localhost:3000/webhooks/payments/nowpayments
```

Ожидаемо:

```json
{"ok":true,"provider":"nowpayments","route":"/webhooks/payments/nowpayments",...}
```

### 2. Проверка публичного HTTPS через tunnel

Снаружи:

```bash
curl -i https://admin.botzik.pp.ua/webhooks/payments/nowpayments
```

Ожидаемо: `HTTP/2 200`.

Если видите `302` и редирект на `botzik.cloudflareaccess.com`, значит Bypass для webhook
ещё не настроен и NOWPayments не сможет отправлять IPN.

### 3. После реальной оплаты проверьте логи

```bash
ssh root@77.42.79.54 "docker compose -f /opt/telegram-bot-konstruktor/docker-compose.prod.yml logs bot --tail 50"
```

Ищите строки с `NOWPayments webhook request received`, `NOWPayments event received`,
`NOWPayments deposit credited`.

---

## Частые ошибки

| Проблема | Решение |
|----------|---------|
| Кнопки «Пополнить» не появляются | Проверьте NOWPAYMENTS_API_KEY и NOWPAYMENTS_IPN_SECRET в .env, перезапустите бота |
| Оплата прошла, баланс не зачислился | Проверьте NOWPAYMENTS_IPN_CALLBACK_URL в `.env`, в NOWPayments и убедитесь, что Cloudflare Access не перехватывает `/webhooks/payments/nowpayments` |
| 302 на webhook | Для `admin.botzik.pp.ua/webhooks/payments/nowpayments*` нет Bypass policy/app в Cloudflare Access |
| 404 на webhook | Проверьте, что tunnel ведёт на `localhost:3000`, а приложение отвечает на `GET /webhooks/payments/nowpayments` |
