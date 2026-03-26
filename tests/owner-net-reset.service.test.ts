import { describe, expect, it, vi } from "vitest";

import { OwnerNetResetService } from "../src/modules/payments/owner-net-reset.service";

describe("OwnerNetResetService", () => {
  it("resets only selected bot pending entries (PENDING -> RESET) and audits the action", async () => {
    let aggregateCall = 0;

    const ownerSettlementEntry = {
      aggregate: vi.fn(async (_args: any) => {
        aggregateCall += 1;
        // 1st call: before reset
        if (aggregateCall === 1) return { _sum: { netAmountBeforePayoutFee: 49.43 } };
        // 2nd call: after reset
        return { _sum: { netAmountBeforePayoutFee: 0 } };
      }),
      updateMany: vi.fn(async (args: any) => ({ count: 3, ...args }))
    };

    const prisma = {
      ownerSettlementEntry,
      $transaction: vi.fn(async (cb: any) => cb(prisma))
    } as any;

    const audit = {
      log: vi.fn().mockResolvedValue(undefined)
    } as any;

    const svc = new OwnerNetResetService(prisma, audit);

    const res = await svc.resetPendingOwnerNet({
      botInstanceId: "bot-1",
      actorUserId: "admin-1",
      note: "test-note"
    });

    expect(ownerSettlementEntry.updateMany).toHaveBeenCalledWith({
      where: { botInstanceId: "bot-1", status: "PENDING" },
      data: { status: "RESET" }
    });

    expect(res).toEqual({
      botInstanceId: "bot-1",
      pendingBeforeNetAmount: 49.43,
      pendingAfterNetAmount: 0,
      entriesResetCount: 3
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith("admin-1", "reset_owner_net_pending", "bot_instance", "bot-1", {
      pendingBeforeNetAmount: 49.43,
      pendingAfterNetAmount: 0,
      entriesResetCount: 3,
      note: "test-note"
    });
  });
});

