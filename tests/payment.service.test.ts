import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentService } from "../src/modules/payments/payment.service";

describe("PaymentService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
        findFirst: vi.fn().mockResolvedValue(null),
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

  it("extends current access from the existing expiry date and reschedules reminder jobs on early renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T18:00:00.000Z"));

    const currentActiveUntil = new Date("2026-03-26T18:00:00.000Z");
    const payment = {
      id: "payment-2",
      userId: "user-2",
      productId: "product-2",
      botInstanceId: "bot-2",
      status: "PENDING",
      expiresAt: new Date("2026-03-24T18:00:00.000Z"),
      externalTxId: null,
      user: {
        id: "user-2",
        selectedLanguage: "ru",
        telegramUserId: 456n
      },
      product: {
        id: "product-2",
        billingType: "TEMPORARY",
        durationMinutes: null,
        durationDays: 30,
        linkedChats: [],
        localizations: []
      }
    };

    const tx = {
      userAccessRight: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "access-extend", activeUntil: currentActiveUntil }),
        create: vi.fn(),
        update: vi.fn().mockImplementation(async ({ where, data }: any) => ({
          id: where.id,
          activeUntil: data.activeUntil
        }))
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

    const scheduler = {
      cancelByIdempotencyKeyPrefix: vi.fn().mockResolvedValue(1)
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
      scheduler as any,
      subscriptionChannel as any
    );

    await service.confirmPayment("payment-2", "owner-2");

    const expectedActiveUntil = new Date("2026-04-25T18:00:00.000Z");
    expect(tx.userAccessRight.create).not.toHaveBeenCalled();
    expect(tx.userAccessRight.update).toHaveBeenCalledWith({
      where: { id: "access-extend" },
      data: {
        accessType: "TEMPORARY",
        activeUntil: expectedActiveUntil
      }
    });
    expect(scheduler.cancelByIdempotencyKeyPrefix).toHaveBeenNthCalledWith(1, "sub-rem:access-extend:");
    expect(scheduler.cancelByIdempotencyKeyPrefix).toHaveBeenNthCalledWith(2, "access-exp:access-extend");
    expect(subscriptionChannel.scheduleRemindersAndExpiry).toHaveBeenCalledWith(
      "access-extend",
      expectedActiveUntil,
      "bot-2",
      scheduler,
      payment.product
    );
  });
});
