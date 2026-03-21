# NOWPayments Balance-Based Payment — Analysis & Implementation

## Analysis Summary: Balance-Based Payment Flow via NOWPayments

## 1. Текущая архитектура

### Product / Payment / Access / linkedChats

| Сущность | Роль |
|----------|------|
| **Product** | code, type, price, currency, billingType, durationDays, linkedChats (JSON) |
| **Payment** | userId, productId, provider (CRYPTO/MANUAL), network, walletAddress, amount, referenceCode, status, externalTxId |
| **UserAccessRight** | userId, productId, accessType, activeFrom, activeUntil, status |
| **AccessRule** | PRODUCT_PURCHASE (productId), evaluateProduct() |
| **MenuItem** | productId, accessRuleId; locked = !allowedByRule || !allowedByProduct |

### Текущий paywall flow

1. User открывает locked раздел → `content.locked = true`
2. `buildPaywallKeyboard` показывает одну кнопку: "💳 Оплатить USDT (BEP20)" → `pay:network:productId:USDT_BEP20`
3. Callback `pay:network` → `createPaymentRequest` → shared wallet (env), referenceCode
4. Пользователь видит: amount, wallet, reference; "Запросить проверку оплаты"
5. Webhook `/webhooks/payments/crypto` (body: referenceCode, status, externalTxId) → `confirmPaymentByReference`
6. confirmPayment → UserAccessRight, subscriptionChannel.onAccessGranted, CRM tag

### Текущие ограничения

- Один общий кошелёк на всех (USDT_BEP20_WALLET, USDT_TRC20_WALLET)
- Нет balance, нет deposit flow — прямой product → payment
- Нет per-user payment circuit; ручная проверка админом
- Webhook ожидает referenceCode (наш UUID), а NOWPayments шлёт payment_id, order_id

---

## 2. NOWPayments API (актуальные endpoints)

### Используемые endpoints

| Endpoint | Назначение |
|----------|------------|
| `POST /v1/payment` | Создание платежа — получаем pay_address, pay_amount, pay_currency |
| `GET /v1/payment/{payment_id}` | Проверка статуса |
| IPN (webhook) | Callback при смене статуса; x-nowpayments-sig = HMAC-SHA512(sorted_body, IPN_SECRET) |

### Параметры createPayment (из @nowpaymentsio/nowpayments-api-js)

- `price_amount` (required): сумма в fiat/crypto, которую видит пользователь
- `price_currency` (required): USDT
- `pay_amount` (optional): точная сумма в pay_currency
- `pay_currency` (required): USDTTRC20, USDTBEP20 и т.д.
- `ipn_callback_url` (optional): наш URL
- `order_id` (required для идемпотентности): наш id — depositTransactionId
- `fixed_rate` (optional): true — фиксируем курс (Variant A)
- `order_description` (optional)

### Variant A (комиссия на нас)

- `fixed_rate: true` — пользователь платит ровно `price_amount` в `pay_currency`
- NOWPayments вычитает комиссию на своей стороне; мы зачисляем пользователю `price_amount` на внутренний баланс
- Логика: при IPN `payment_status=finished` credit = price_amount из payload (или order metadata)

### IPN payload (типичный)

- `payment_id`, `payment_status`, `pay_address`, `price_amount`, `pay_amount`, `order_id`, `outcome_amount`, `outcome_currency`
- `payment_status`: `waiting` | `confirming` | `confirmed` | `sending` | `partially_paid` | `finished` | `failed` | `refunded` | `expired`
- Для зачисления: `finished` (или `confirmed` в зависимости от политики — используем `finished`)

### Верификация IPN

1. Сортировать keys body по алфавиту
2. HMAC-SHA512(JSON.stringify(sorted_body), IPN_SECRET)
3. Сравнить с header `x-nowpayments-sig`

---

## 3. Новые сущности (минимальный набор)

| Модель | Назначение |
|--------|------------|
| **UserBalanceAccount** | 1:1 с User, balance (Decimal), currency |
| **BalanceLedgerEntry** | CREDIT/DEBIT/ADJUSTMENT; referenceId, referenceType |
| **DepositTransaction** | userId, providerPaymentId (NOWPayments payment_id), orderId (idempotency), amount, status |
| **ProductPurchase** | userId, productId, amount, balanceLedgerEntryId, status |
| **WithdrawalRequest** | userId, amount, status, requestedAt |
| **ProviderEventLog** | providerTxId unique, rawPayload, status, processedAt |

### Переиспользование

- **Payment** — оставляем для legacy/manual flow; новый flow идёт через DepositTransaction + ProductPurchase
- **UserAccessRight** — без изменений; выдаётся при ProductPurchase COMPLETED
- **Product** — без изменений
- **SubscriptionChannelService** — без изменений; вызывается при grant access

---

## 4. Точки интеграции

| Место | Изменение |
|-------|-----------|
| `prisma/schema.prisma` | Новые модели |
| `src/config/env.ts` | NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, NOWPAYMENTS_BASE_URL |
| `src/http/server.ts` | Новый route /webhooks/payments/nowpayments |
| `src/modules/payments/` | BalanceService, NowPaymentsAdapter; расширение PaymentService |
| `src/app/services.ts` | Добавить BalanceService |
| `src/modules/access/` | Без изменений (evaluateProduct по UserAccessRight) |
| `src/modules/cabinet/` | Показать баланс, кнопка refund request |
| `src/bot/register-bot.ts` | Новые callbacks: pay:deposit, pay:balance, pay:check_status |
| `src/bot/keyboards.ts` | buildPaywallKeyboard с "Пополнить" и "Оплатить из баланса" |

---

## 5. Риски и миграция

- **Регрессия**: сохраняем старый webhook `/webhooks/payments/crypto` для manual/legacy
- **Feature flag**: NOWPayments включается через env (NOWPAYMENTS_API_KEY есть → balance flow)
- **Миграция**: новые таблицы; Payment не трогаем; UserAccessRight — общий источник доступа
- **Дублирование webhook**: ProviderEventLog.providerTxId unique + идемпотентная обработка
