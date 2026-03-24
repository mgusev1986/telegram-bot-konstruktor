# Payment Simplification — NOWPayments Only, USDT BEP20

## 1. Изменённые файлы

| Файл | Изменения |
|------|-----------|
| `src/bot/register-bot.ts` | Убран direct fallback; кнопка «Скопировать адрес кошелька»; добавлена кнопка «Запросить проверку оплаты»; при недоступности NOWPayments — алерт вместо manual |
| `src/http/backoffice/register-backoffice.ts` | Убраны поля резервного кошелька; settlementCurrency фиксирована usdtbep20; owner wallet placeholder 0x; убрана ссылка Manual payments; обновлены тексты |
| `src/modules/payments/nowpayments.adapter.ts` | PAY_CURRENCY_MAP: все сети → usdtbsc |
| `src/modules/payments/nowpayments.client.ts` | То же для client |
| `src/modules/payments/owner-payout.service.ts` | default settlementCurrency usdtbep20, нормализация usdttrc20→usdtbep20 |
| `src/modules/i18n/static-dictionaries.ts` | Добавлен ключ `payment_temporarily_unavailable` |
| `tests/payment-simplification.test.ts` | **Новый** — тесты BEP20-only mapping |
| `docs/PAYMENT_SIMPLIFICATION_AUDIT.md` | **Новый** — аудит |

## 2. Удалённые/скрытые legacy UX элементы

- Поле «Резервный кошелёк (только manual mode)» в product form (product update)
- Поле «Резервный кошелёк» в создании live-product
- Поле «Резервный кошелёк» в создании test-product
- Поле «Settlement currency» (заменено на hidden value usdtbep20)
- Ссылка «Manual payments» в навигации paid page
- Direct/manual checkout fallback — при недоступности NOWPayments показывается алерт «Оплата временно недоступна»
- `buildDirectCheckoutKeyboard` — удалён
- `showDirectCheckoutScreen` — удалён

## 3. Обновлённые тексты

- Copy wallet button: «Скопировать адрес кошелька» (i18n key `copy_wallet_address`)
- Checkout mode: «NOWPayments active (USDT BEP20)» / «NOWPayments не настроен»
- Owner wallet label: «Кошелёк owner (USDT BEP20)», placeholder 0x...
- Payment flow description: «Оплата работает автоматически через NOWPayments. Сеть: USDT (BEP20). Владелец получает выплаты на указанный кошелёк owner.»
- Payment events: «NOWPayments IPN» вместо «manual confirm»
- Новый ключ: `payment_temporarily_unavailable` (ru/en)

## 4. Добавленные/обновлённые тесты

- `tests/payment-simplification.test.ts`: проверка payCurrencyFromNetwork для USDT_BEP20 и USDT_TRC20 → usdtbsc

## 5. Manual QA checklist

- [ ] Backoffice: секция NOWPayments — только owner wallet, без manual wallet
- [ ] Backoffice: создание продукта — нет поля резервного кошелька
- [ ] Backoffice: settlement currency скрыта, значение usdtbep20
- [ ] Бот: на locked section «Оплатить» → только NOWPayments checkout
- [ ] Бот: кнопка «Скопировать адрес кошелька» (не адрес как текст)
- [ ] Бот: кнопка «Запросить проверку оплаты» работает
- [ ] Бот: при отключённом NOWPayments — алерт «Оплата временно недоступна»
- [ ] Сеть только USDT (BEP20) в UI
- [ ] Owner payout работает с usdtbep20

## 6. Риски / assumptions

- **Legacy Payment records**: Manual payments в БД остаются; route `/backoffice/bots/:id/payments` и confirm/reject handlers не удалены — доступны по прямой ссылке для старых pending payments
- **Product.walletBep20**: Поле в БД сохранено; форма больше не отправляет значение; create/update handlers продолжают принимать walletBep20 (сохраняют null при отсутствии)
- **PaymentNetwork enum**: USDT_TRC20 остаётся в schema; при вызове payCurrencyFromNetwork возвращается usdtbsc
- **Существующие BotPaymentProviderConfig** с settlementCurrency=usdttrc20: owner-payout.service нормализует на usdtbep20 при чтении

## 7. Что осталось legacy only (hidden from UX)

- `PaymentService.createPaymentRequest`, `resolveWallet` — для старых manual flow, не вызываются из user flow
- Route `/backoffice/bots/:id/payments` — manual confirm; ссылка убрана из nav, но URL доступен
- `buildPaywallKeyboard` с pay:network — определён в keyboards.ts, не используется в showLockedSectionScreen
- Product.walletBep20, walletTrc20 — поля в БД, скрыты из форм
