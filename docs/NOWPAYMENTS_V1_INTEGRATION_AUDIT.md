# NOWPayments v1 Integration — Этап 1: Codebase Audit

**Дата:** 2025-03-23  
**Статус:** Завершён  
**Изменений в коде:** нет (audit only)

---

## 1. Существующие модели Prisma

### 1.1 Payment (product purchase flow)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid | PK |
| userId | string | FK → User |
| productId | string | FK → Product |
| botInstanceId | string? | FK → BotInstance |
| provider | PaymentProvider | CRYPTO \| MANUAL |
| network | PaymentNetwork | USDT_TRC20 \| USDT_BEP20 \| TON \| OTHER |
| walletAddress | string | Реквизиты для оплаты |
| amount | Decimal | Сумма |
| currency | string | |
| status | PaymentStatus | UNPAID \| PENDING \| PAID \| EXPIRED \| REFUNDED \| CANCELLED |
| referenceCode | string | Unique, для webhook manual |
| externalTxId | string? | Hash/ID транзакции от пользователя |
| paidAt | DateTime? | |
| expiresAt | DateTime? | |
| createdAt, updatedAt | DateTime | |

**Назначение:** Покупка продукта через invoice/manual confirmation. НЕ используется для balance top-up.

### 1.2 DepositTransaction (balance top-up flow)

| Поле | Тип | Описание |
|------|-----|----------|
| id | uuid | PK |
| userId | string | FK → User |
| accountId | string | FK → UserBalanceAccount |
| provider | string | default: "nowpayments" |
| providerPaymentId | string? | Unique, NOWPayments payment_id |
| orderId | string | Unique, idempotency key |
| amount | Decimal | Сумма |
| currency | string | default: USDT |
| status | DepositTransactionStatus | PENDING \| CONFIRMED \| FAILED \| DUPLICATE \| IGNORED |
| rawPayload | Json? | Ответ от NOWPayments |
| creditedAt | DateTime? | Время зачисления |
| ledgerEntryId | string? | FK → BalanceLedgerEntry |
| createdAt, updatedAt | DateTime | |

**Отсутствует:** botInstanceId (выводится из user.botInstanceId), outcome_amount, processor_fee, owner accrual поля.

**Формат orderId:** `dep_${userId}_${Date.now()}_${uuid.slice(0,8)}`

### 1.3 UserBalanceAccount

| Поле | Тип |
|------|-----|
| id | uuid |
| userId | string (unique) |
| balance | Decimal |
| currency | string (default USDT) |
| createdAt, updatedAt | DateTime |

### 1.4 BalanceLedgerEntry

| Поле | Тип |
|------|-----|
| id | uuid |
| accountId | string |
| type | BalanceLedgerEntryType (CREDIT, DEBIT, ADJUSTMENT, ...) |
| amount | Decimal |
| balanceAfter | Decimal? |
| referenceType | string |
| referenceId | string |
| metadata | Json? |
| createdAt | DateTime |

### 1.5 ProductPurchase

Покупка продукта с баланса. idempotencyKey = `purchase_${userId}_${productId}` (или с uuid для renewable).

### 1.6 ProviderEventLog (webhook idempotency)

| Поле | Тип |
|------|-----|
| id | uuid |
| provider | string (default nowpayments) |
| providerTxId | string |
| orderId | string? |
| rawPayload | Json |
| status | string (received, processing, processed, ignored) |
| processedAt | DateTime? |
| errorMessage | string? |
| createdAt | DateTime |

**Unique:** (provider, providerTxId)

### 1.7 Отсутствующие модели для v1

- **OwnerSettlementEntry** — accrual на успешный top-up
- **OwnerPayoutBatch** — дневная batch-выплата
- **PaymentWebhookLog** (опционально) — raw log с headers/body/signature (можно расширить ProviderEventLog)
- **Per-bot payment config** — provider settings, owner wallet, payout params

---

## 2. Текущий Payment Flow

### 2.1 Legacy (Product Purchase via Invoice)

```
User → Locked Section → "Оплатить" (если balance flow OFF)
  → PaymentService.createPaymentRequest()
  → Payment (PENDING), wallet from Product.walletBep20 / env
  → User оплачивает на кошелёк
  → Подтверждение: backoffice вручную ИЛИ /webhooks/payments/crypto
  → confirmPayment() → grantOrExtendAccess(), UserAccessRight, User.status=PAID
  → PROCESS_PAYMENT_EXPIRY job для истёкших
```

**Файлы:** `payment.service.ts`, `register-bot.ts` (showDirectCheckoutScreen), `server.ts` (crypto webhook)

### 2.2 Balance-based (NOWPayments Top-up)

```
User → Locked Section → "Оплатить" (если balance flow ON)
  → pay:checkout:productId → showBalanceCheckoutScreen()
  → BalanceService.createDepositIntent(user, productPrice, currency, network)
  → orderId = dep_${userId}_${timestamp}_${uuid}
  → NowPaymentsAdapter.createPayment()
  → DepositTransaction (PENDING) создаётся
  → Экран checkout с payAddress, payAmount
  → IPN: POST /webhooks/payments/nowpayments
  → processNowPaymentsIpn() → ProviderEventLog (idempotency)
  → При status=finished: credit UserBalanceAccount, DepositTransaction→CONFIRMED
  → Уведомление пользователю
  → Кнопка "Оплатить из баланса" → purchaseFromBalance()
```

**Кредит баланса:** используется `price_amount` из payload (не `outcome_amount`). По ТЗ v1: `creditedBalanceAmount = actualOutcomeAmount`.

---

## 3. Текущий Balance Flow

- **Пополнение:** DepositTransaction → CREDIT в BalanceLedgerEntry (referenceType: "deposit")
- **Списание:** ProductPurchase → DEBIT (referenceType: "product_purchase")
- **Проверка статуса:** `checkDepositStatus(depositIdOrOrderId)` — при PENDING вызывает getPaymentStatus и processTrustedNowPaymentsPayload
- **Fallback:** если NOWPayments disabled или createDepositIntent вернул null → direct manual Payment flow

---

## 4. Paid / Backoffice Flow

**Страница:** `/backoffice/bots/:botId/paid`

**Уже есть:**
- Products, walletBep20, paidAccessEnabled, paywallMessage
- recentPayments, recentDeposits, recentPurchases, recentAccessRights
- balanceFlowEnabled = runtime.services.balance.isNowPaymentsEnabled()
- simulate payment, archive product, toggle paid access
- Payment events table, Access rights table

**Нет:**
- Per-bot NOWPayments config (provider, owner wallet, pay currency, payout settings)
- Settlement summary (pending owner earnings, paid today, failed batches)
- OwnerSettlementEntry list
- OwnerPayoutBatch list
- PaymentWebhookLog / ProviderEventLog viewer

---

## 5. Jobs / Scheduler / Workers

**JobType enum:** SEND_BROADCAST, SEND_BROADCAST_BATCH, SEND_DRIP_STEP, SEND_NOTIFICATION, PROCESS_PAYMENT_EXPIRY, SEND_INACTIVITY_REMINDER, GENERATE_LANGUAGE_VERSION_AI, SEND_SUBSCRIPTION_REMINDER, PROCESS_ACCESS_EXPIRY

**Нет:** PROCESS_OWNER_DAILY_PAYOUTS

**Файлы:**
- `scheduler.service.ts` — schedule(), enqueue(), cancelByIdempotencyKeyPrefix
- `workers.ts` — обработка ScheduledJob по jobType
- `constants.ts` — QUEUE_NAMES.scheduled = "scheduled-jobs"

**Cron/повтор:** нет встроенного cron для daily payouts. Job создаётся через schedule(runAt). Для daily payout нужен внешний триггер (cron процесс, или отдельный worker с setInterval).

---

## 6. Bot UI / Paid Flow

**Locked section:** `buildLockedSectionKeyboard` — одна кнопка "Оплатить" → pay:checkout:productId

**buildPaywallKeyboard** (с "Пополнить баланс" и "Оплатить из баланса") — определён в keyboards.ts, но **не используется** в showLockedSectionScreen.

**Callbacks:**
- pay:checkout:productId → showBalanceCheckoutScreen
- pay:deposit:productId → showBalanceCheckoutScreen (тот же экран)
- pay:balance:productId → purchaseFromBalance
- pay:check:depositId → checkDepositStatus
- pay:network:productId:USDT_BEP20 → showBalanceCheckoutScreen
- pay:review:paymentId → alert "автоподтверждение включено"

**Cabinet:** показывает баланс, но кнопки пополнения нет — только display.

**Top-up всегда привязан к product price** при входе через locked section. Отдельного "Пополнить на произвольную сумму" нет.

---

## 7. Webhook Routes

**Файл:** `src/http/server.ts`

| Route | Метод | Описание |
|-------|-------|----------|
| /webhooks/payments/nowpayments | GET | Probe, servicesReady |
| /webhooks/payments/nowpayments | POST | IPN, raw body, x-nowpayments-sig |
| /webhooks/payments/crypto | POST | Manual confirm: referenceCode, status, externalTxId |

**Content-Type parser:** application/json parseAs string → rawBody сохраняется для проверки подписи.

---

## 8. NOWPayments Adapter

**Файл:** `src/modules/payments/nowpayments.adapter.ts`

**Методы:**
- `createPayment(params)` → CreatePaymentResponse
- `getPaymentStatus(paymentId)` → GetPaymentStatusResponse
- `verifyIpnSignature(rawBody, signature, ipnSecret)` — HMAC-SHA512

**Нет:** createMassPayoutBatch, getPayoutBatchStatus

**Config:** env.NOWPAYMENTS_API_KEY, env.NOWPAYMENTS_BASE_URL, env.NOWPAYMENTS_IPN_SECRET, env.NOWPAYMENTS_IPN_CALLBACK_URL

---

## 9. Env Variables (текущие)

| Переменная | Назначение |
|------------|------------|
| NOWPAYMENTS_API_KEY | API key |
| NOWPAYMENTS_IPN_SECRET | HMAC secret для IPN |
| NOWPAYMENTS_BASE_URL | default: https://api.nowpayments.io/v1 |
| NOWPAYMENTS_IPN_CALLBACK_URL | URL для IPN callbacks |

---

## 10. Куда встраивать NOWPayments v1

### Переиспользовать

- **DepositTransaction** — расширить полями (outcome_amount, processor_fee, botId при необходимости)
- **ProviderEventLog** — idempotency; при необходимости добавить PaymentWebhookLog для raw log
- **BalanceService.createDepositIntent** — адаптировать под createBalanceTopupPayment, orderId формата bot:user:topup:id
- **processNowPaymentsIpn** — добавить создание OwnerSettlementEntry, изменить creditedAmount на outcome_amount
- **NowPaymentsAdapter** — расширить payout API

### Добавить

- OwnerSettlementEntry, OwnerPayoutBatch
- Per-bot config (BotPaymentProviderConfig или поля в BotInstance)
- PROCESS_OWNER_DAILY_PAYOUTS job + worker
- Backoffice UI: config, settlement, batches, webhook logs

### Не трогать

- PaymentService, confirmPayment, grantOrExtendAccess
- UserAccessRight, subscription reminders, PROCESS_ACCESS_EXPIRY
- Manual fallback flow
- /webhooks/payments/crypto

---

## 11. Файлы для изменения (план)

| Файл | Действие |
|------|----------|
| prisma/schema.prisma | OwnerSettlementEntry, OwnerPayoutBatch, PaymentWebhookLog?, per-bot config, расширение DepositTransaction |
| src/modules/payments/nowpayments.adapter.ts | Payout API, типы |
| src/modules/payments/balance.service.ts | OwnerSettlementEntry при credit, outcome_amount |
| src/http/server.ts | PaymentWebhookLog при IPN? |
| src/modules/jobs/scheduler.service.ts | PROCESS_OWNER_DAILY_PAYOUTS в JobType |
| src/modules/jobs/workers.ts | Обработчик PROCESS_OWNER_DAILY_PAYOUTS |
| src/http/backoffice/register-backoffice.ts | NOWPayments config, settlement, batches |
| src/config/env.ts | Payout-related env |
| prisma/migrations/ | Новая миграция |

---

## 12. Связь Owner ↔ Bot

- **BotInstance.ownerBackofficeUserId** → BackofficeUser (email, passwordHash, role)
- Owner = backoffice user, не Telegram User
- Кошелёк owner — хранить в новом конфиге (BotInstance или отдельная таблица)

---

## 13. Риски и ограничения

1. **DepositTransaction без botId** — bot выводится из user.botInstanceId; для multi-bot нужно учитывать.
2. **OrderId** — текущий формат dep_*; переход на bot:user:topup:id требует миграции или dual support.
3. **Credited amount** — сейчас price_amount; по ТЗ outcome_amount.
4. **NOWPayments Payout API** — нужно проверить актуальную документацию (Mass Payout, batch status).
5. **Daily cron** — в проекте нет встроенного cron; нужен механизм запуска daily job (отдельный процесс или add-on).

---

## 14. Итог

Аудит завершён. Инфраструктура для balance top-up через NOWPayments уже есть. Для v1 требуется:

1. Owner settlement ledger (OwnerSettlementEntry, OwnerPayoutBatch)
2. Daily payout job
3. Per-bot config (owner wallet, payout settings)
4. Расширение IPN logic (outcome_amount, OwnerSettlementEntry)
5. Backoffice UI
6. Payout API в NowPaymentsAdapter

**Код не изменялся.** Готовность к Этапу 2 (Prisma schema и data model).

---

## Этап 2 выполнён (2025-03-23)

### Добавлено в schema.prisma

- **JobType:** PROCESS_OWNER_DAILY_PAYOUTS
- **Enums:** OwnerSettlementEntryStatus (PENDING, BATCHED, PAID, FAILED), OwnerPayoutBatchStatus (CREATED, SENT, PARTIAL, PAID, FAILED)
- **DepositTransaction:** botInstanceId, providerStatus, providerPayAddress, requestedAmountUsd, requestedAssetCode, creditedBalanceAmount, actualOutcomeAmount, processorFeeAmount, platformFeeAmount, ownerAccrualAmount, webhookLastProcessedAt, confirmedAt
- **PaymentWebhookLog:** raw webhook log (provider, externalEventId, headersJson, bodyJson, signatureValid, processed, processingResult)
- **BotPaymentProviderConfig:** per-bot NOWPayments config (ownerWalletAddress, dailyPayoutEnabled, payoutTimeZone, etc.)
- **OwnerSettlementEntry:** accrual per confirmed top-up (grossAmount, processorFeeAmount, netAmountBeforePayoutFee, status, batchId)
- **OwnerPayoutBatch:** daily payout batch (runDate, grossTotal, netTotal, providerBatchId, status)

### Миграция

`prisma/migrations/20260326120000_add_nowpayments_v1_owner_settlement/migration.sql`

### scheduler.service.ts

- Добавлен PROCESS_OWNER_DAILY_PAYOUTS в schedule() и RETRYABLE_TERMINAL_DUE_JOB_TYPES

---

## Этап 3 выполнен (2025-03-23)

### env/config (src/config/env.ts)

- NOWPAYMENTS_USE_CUSTODY
- NOWPAYMENTS_DEFAULT_PAY_CURRENCY
- NOWPAYMENTS_DEFAULT_SETTLEMENT_CURRENCY
- NOWPAYMENTS_PAYOUT_FEE_POLICY
- NOWPAYMENTS_DAILY_PAYOUT_CRON
- NOWPAYMENTS_DAILY_PAYOUT_TIMEZONE
- NOWPAYMENTS_EMAIL, NOWPAYMENTS_PASSWORD (для Mass Payouts API)

### nowpayments.client.ts

- createTopupPayment (delegate to adapter)
- getPaymentStatus (delegate to adapter)
- verifyIpnSignature (static, delegate to adapter)
- createMassPayoutBatch (POST /payout, Bearer auth)
- getPayoutBatchStatus (GET /payout/:id)
- createNowPaymentsClientFromEnv() factory

### Тесты

- tests/nowpayments.client.test.ts (5 tests)
