import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NowPaymentsAdapter } from "../src/modules/payments/nowpayments.adapter";

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const sortedEntries = Object.entries(payload).sort(([left], [right]) => left.localeCompare(right));
  const sorted = Object.fromEntries(sortedEntries);
  return crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

describe("NowPaymentsAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes ipn_callback_url explicitly when creating a payment", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        payment_id: 101,
        payment_status: "waiting",
        pay_address: "wallet-address",
        price_amount: 10,
        price_currency: "usdt",
        pay_amount: 10.5,
        pay_currency: "usdtbsc"
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new NowPaymentsAdapter("test-api-key", "https://api.nowpayments.io/v1");

    await adapter.createPayment({
      priceAmount: 10,
      priceCurrency: "USDT",
      payCurrency: "usdtbsc",
      orderId: "order-1",
      orderDescription: "Deposit 10 USDT",
      ipnCallbackUrl: "https://admin.botzik.pp.ua/webhooks/payments/nowpayments",
      fixedRate: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(body).toMatchObject({
      order_id: "order-1",
      ipn_callback_url: "https://admin.botzik.pp.ua/webhooks/payments/nowpayments",
      fixed_rate: true
    });
  });

  it("accepts a valid NOWPayments IPN signature", async () => {
    const payload = {
      order_id: "order-1",
      payment_id: 101,
      payment_status: "finished",
      price_amount: 10
    };
    const rawBody = JSON.stringify({
      payment_status: "finished",
      payment_id: 101,
      price_amount: 10,
      order_id: "order-1"
    });
    const secret = "test-ipn-secret";
    const signature = signPayload(payload, secret);

    await expect(NowPaymentsAdapter.verifyIpnSignature(rawBody, signature, secret)).resolves.toBe(true);
  });

  it("rejects an invalid NOWPayments IPN signature", async () => {
    const rawBody = JSON.stringify({
      payment_status: "finished",
      payment_id: 101,
      price_amount: 10,
      order_id: "order-1"
    });

    await expect(
      NowPaymentsAdapter.verifyIpnSignature(rawBody, "deadbeef", "test-ipn-secret")
    ).resolves.toBe(false);
  });
});
