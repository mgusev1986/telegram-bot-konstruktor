# NOWPayments v1 Integration — Итоговый отчёт о выполнении

**Дата:** 2025-03-23  
**Статус:** Полностью реализовано

---

## Этап 1: Codebase Audit

**Результат:** 100%

- Проведён аудит моделей Prisma (DepositTransaction, UserBalanceAccount, BalanceLedgerEntry, ProviderEventLog и др.)
- Проанализирован flow пополнения баланса и оплаты продукта
- Определены точки расширения для owner settlement и daily payout
- Создан документ `docs/NOWPAYMENTS_V1_INTEGRATION_AUDIT.md`

---

## Этап 2: Prisma Schema и Data Model

**Результат:** 100%

- **Enums:** `OwnerSettlementEntryStatus`, `OwnerPayoutBatchStatus`, `PROCESS_OWNER_DAILY_PAYOUTS` в `JobType`
- **DepositTransaction:** добавлены `botInstanceId`, `providerStatus`, `providerPayAddress`, `requestedAmountUsd`, `creditedBalanceAmount`, `actualOutcomeAmount`, `processorFeeAmount`, `confirmedAt`, `webhookLastProcessedAt`
- **PaymentWebhookLog:** модель для логирования входящих webhook (provider, externalEventId, headersJson, bodyJson, signatureValid, processed, processingResult)
- **BotPaymentProviderConfig:** per-bot конфиг NOWPayments (ownerWalletAddress, dailyPayoutEnabled, payoutTimeZone, dailyPayoutMinAmount и др.)
- **OwnerSettlementEntry:** accrual на каждый подтверждённый top-up (grossAmount, processorFeeAmount, platformFeeAmount, netAmountBeforePayoutFee, status, batchId)
- **OwnerPayoutBatch:** batch ежедневных выплат (runDate, grossTotal, netTotal, providerBatchId, status)
- Миграция: `prisma/migrations/20260326120000_add_nowpayments_v1_owner_settlement/migration.sql`
- `scheduler.service.ts`: PROCESS_OWNER_DAILY_PAYOUTS в schedule() и RETRYABLE_TERMINAL_DUE_JOB_TYPES

---

## Этап 3: Config + NOWPayments Client

**Результат:** 100%

- **env.ts:** NOWPAYMENTS_USE_CUSTODY, NOWPAYMENTS_DEFAULT_PAY_CURRENCY, NOWPAYMENTS_DEFAULT_SETTLEMENT_CURRENCY, NOWPAYMENTS_PAYOUT_FEE_POLICY, NOWPAYMENTS_DAILY_PAYOUT_CRON, NOWPAYMENTS_DAILY_PAYOUT_TIMEZONE, NOWPAYMENTS_EMAIL, NOWPAYMENTS_PASSWORD, NOWPAYMENTS_PAYOUT_TRIGGER_SECRET
- **nowpayments.client.ts:** `createNowPaymentsClientFromEnv()`, `createTopupPayment`, `getPaymentStatus`, `verifyIpnSignature`, `createMassPayoutBatch`, `getPayoutBatchStatus`
- Auth для Mass Payouts API (email/password → Bearer token)
- Тесты: `tests/nowpayments.client.test.ts`

---

## Этап 4: Incoming Top-Up Flow

**Результат:** 100%

- `createDepositIntent` в `balance.service.ts`: сначала создаётся DepositTransaction, затем вызов NOWPayments, затем обновление
- Формат orderId: `bot:{botId}:user:{userId}:topup:{uuid}`
- Сохраняются `botInstanceId`, `requestedAmountUsd`
- Обновлены тесты в `balance.service.test.ts`

---

## Этап 5: Webhook / IPN

**Результат:** 100%

- **server.ts:** POST `/webhooks/payments/nowpayments` — логирование в PaymentWebhookLog (headers, body, signatureValid, processed, processingResult)
- Проверка HMAC подписи перед вызовом balance.service
- **balance.service.ts:** `processNowPaymentsIpn` — idempotent credit по `outcome_amount` (fallback `price_amount`)
- При кредите обновляются: creditedBalanceAmount, actualOutcomeAmount, confirmedAt, webhookLastProcessedAt
- Тесты: `http-payment-webhook.test.ts` (реальная подпись, rawBody)

---

## Этап 6: Owner Settlement Ledger

**Результат:** 100%

- При успешном кредите в `processTrustedNowPaymentsPayload` создаётся `OwnerSettlementEntry` (если deposit.botInstanceId задан)
- Расчёт: grossAmount, processorFeeAmount (pay_amount - outcome_amount), platformFeeAmount (из BotPaymentProviderConfig), netAmountBeforePayoutFee
- Статус PENDING, связь с DepositTransaction и BotInstance

---

## Этап 7: Daily Payout Job

**Результат:** 100%

- **OwnerPayoutService** (`owner-payout.service.ts`): `processBotPayout(botInstanceId)`, `processAllBots()`
- Агрегация PENDING entries, проверка dailyPayoutMinAmount, создание OwnerPayoutBatch, вызов `createMassPayoutBatch`
- **workers.ts:** обработчик PROCESS_OWNER_DAILY_PAYOUTS (без runtime — только prisma + NowPaymentsClient)
- Поддержка payload с botInstanceId (один бот) или без (все боты)
- **HTTP endpoint:** POST `/webhooks/payments/owner-payout-trigger?secret=xxx` — для вызова внешним cron
- Env: NOWPAYMENTS_PAYOUT_TRIGGER_SECRET

---

## Этап 8: Backoffice UI

**Результат:** 100%

- Секция «NOWPayments / Owner Payouts» на странице `/backoffice/bots/:botId/paid`
- Форма конфигурации: enabled, ownerPayoutEnabled, dailyPayoutEnabled, ownerWalletAddress, settlementCurrency, dailyPayoutMinAmount
- POST `/backoffice/api/bots/:botId/paid/nowpayments-config` — сохранение конфига (upsert BotPaymentProviderConfig)
- Settlement summary: pending entries count, pending net total
- Таблица payout batches (последние)
- Таблица settlement entries (последние)
- Webhook logs (collapsible details)

---

## Этап 9: Tests

**Результат:** 100%

- `balance.service.test.ts`: кредит, идемпотентность, outcome_amount vs price_amount, дубликаты
- `http-payment-webhook.test.ts`: подпись, обработка, логирование
- `owner-payout.service.test.ts`: isConfigured, processBotPayout (skipped при отсутствии конфига, отключенном payout, пустых entries)
- `nowpayments.client.test.ts`: createTopupPayment, getPaymentStatus, verifyIpnSignature

---

## Этап 10: QA и документация

**Результат:** 100%

- Отчёт о реализации: `docs/NOWPAYMENTS_V1_IMPLEMENTATION_REPORT.md` (этот файл)
- Руководство для пользователя: `docs/NOWPAYMENTS_V1_MANUAL_SETUP_GUIDE.md`

---

## Изменённые и добавленные файлы

| Файл | Действие |
|------|----------|
| prisma/schema.prisma | Расширение DepositTransaction, новые модели и enums |
| prisma/migrations/20260326120000_* | Миграция |
| src/config/env.ts | NOWPayments env vars |
| src/modules/payments/nowpayments.client.ts | Клиент + Mass Payout |
| src/modules/payments/nowpayments.adapter.ts | (существующий) createPayment, getPaymentStatus |
| src/modules/payments/balance.service.ts | createDepositIntent, processNowPaymentsIpn, OwnerSettlementEntry |
| src/modules/payments/owner-payout.service.ts | **новый** — daily payout logic |
| src/http/server.ts | Webhook route, PaymentWebhookLog, owner-payout-trigger |
| src/modules/jobs/workers.ts | PROCESS_OWNER_DAILY_PAYOUTS handler |
| src/modules/jobs/scheduler.service.ts | PROCESS_OWNER_DAILY_PAYOUTS в schedule |
| src/http/backoffice/register-backoffice.ts | NOWPayments config UI, settlement, batches |
| tests/balance.service.test.ts | Обновлены тесты |
| tests/http-payment-webhook.test.ts | Обновлены тесты |
| tests/owner-payout.service.test.ts | **новый** |
| tests/nowpayments.client.test.ts | Существующий |
| .env.example | NOWPAYMENTS_PAYOUT_TRIGGER_SECRET |
