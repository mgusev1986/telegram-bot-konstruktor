import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env", () => ({
  env: {
    NOWPAYMENTS_API_KEY: "test-api-key",
    NOWPAYMENTS_BASE_URL: "https://api.nowpayments.io/v1",
    NOWPAYMENTS_EMAIL: "",
    NOWPAYMENTS_PASSWORD: ""
  }
}));

vi.mock("../src/common/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import {
  NowPaymentsClient,
  createNowPaymentsClientFromEnv,
  NowPaymentsPayoutNotConfiguredError
} from "../src/modules/payments/nowpayments.client";

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const sortedEntries = Object.entries(payload).sort(([left], [right]) => left.localeCompare(right));
  const sorted = Object.fromEntries(sortedEntries);
  return crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

describe("NowPaymentsClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifyIpnSignature accepts valid signature", async () => {
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

    await expect(NowPaymentsClient.verifyIpnSignature(rawBody, signature, secret)).resolves.toBe(
      true
    );
  });

  it("verifyIpnSignature rejects invalid signature", async () => {
    const rawBody = JSON.stringify({
      payment_status: "finished",
      payment_id: 101,
      order_id: "order-1"
    });

    await expect(
      NowPaymentsClient.verifyIpnSignature(rawBody, "invalid-hex", "test-ipn-secret")
    ).resolves.toBe(false);
  });

  it("createNowPaymentsClientFromEnv returns client when API key is set", () => {
    const client = createNowPaymentsClientFromEnv();
    expect(client).not.toBeNull();
    expect(client).toBeInstanceOf(NowPaymentsClient);
  });

  it("createTopupPayment delegates to adapter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        payment_id: 102,
        payment_status: "waiting",
        pay_address: "0x123",
        price_amount: 5,
        price_currency: "usdt",
        pay_amount: 5,
        pay_currency: "usdtbsc"
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new NowPaymentsClient({
      apiKey: "key",
      baseUrl: "https://api.nowpayments.io/v1"
    });

    const result = await client.createTopupPayment({
      priceAmount: 5,
      priceCurrency: "USDT",
      payCurrency: "usdtbsc",
      orderId: "ord-1"
    });

    expect(result.payment_id).toBe(102);
    expect(result.pay_address).toBe("0x123");
  });

  it("createMassPayoutBatch throws when email/password not configured", async () => {
    const client = new NowPaymentsClient({
      apiKey: "key",
      baseUrl: "https://api.nowpayments.io/v1"
    });

    await expect(
      client.createMassPayoutBatch({
        withdrawals: [{ address: "0xabc", currency: "usdtbsc", amount: 1 }]
      })
    ).rejects.toThrow(NowPaymentsPayoutNotConfiguredError);
  });
});
