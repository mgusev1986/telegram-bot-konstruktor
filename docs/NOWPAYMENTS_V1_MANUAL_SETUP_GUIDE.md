# NOWPayments v1 — Руководство по ручной настройке

**Для alpha-owner / администратора платформы**

Интеграция v1 реализована в коде. Ниже — шаги, которые **обязательно выполнить вручную** на стороне NOWPayments, сервера и Backoffice.

---

## 1. Аккаунт NOWPayments

1. Зарегистрируйтесь на [nowpayments.io](https://nowpayments.io).
2. Получите **API Key** в личном кабинете (Settings → API Keys).
3. Включите **IPN (Instant Payment Notifications)** и задайте **IPN Secret** — случайная строка, которую вы будете хранить в `.env`.

---

## 2. Переменные окружения (.env)

Добавьте или проверьте:

```env
# Обязательно для top-up
NOWPAYMENTS_API_KEY=ваш_api_key
NOWPAYMENTS_IPN_SECRET=ваш_ipn_secret

# URL для IPN callbacks — ваш домен, куда NOWPayments будет слать webhook
NOWPAYMENTS_IPN_CALLBACK_URL=https://ваш-домен.com/webhooks/payments/nowpayments

# Для Mass Payouts (ежедневные выплаты owner'у)
NOWPAYMENTS_EMAIL=email@вашего_аккаунта.nowpayments
NOWPAYMENTS_PASSWORD=пароль_аккаунта

# Секрет для вызова payout через cron (по желанию)
NOWPAYMENTS_PAYOUT_TRIGGER_SECRET=случайная_строка_для_cron
```

- **NOWPAYMENTS_IPN_CALLBACK_URL** — URL должен быть доступен из интернета (HTTPS).
- **NOWPAYMENTS_EMAIL** и **NOWPAYMENTS_PASSWORD** — учётные данные NOWPayments для Mass Payouts API. Без них ежедневные выплаты не работают.
- **NOWPAYMENTS_PAYOUT_TRIGGER_SECRET** — задайте длинную случайную строку. Она используется для вызова endpoint выплат по cron.

---

## 3. Whitelist IP (NOWPayments Dashboard)

В личном кабинете NOWPayments добавьте в whitelist IP вашего сервера, с которого будут идти запросы к API (create payment, get status, mass payout). Иначе API может отклонять запросы.

---

## 4. IPN настройка в NOWPayments

В настройках IPN:

1. **Callback URL** — `https://ваш-домен.com/webhooks/payments/nowpayments`
2. **IPN Secret** — то же значение, что и в `NOWPAYMENTS_IPN_SECRET`
3. Включите IPN для нужных валют (например, USDT TRC20, USDT BEP20).

---

## 5. Backoffice: конфигурация бота

Для каждого бота, где нужны owner payouts:

1. Откройте **Оплаты и доступ** → **NOWPayments / Payouts**.
2. Включите:
   - **Включить NOWPayments**
   - **Owner payout включён**
   - **Ежедневные выплаты**
3. Укажите **Кошелёк owner** — адрес USDT (TRC20 или BEP20) для получения выплат.
4. При необходимости задайте **Минимум для выплаты** (USDT) — выплата выполняется только если накопленная сумма не меньше этого значения.
5. Сохраните конфиг.

---

## 5.1. Cloudflare Access: Bypass для owner-payout-trigger

Если `admin.botzik.pp.ua` защищён Cloudflare Access, добавьте **Bypass** для:
```
admin.botzik.pp.ua/webhooks/payments/owner-payout-trigger
```
(или для всего `admin.botzik.pp.ua/webhooks/payments/*`).  
Иначе cron получит редирект на логин вместо ответа приложения.

---

## 6. Cron для ежедневных выплат

В проекте нет встроенного cron. Чтобы выплаты выполнялись ежедневно:

1. Установите **NOWPAYMENTS_PAYOUT_TRIGGER_SECRET** в `.env` (длинная случайная строка).
2. Настройте системный cron (crontab, systemd timer и т.п.) на вызов:

   ```bash
   curl -X POST "https://ваш-домен.com/webhooks/payments/owner-payout-trigger?secret=ВАШ_СЕКРЕТ"
   ```

   Пример crontab (запуск в 2:00 каждый день):

   ```
   0 2 * * * curl -sS -X POST "https://ваш-домен.com/webhooks/payments/owner-payout-trigger?secret=ВАШ_СЕКРЕТ"
   ```

3. Логику времени (timezone, час) настраивайте в cron. В конфиге бота можно задать `dailyPayoutMinAmount` — выплата выполнится только при достижении минимума.

---

## 7. Whitelist адреса для Mass Payouts

В NOWPayments для Mass Payouts нужно добавить в whitelist адреса, на которые будут выполняться выплаты. Убедитесь, что кошелёк owner, указанный в Backoffice, добавлен в whitelist в личном кабинете NOWPayments.

---

## 8. Проверка работы

1. **Top-up:** создайте депозит через бота (balance flow). Убедитесь, что webhook приходит и баланс зачисляется. Проверьте в Backoffice → Платежи / баланс и в разделе Webhook logs.
2. **Settlement:** после подтверждённого top-up в секции NOWPayments должны появиться settlement entries.
3. **Payout:** либо дождитесь запуска cron, либо вручную вызовите:
   ```bash
   curl -X POST "https://ваш-домен.com/webhooks/payments/owner-payout-trigger?secret=ВАШ_СЕКРЕТ"
   ```
   Проверьте логи приложения и раздел Payout batches в Backoffice.

---

## 9. Что НЕ реализовано автоматически

- **Автоматическое планирование cron** — нужно настроить системный cron вручную (см. п. 6).
- **Whitelist IP и адресов** — выполняется в личном кабинете NOWPayments.
- **Регистрация и настройка аккаунта NOWPayments** — вручную.
- **Мониторинг статуса batch** — в коде создаётся batch и вызывается API; статус (PAID, FAILED и т.д.) можно проверять вручную через NOWPayments API или dashboard. Backoffice показывает статус из БД (SENT, FAILED).

---

## 10. Troubleshooting

| Проблема | Возможная причина |
|----------|-------------------|
| Webhook не приходит | Проверьте IPN Callback URL, IPN Secret, доступность URL извне |
| Подпись webhook невалидна | NOWPAYMENTS_IPN_SECRET должен совпадать с IPN Secret в NOWPayments |
| Payout failed | Проверьте NOWPAYMENTS_EMAIL, NOWPAYMENTS_PASSWORD, whitelist адреса |
| Нет settlement entries | У депозита должен быть botInstanceId (пользователь привязан к боту) |
| Payout skipped | Проверьте ownerPayoutEnabled, dailyPayoutEnabled, ownerWalletAddress, dailyPayoutMinAmount |

---

**Конец руководства.**
