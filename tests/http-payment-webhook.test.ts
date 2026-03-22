import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env", () => ({
  env: {
    HTTP_PORT: 3000,
    LOG_LEVEL: "info"
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
    const server = createHealthServer();
    addPaymentWebhookRoute(
      server,
      () =>
        ({
          balance: {
            processNowPaymentsIpn
          }
        }) as any,
      {} as any
    );

    const response = await server.inject({
      method: "POST",
      url: "/webhooks/payments/nowpayments",
      headers: {
        "content-type": "application/json",
        "x-nowpayments-sig": "signature"
      },
      payload: {
        payment_id: "payment-1",
        order_id: "order-1",
        payment_status: "finished"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(processNowPaymentsIpn).toHaveBeenCalledWith(
      JSON.stringify({
        payment_id: "payment-1",
        order_id: "order-1",
        payment_status: "finished"
      }),
      "signature"
    );
    expect(response.json()).toEqual({
      ok: true,
      credited: true,
      duplicate: false
    });

    await server.close();
  });
});
