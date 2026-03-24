# Payment Simplification Audit — NOWPayments Only, USDT BEP20

## Manual/Direct flow locations

| File | Location | Description |
|------|----------|-------------|
| register-bot.ts:1035-1048 | showBalanceCheckoutScreen | If NOWPayments disabled OR createDepositIntent returns null → showDirectCheckoutScreen (manual) |
| register-bot.ts:1011-1032 | showDirectCheckoutScreen | Uses payments.createPaymentRequest + buildDirectCheckoutKeyboard |
| payment.service.ts:75-120 | createPaymentRequest | Manual/direct flow — creates Payment with resolveWallet |
| payment.service.ts:330-336 | resolveWallet | Returns product.walletBep20 / env.USDT_* / product.walletTrc20 |

## Wallet address as button text

| File | Line | Current | Target |
|------|------|---------|--------|
| register-bot.ts | 929 | `{ text: payAddress, copy_text: { text: payAddress } }` | `{ text: "Скопировать адрес кошелька", copy_text: { text: payAddress } }` |
| register-bot.ts | 945 | buildDirectCheckoutKeyboard same | Will be removed from active path |

## Backoffice manual wallet fields

| File | Line | Field | Action |
|------|------|-------|--------|
| register-backoffice.ts | 2229 | Резервный кошелёк (только manual mode) | Remove |
| register-backoffice.ts | 2433-2435 | Резервный кошелёк in live product create | Remove |
| register-backoffice.ts | 2472-2474 | Резервный кошелёк in test product create | Remove |
| register-backoffice.ts | 2546 | ownerWalletAddress placeholder "T..." | Change to "0x..." (BEP20) |
| register-backoffice.ts | 2547 | settlementCurrency input | Fix to usdtbep20 only, hide/readonly |

## TRC20 / network selection

| File | Usage | Action |
|------|-------|--------|
| nowpayments.adapter.ts | PAY_CURRENCY_MAP USDT_TRC20 | Keep for internal, default to BEP20 in user flow |
| nowpayments.client.ts | PAY_CURRENCY_MAP, payCurrencyFromNetwork | Use usdtbsc only for v1 |
| owner-payout.service.ts | settlementCurrency ?? "usdttrc20" | Change default to usdtbep20 |
| register-bot.ts | formatNetworkLabel USDT_TRC20 | Remove TRC20 from display (only BEP20) |
| keyboards.ts | pay:network with USDT_BEP20 | Already BEP20-only when used |

## Enum/constants

- PaymentNetwork: USDT_TRC20, USDT_BEP20, TON, OTHER — keep in schema, use only USDT_BEP20 in active flow
- Product.walletBep20, walletTrc20 — keep in schema (legacy), hide from forms
