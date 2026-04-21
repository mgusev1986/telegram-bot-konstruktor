import { describe, expect, it, vi } from "vitest";

vi.mock("../src/common/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

import { ReferralCommissionService } from "../src/modules/referrals/referral-commission.service";

interface MockUplineRow {
  id: string;
  level: number;
}

interface TxState {
  config: {
    id: string;
    botInstanceId: string;
    enabled: boolean;
    currency: string;
    levels: Array<{ level: number; percent: number }>;
  } | null;
  upline: MockUplineRow[];
  balances: Map<string, number>; // userId -> balance
  accounts: Map<string, string>; // userId -> accountId
  createdAccruals: any[];
  createdLedgerEntries: any[];
  existingAccrualKeys: Set<string>;
}

function buildTx(state: TxState) {
  const $executeRaw = vi.fn().mockResolvedValue(1);
  const $queryRaw = vi.fn().mockImplementation(async () => state.upline);

  const referralProgramConfig = {
    findUnique: vi.fn(async () => state.config)
  };

  const referralCommissionAccrual = {
    findUnique: vi.fn(async ({ where }: any) => {
      const { productPurchaseId, partnerUserId, level } =
        where.productPurchaseId_partnerUserId_level ?? {};
      const key = `${productPurchaseId}|${partnerUserId}|${level}`;
      return state.existingAccrualKeys.has(key) ? { id: "existing" } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const key = `${data.productPurchaseId}|${data.partnerUserId}|${data.level}`;
      state.existingAccrualKeys.add(key);
      const row = { id: `accrual-${state.createdAccruals.length + 1}`, ...data };
      state.createdAccruals.push(row);
      return row;
    })
  };

  const userBalanceAccount = {
    findUnique: vi.fn(async ({ where }: any) => {
      const userId = where.userId;
      const id = state.accounts.get(userId);
      if (!id) return null;
      return { id };
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const id = where.id;
      const userId = [...state.accounts.entries()].find(([, accId]) => accId === id)?.[0];
      return { id, userId, balance: state.balances.get(userId ?? "") ?? 0 };
    }),
    create: vi.fn(async ({ data }: any) => {
      const accId = `acc-${data.userId}`;
      state.accounts.set(data.userId, accId);
      state.balances.set(data.userId, 0);
      return { id: accId };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const userId = [...state.accounts.entries()].find(([, id]) => id === where.id)?.[0] ?? "";
      const current = state.balances.get(userId) ?? 0;
      const inc = Number(data.balance?.increment ?? 0);
      state.balances.set(userId, current + inc);
      return { id: where.id };
    })
  };

  const balanceLedgerEntry = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `ledger-${state.createdLedgerEntries.length + 1}`, ...data };
      state.createdLedgerEntries.push(row);
      return row;
    })
  };

  return {
    $executeRaw,
    $queryRaw,
    referralProgramConfig,
    referralCommissionAccrual,
    userBalanceAccount,
    balanceLedgerEntry
  } as any;
}

function baseState(): TxState {
  return {
    config: {
      id: "cfg-1",
      botInstanceId: "bot-1",
      enabled: true,
      currency: "USDT",
      levels: [
        { level: 1, percent: 20 },
        { level: 2, percent: 10 },
        { level: 3, percent: 5 }
      ]
    },
    upline: [
      { id: "user-L1", level: 1 },
      { id: "user-L2", level: 2 },
      { id: "user-L3", level: 3 }
    ],
    balances: new Map([
      ["user-L1", 0],
      ["user-L2", 100],
      ["user-L3", 50]
    ]),
    accounts: new Map([
      ["user-L1", "acc-L1"],
      ["user-L2", "acc-L2"],
      ["user-L3", "acc-L3"]
    ]),
    createdAccruals: [],
    createdLedgerEntries: [],
    existingAccrualKeys: new Set()
  };
}

describe("ReferralCommissionService.accrueForPurchase", () => {
  it("credits commissions for each upline level with exact amounts", async () => {
    const state = baseState();
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    const result = await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "purchase-1",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 100
    });

    expect(result.credited).toHaveLength(3);
    expect(result.credited.map((c) => c.level)).toEqual([1, 2, 3]);
    expect(result.credited.map((c) => c.amount)).toEqual([20, 10, 5]);
    expect(state.balances.get("user-L1")).toBe(20);
    expect(state.balances.get("user-L2")).toBe(110);
    expect(state.balances.get("user-L3")).toBe(55);
    expect(state.createdAccruals).toHaveLength(3);
    expect(state.createdLedgerEntries.every((e) => e.type === "REFERRAL_COMMISSION")).toBe(true);
  });

  it("is idempotent: second call for same purchase does not duplicate", async () => {
    const state = baseState();
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "purchase-1",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 100
    });

    const balancesAfterFirst = new Map(state.balances);
    const accrualsAfterFirst = state.createdAccruals.length;

    const second = await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "purchase-1",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 100
    });

    expect(second.credited).toHaveLength(0);
    expect(state.createdAccruals.length).toBe(accrualsAfterFirst);
    for (const [userId, balance] of balancesAfterFirst) {
      expect(state.balances.get(userId)).toBe(balance);
    }
  });

  it("skips when program is disabled", async () => {
    const state = baseState();
    state.config!.enabled = false;
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    const result = await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "purchase-1",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 100
    });

    expect(result.credited).toHaveLength(0);
    expect(result.skippedReason).toBe("program_disabled");
    expect(state.createdAccruals).toHaveLength(0);
  });

  it("skips when upline is empty (top-level buyer)", async () => {
    const state = baseState();
    state.upline = [];
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    const result = await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "purchase-2",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 100
    });

    expect(result.credited).toHaveLength(0);
    expect(result.skippedReason).toBe("no_upline");
  });

  it("skips levels with zero percent", async () => {
    const state = baseState();
    state.config!.levels = [
      { level: 1, percent: 30 },
      { level: 2, percent: 0 }
    ];
    state.upline = [
      { id: "user-L1", level: 1 },
      { id: "user-L2", level: 2 }
    ];
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    const result = await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "purchase-3",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 50
    });

    expect(result.credited).toHaveLength(1);
    expect(result.credited[0]).toMatchObject({ level: 1, amount: 15 });
    expect(state.balances.get("user-L2")).toBe(100);
  });

  it("skips when basis amount is zero or negative", async () => {
    const state = baseState();
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    const zero = await svc.accrueForPurchase({
      tx,
      botInstanceId: "bot-1",
      productPurchaseId: "p0",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 0
    });
    expect(zero.skippedReason).toBe("zero_basis");
    expect(zero.credited).toHaveLength(0);
  });

  it("skips when botInstanceId is null (top-level call without bot)", async () => {
    const state = baseState();
    const tx = buildTx(state);
    const svc = new ReferralCommissionService({} as any);

    const res = await svc.accrueForPurchase({
      tx,
      botInstanceId: null,
      productPurchaseId: "p0",
      productId: "prod-1",
      buyerUserId: "buyer-1",
      basisAmount: 10
    });
    expect(res.skippedReason).toBe("no_bot_instance");
  });
});
