import { describe, expect, it } from "vitest";

import { makeCallbackData, splitCallbackData } from "../src/common/callback-data";
import { buildPaywallKeyboard } from "../src/bot/keyboards";
import { NowPaymentsAdapter } from "../src/modules/payments/nowpayments.adapter";
import { NowPaymentsClient } from "../src/modules/payments/nowpayments.client";
import { createMockI18n } from "./helpers/mock-i18n";

const i18n = createMockI18n();

describe("Payment simplification (NOWPayments only, USDT BEP20)", () => {
  it("payCurrencyFromNetwork maps USDT_BEP20 to usdtbsc", () => {
    expect(NowPaymentsAdapter.payCurrencyFromNetwork("USDT_BEP20")).toBe("usdtbsc");
  });

  it("payCurrencyFromNetwork maps USDT_TRC20 to usdtbsc (v1 BEP20-only)", () => {
    expect(NowPaymentsAdapter.payCurrencyFromNetwork("USDT_TRC20")).toBe("usdtbsc");
  });

  it("NowPaymentsClient payCurrencyFromNetwork maps to usdtbsc", () => {
    expect(NowPaymentsClient.payCurrencyFromNetwork("USDT_BEP20")).toBe("usdtbsc");
    expect(NowPaymentsClient.payCurrencyFromNetwork("USDT_TRC20")).toBe("usdtbsc");
  });

  describe("pay button callback wiring (locked section)", () => {
    it("pay:checkout:productId parses to scope=pay, action=checkout, value=productId", () => {
      const productId = "prod-uuid-123";
      const data = makeCallbackData("pay", "checkout", productId);
      expect(data).toBe("pay:checkout:prod-uuid-123");
      const [scope, action, value] = splitCallbackData(data);
      expect(scope).toBe("pay");
      expect(action).toBe("checkout");
      expect(value).toBe(productId);
    });

    it("callback_data fits Telegram 64-byte limit for typical product id", () => {
      const productId = "550e8400-e29b-41d4-a716-446655440000";
      const data = makeCallbackData("pay", "checkout", productId);
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    });

    it("buildPaywallKeyboard (non-balance flow) uses pay:network with USDT_BEP20", () => {
      const kb = buildPaywallKeyboard("ru", "prod-1", i18n, {
        useBalanceFlow: false,
        payButtonText: "Оплатить"
      });
      const rows = (kb as any).reply_markup.inline_keyboard;
      const payRow = rows.find((r: any[]) => r.some((b: any) => b.text?.includes("Оплатить") || b.text?.includes("USDT")));
      expect(payRow).toBeDefined();
      const payBtn = payRow.find((b: any) => b.callback_data?.startsWith("pay:"));
      expect(payBtn?.callback_data).toMatch(/^pay:network:prod-1:USDT_BEP20$/);
    });
  });
});
