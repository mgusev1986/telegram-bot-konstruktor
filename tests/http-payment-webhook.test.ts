import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env", () => ({
  env: {
    HTTP_PORT: 3000,
    LOG_LEVEL: "info",
    NOWPAYMENTS_IPN_SECRET: "test-ipn-secret"
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

import { addPaymentWebhookRoute, createHealthServer } from "../src/http/server";

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const sortedEntries = Object.entries(payload).sort(([a], [b]) => a.localeCompare(b));
  const sorted = Object.fromEntries(sortedEntries);
  return crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

describe("NOWPayments webhook route", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("exposes a public probe endpoint on the final webhook path", async () => {
    const server = createHealthServer();
    addPaymentWebhookRoute(server, () => null, {} as any);

    const response = await server.inject({
      method: "GET",
      url: "/webhooks/payments/nowpayments"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        provider: "nowpayments",
        route: "/webhooks/payments/nowpayments",
        servicesReady: false
      })
    );

    await server.close();
  });

  it("returns 200 for a successfully processed NOWPayments webhook", async () => {
    const processNowPaymentsIpn = vi.fn().mockResolvedValue({
      ok: true,
      credited: true,
      duplicate: false,
      status: "finished"
    });
    const prisma = {
      paymentWebhookLog: {
        create: vi.fn().mockResolvedValue({ id: "log-1" }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    const server = createHealthServer();
    addPaymentWebhookRoute(
      server,
      () =>
        ({
          balance: {
            processNowPaymentsIpn
          }
        }) as any,
      prisma as any
    );

    const payload = {
      payment_id: "payment-1",
      order_id: "order-1",
      payment_status: "finished"
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/payments/nowpayments",
      headers: {
        "content-type": "application/json",
        "x-nowpayments-sig": signature
      },
      payload: rawBody
    });

    expect(response.statusCode).toBe(200);
    expect(processNowPaymentsIpn).toHaveBeenCalledWith(rawBody, signature);
    expect(response.json()).toEqual({
      ok: true,
      credited: true,
      duplicate: false
    });

    await server.close();
  });
});
