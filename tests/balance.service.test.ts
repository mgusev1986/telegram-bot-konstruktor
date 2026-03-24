import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env", () => ({
  env: {
    NOWPAYMENTS_API_KEY: "test-api-key",
    NOWPAYMENTS_IPN_SECRET: "test-ipn-secret",
    NOWPAYMENTS_BASE_URL: "https://api.nowpayments.io/v1",
    NOWPAYMENTS_IPN_CALLBACK_URL: "https://admin.botzik.pp.ua/webhooks/payments/nowpayments"
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

import { BalanceService } from "../src/modules/payments/balance.service";

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const sortedEntries = Object.entries(payload).sort(([left], [right]) => left.localeCompare(right));
  const sorted = Object.fromEntries(sortedEntries);
  return crypto.createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createBalanceHarness(opts?: { onDepositCredited?: (p: any) => Promise<void> }) {
  const state = {
    user: {
      id: "user-1",
      selectedLanguage: "ru",
      telegramUserId: 111n
    },
    deposit: {
      id: "dep-1",
      userId: "user-1",
      accountId: "acc-1",
      provider: "nowpayments",
      providerPaymentId: "payment-1",
      orderId: "order-1",
      amount: 10,
      currency: "USDT",
      status: "PENDING",
      rawPayload: {},
      ledgerEntryId: null as string | null,
      creditedAt: null as Date | null
    },
    account: {
      id: "acc-1",
      userId: "user-1",
      balance: 0
    },
    eventLogs: new Map<string, any>(),
    ledgerEntries: [] as any[]
  };

  const notifications = {
    sendText: vi.fn().mockResolvedValue(undefined)
  };
  const audit = {
    log: vi.fn().mockResolvedValue(undefined)
  };

  const providerEventLog = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const key = where.provider_providerTxId.providerTxId;
      const existing = state.eventLogs.get(key);
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      const row = {
        id: `event-${key}`,
        ...create
      };
      state.eventLogs.set(key, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const existing = Array.from(state.eventLogs.values()).find((item) => item.id === where.id);
      if (!existing) {
        throw new Error(`Unknown provider event log ${where.id}`);
      }
      Object.assign(existing, data);
      return { ...existing };
    })
  };

  const depositTransaction = {
    findUnique: vi.fn(async ({ where, include }: any) => {
      if (where.orderId && where.orderId === state.deposit.orderId) {
        return include?.user ? { ...state.deposit, user: state.user } : { ...state.deposit };
      }
      if (where.id && where.id === state.deposit.id) {
        return include?.user ? { ...state.deposit, user: state.user } : { ...state.deposit };
      }
      return null;
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const matches = where.OR?.some(
        (item: any) => item.id === state.deposit.id || item.orderId === state.deposit.orderId
      );
      return matches ? { ...state.deposit } : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const match =
        (where.id && where.id === state.deposit.id) ||
        (where.orderId && where.orderId === state.deposit.orderId);
      if (!match) {
        throw new Error("Deposit not found");
      }
      return { ...state.deposit };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      if (where.id !== state.deposit.id) {
        throw new Error("Deposit not found");
      }
      Object.assign(state.deposit, data);
      return { ...state.deposit };
    }),
    create: vi.fn(async ({ data }: any) => {
      Object.assign(state.deposit, {
        id: "dep-created",
        userId: data.userId,
        accountId: data.accountId,
        provider: data.provider,
        providerPaymentId: data.providerPaymentId,
        orderId: data.orderId,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        rawPayload: data.rawPayload,
        ledgerEntryId: null,
        creditedAt: null
      });
      return { ...state.deposit };
    })
  };

  const userBalanceAccount = {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.userId === state.account.userId) {
        return { ...state.account };
      }
      return null;
    }),
    create: vi.fn(async ({ data }: any) => {
      Object.assign(state.account, {
        id: `acc-${data.userId}`,
        userId: data.userId,
        balance: 0
      });
      return { ...state.account };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      if (where.id !== state.account.id) {
        throw new Error("Account not found");
      }
      const increment = Number(data.balance.increment ?? 0);
      state.account.balance += increment;
      return { ...state.account };
    })
  };

  const balanceLedgerEntry = {
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `ledger-${state.ledgerEntries.length + 1}`,
        ...data
      };
      state.ledgerEntries.push(row);
      return row;
    })
  };

  const prismaTx: any = {
    $executeRaw: vi.fn(async () => 1),
    providerEventLog,
    depositTransaction,
    userBalanceAccount,
    balanceLedgerEntry,
    botPaymentProviderConfig: {
      findUnique: vi.fn(async () => null)
    },
    ownerSettlementEntry: {
      create: vi.fn(async () => ({}))
    }
  };

  const prisma: any = {
    providerEventLog,
    depositTransaction,
    userBalanceAccount,
    balanceLedgerEntry,
    user: {
      findFirst: vi.fn(async () => ({ id: "owner-1", role: "ALPHA_OWNER" }))
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prismaTx))
  };

  const service = new BalanceService(
    prisma,
    notifications as any,
    audit as any,
    { assignTag: vi.fn().mockResolvedValue(undefined) } as any,
    undefined,
    undefined,
    opts?.onDepositCredited
  );

  return {
    service,
    prisma,
    notifications,
    audit,
    state
  };
}

describe("BalanceService NOWPayments flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("credits a deposit exactly once for a valid signed IPN", async () => {
    const { service, notifications, audit, state } = createBalanceHarness();
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 10
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const result = await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        credited: true,
        status: "finished"
      })
    );
    expect(state.deposit.status).toBe("CONFIRMED");
    expect(state.deposit.ledgerEntryId).toBe("ledger-1");
    expect(state.account.balance).toBe(10);
    expect(state.ledgerEntries).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("treats duplicate webhook delivery as idempotent and does not double-credit", async () => {
    const { service, state } = createBalanceHarness();
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 10
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const first = await service.processNowPaymentsIpn(rawBody, signature);
    const second = await service.processNowPaymentsIpn(rawBody, signature);

    expect(first.credited).toBe(true);
    expect(second).toEqual(
      expect.objectContaining({
        ok: true,
        duplicate: true
      })
    );
    expect(state.account.balance).toBe(10);
    expect(state.ledgerEntries).toHaveLength(1);
  });

  it("maps terminal failed NOWPayments statuses to FAILED without crediting", async () => {
    const { service, state, notifications } = createBalanceHarness();
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "expired",
      price_amount: 10
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const result = await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        status: "expired"
      })
    );
    expect(state.deposit.status).toBe("FAILED");
    expect(state.account.balance).toBe(0);
  });

  it("credits full 10 USDT when 9.80 received (98% tolerance)", async () => {
    const { service, state } = createBalanceHarness();
    Object.assign(state.deposit, { requestedAmountUsd: 10 });
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 10,
      pay_amount: 9.8,
      outcome_amount: 9.8
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const result = await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(result).toEqual(expect.objectContaining({ ok: true, credited: true }));
    expect(state.account.balance).toBe(10);
  });

  it("does not credit when 9.79 received (below 98% of 10 USDT)", async () => {
    const { service, state } = createBalanceHarness();
    Object.assign(state.deposit, { requestedAmountUsd: 10 });
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 10,
      pay_amount: 9.79,
      outcome_amount: 9.79
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const result = await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(result.credited).toBeFalsy();
    expect(state.account.balance).toBe(0);
  });

  it("credits full 30 USDT when 29.40 received (98% tolerance)", async () => {
    const { service, state } = createBalanceHarness();
    Object.assign(state.deposit, { requestedAmountUsd: 30, amount: 30 });
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 30,
      pay_amount: 29.4,
      outcome_amount: 29.4
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const result = await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(result).toEqual(expect.objectContaining({ ok: true, credited: true }));
    expect(state.account.balance).toBe(30);
  });

  it("calls onDepositCredited with deposit.botInstanceId for multi-bot routing", async () => {
    const onDepositCredited = vi.fn().mockResolvedValue(undefined);
    const { service, state } = createBalanceHarness({ onDepositCredited });
    Object.assign(state.deposit, {
      requestedAmountUsd: 10,
      botInstanceId: "bot-A",
      rawPayload: { requestedProductId: "product-1" }
    });
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 10,
      pay_amount: 10,
      outcome_amount: 10
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(onDepositCredited).toHaveBeenCalledTimes(1);
    expect(onDepositCredited).toHaveBeenCalledWith(
      expect.objectContaining({
        depositId: state.deposit.id,
        botInstanceId: "bot-A",
        creditedAmount: 10,
        productId: "product-1"
      })
    );
  });

  it("does not credit as full when underpaid (exchange fee deducted)", async () => {
    const { service, state } = createBalanceHarness();
    Object.assign(state.deposit, { requestedAmountUsd: 10 });
    const payload = {
      order_id: state.deposit.orderId,
      payment_id: state.deposit.providerPaymentId,
      payment_status: "finished",
      price_amount: 10,
      pay_amount: 9.5,
      outcome_amount: 9.5
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, "test-ipn-secret");

    const result = await service.processNowPaymentsIpn(rawBody, signature);
    await flushAsyncWork();

    expect(result.credited).toBeFalsy();
    expect(state.account.balance).toBe(0);
  });

  it("confirms a pending deposit through trusted status polling without IPN signature", async () => {
    const { service, state } = createBalanceHarness();
    (service as any).nowPayments = {
      getPaymentStatus: vi.fn().mockResolvedValue({
        payment_id: state.deposit.providerPaymentId,
        payment_status: "finished",
        pay_address: "wallet-address",
        price_amount: 10,
        price_currency: "usdt",
        pay_amount: 10.25,
        pay_currency: "usdtbsc",
        order_id: state.deposit.orderId,
        outcome_amount: 9.8,
        outcome_currency: "usdt"
      })
    };

    const result = await service.checkDepositStatus(state.deposit.id);
    await flushAsyncWork();

    expect(result).toEqual({ status: "confirmed", credited: true });
    expect(state.deposit.status).toBe("CONFIRMED");
    expect(state.account.balance).toBe(10);
    expect(state.ledgerEntries).toHaveLength(1);
  });

  it("returns null when NOWPayments createPayment fails so caller can fallback to direct checkout", async () => {
    const { service, prisma, state } = createBalanceHarness();
    (service as any).nowPayments = {
      createPayment: vi.fn().mockRejectedValue(new Error("provider unavailable"))
    };

    const result = await service.createDepositIntent(state.user as any, 10, "USDT", "USDT_BEP20");

    expect(result).toBeNull();
    expect(prisma.depositTransaction.create).toHaveBeenCalled();
    expect(prisma.depositTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          providerStatus: "create_failed"
        })
      })
    );
  });

  it("retries NOWPayments createPayment once on provider 500 and succeeds", async () => {
    const { service, prisma, state } = createBalanceHarness();
    const createPayment = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "NOWPayments createPayment failed: 500 {\"status\":false,\"statusCode\":500,\"code\":\"INTERNAL_ERROR\"}"
        )
      )
      .mockResolvedValueOnce({
        payment_id: 777,
        payment_status: "waiting",
        pay_address: "0xwallet",
        price_amount: 10,
        price_currency: "usd",
        pay_amount: 10,
        pay_currency: "usdtbsc"
      });
    (service as any).nowPayments = { createPayment };

    const result = await service.createDepositIntent(state.user as any, 10, "USDT", "USDT_BEP20");

    expect(result).toEqual(expect.objectContaining({ payAddress: "0xwallet" }));
    expect(createPayment).toHaveBeenCalledTimes(2);
    expect(prisma.depositTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerPaymentId: "777",
          providerPayAddress: "0xwallet"
        })
      })
    );
  });

  it("extends active temporary access on balance renewal and reschedules expiry from the previous end date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T19:00:00.000Z"));

    const currentActiveUntil = new Date("2026-03-26T19:00:00.000Z");
    const product = {
      id: "product-1",
      isActive: true,
      price: "10",
      currency: "USDT",
      billingType: "TEMPORARY",
      durationMinutes: null,
      durationDays: 30,
      linkedChats: [],
      localizations: []
    };
    const user = {
      id: "user-1",
      selectedLanguage: "ru",
      telegramUserId: 111n,
      botInstanceId: "bot-1"
    };

    const notifications = {
      sendText: vi.fn().mockResolvedValue(undefined)
    };
    const audit = {
      log: vi.fn().mockResolvedValue(undefined)
    };
    const crm = {
      assignTag: vi.fn().mockResolvedValue(undefined)
    };
    const scheduler = {
      cancelByIdempotencyKeyPrefix: vi.fn().mockResolvedValue(1)
    };
    const subscriptionChannel = {
      scheduleRemindersAndExpiry: vi.fn().mockResolvedValue(undefined),
      onAccessGranted: vi.fn().mockResolvedValue(undefined)
    };

    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      userBalanceAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "acc-1", balance: 25 }),
        update: vi.fn().mockResolvedValue(undefined)
      },
      productPurchase: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "purchase-1" })
      },
      balanceLedgerEntry: {
        create: vi.fn().mockResolvedValue({ id: "ledger-1" })
      },
      userAccessRight: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "access-1", activeUntil: currentActiveUntil }),
        create: vi.fn(),
        update: vi.fn().mockImplementation(async ({ where, data }: any) => ({
          id: where.id,
          activeUntil: data.activeUntil
        }))
      },
      user: {
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const prisma = {
      product: {
        findUnique: vi.fn().mockResolvedValue(product)
      },
      userBalanceAccount: {
        findUnique: vi.fn().mockResolvedValue({ id: "acc-1", balance: 25 })
      },
      productPurchase: {
        findFirst: vi.fn().mockResolvedValue(null)
      },
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: "owner-1", role: "ALPHA_OWNER" })
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    };

    const service = new BalanceService(
      prisma as any,
      notifications as any,
      audit as any,
      crm as any,
      scheduler as any,
      subscriptionChannel as any
    );

    const result = await service.purchaseFromBalance(user as any, product.id);

    expect(result).toEqual({ success: true, accessGranted: true });
    const expectedActiveUntil = new Date("2026-04-25T19:00:00.000Z");
    expect(prisma.productPurchase.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        productId: "product-1",
        status: "COMPLETED",
        createdAt: { gte: new Date("2026-03-23T18:59:30.000Z") }
      },
      select: { id: true }
    });
    expect(tx.productPurchase.create).toHaveBeenCalledTimes(1);
    expect(tx.userAccessRight.create).not.toHaveBeenCalled();
    expect(tx.userAccessRight.update).toHaveBeenCalledWith({
      where: { id: "access-1" },
      data: {
        accessType: "TEMPORARY",
        activeUntil: expectedActiveUntil
      }
    });
    expect(scheduler.cancelByIdempotencyKeyPrefix).toHaveBeenNthCalledWith(1, "sub-rem:access-1:");
    expect(scheduler.cancelByIdempotencyKeyPrefix).toHaveBeenNthCalledWith(2, "access-exp:access-1");
    expect(subscriptionChannel.scheduleRemindersAndExpiry).toHaveBeenCalledWith(
      "access-1",
      expectedActiveUntil,
      "bot-1",
      scheduler,
      product
    );
    expect(audit.log).toHaveBeenCalledWith(
      "owner-1",
      "product_purchase_balance",
      "product_purchase",
      "purchase-1",
      expect.objectContaining({
        userId: "user-1",
        productId: "product-1",
        amount: 10
      })
    );
  });
});
