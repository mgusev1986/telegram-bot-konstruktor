import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env", () => ({
  env: {
    NOWPAYMENTS_API_KEY: "",
    NOWPAYMENTS_EMAIL: "",
    NOWPAYMENTS_PASSWORD: "",
    LOG_LEVEL: "info"
  }
}));

vi.mock("../src/common/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { OwnerPayoutService } from "../src/modules/payments/owner-payout.service";

describe("OwnerPayoutService", () => {
  it("isConfigured returns false when client is null", () => {
    const prisma = {} as any;
    const service = new OwnerPayoutService(prisma);
    expect(service.isConfigured()).toBe(false);
  });

  it("processBotPayout returns skipped when config not found", async () => {
    const prisma = {
      botPaymentProviderConfig: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    } as any;
    const service = new OwnerPayoutService(prisma);
    const result = await service.processBotPayout("bot-1");
    expect(result.status).toBe("skipped");
    expect(result.entriesProcessed).toBe(0);
  });

  it("processBotPayout returns skipped when ownerPayoutEnabled is false", async () => {
    const prisma = {
      botPaymentProviderConfig: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true,
          ownerPayoutEnabled: false,
          dailyPayoutEnabled: true,
          ownerWalletAddress: "T..."
        })
      }
    } as any;
    const service = new OwnerPayoutService(prisma);
    const result = await service.processBotPayout("bot-1");
    expect(result.status).toBe("skipped");
  });

  it("processBotPayout returns skipped when no pending entries", async () => {
    const prisma = {
      botPaymentProviderConfig: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true,
          ownerPayoutEnabled: true,
          dailyPayoutEnabled: true,
          ownerWalletAddress: "0x1111111111111111111111111111111111111111",
          dailyPayoutMinAmount: 0,
          settlementCurrency: "usdttrc20"
        })
      },
      ownerSettlementEntry: {
        findMany: vi.fn().mockResolvedValue([])
      },
      botRoleAssignment: {
        findMany: vi.fn().mockResolvedValue([])
      },
      botOwnerPayoutWallet: {
        findMany: vi.fn().mockResolvedValue([])
      }
    } as any;
    const service = new OwnerPayoutService(prisma);
    const result = await service.processBotPayout("bot-1");
    expect(result.status).toBe("skipped");
    expect(result.error).toContain("No pending");
  });
});
