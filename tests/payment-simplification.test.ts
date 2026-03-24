import { describe, expect, it } from "vitest";

import { NowPaymentsAdapter } from "../src/modules/payments/nowpayments.adapter";
import { NowPaymentsClient } from "../src/modules/payments/nowpayments.client";

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
});
