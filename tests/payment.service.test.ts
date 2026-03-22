import { describe, expect, it, vi } from "vitest";

import { PaymentService } from "../src/modules/payments/payment.service";

describe("PaymentService", () => {
  it("grants temporary access for minute-based test products and forwards product policy to scheduler", async () => {
    const payment = {
      id: "payment-1",
      userId: "user-1",
      productId: "product-1",
      botInstanceId: "bot-1",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      externalTxId: null,
      user: {
        id: "user-1",
        selectedLanguage: "ru",
        telegramUserId: 123n
      },
      product: {
        id: "product-1",
        billingType: "ONE_TIME",
        durationMinutes: 5,
        durationDays: null,
        linkedChats: [],
        localizations: []
      }
    };

    const createdAccessRight = { id: "access-1" };
    const tx = {
      userAccessRight: {
        create: vi.fn().mockResolvedValue(createdAccessRight)
      },
      payment: {
        update: vi.fn().mockResolvedValue(undefined)
      },
      user: {
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const prisma = {
      payment: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(payment)
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    };

    const subscriptionChannel = {
      scheduleRemindersAndExpiry: vi.fn().mockResolvedValue(undefined),
      onAccessGranted: vi.fn().mockResolvedValue(undefined)
    };

    const service = new PaymentService(
      prisma as any,
      { create: vi.fn().mockResolvedValue(undefined), sendText: vi.fn().mockResolvedValue(undefined) } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { assignTag: vi.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      subscriptionChannel as any
    );

    await service.confirmPayment("payment-1", "owner-1");

    expect(tx.userAccessRight.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        productId: "product-1",
        accessType: "TEMPORARY",
        activeUntil: expect.any(Date)
      })
    });
    expect(subscriptionChannel.scheduleRemindersAndExpiry).toHaveBeenCalledWith(
      "access-1",
      expect.any(Date),
      "bot-1",
      expect.anything(),
      payment.product
    );
  });
});
