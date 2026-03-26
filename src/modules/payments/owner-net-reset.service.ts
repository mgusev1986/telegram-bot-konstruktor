import type { PrismaClient } from "@prisma/client";

import { AuditService } from "../audit/audit.service";

export interface ResetOwnerNetResult {
  botInstanceId: string;
  pendingBeforeNetAmount: number;
  pendingAfterNetAmount: number;
  entriesResetCount: number;
}

export class OwnerNetResetService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService
  ) {}

  /**
   * Admin reset: переводит текущие OwnerSettlementEntry в статус RESET,
   * тем самым исключая их из backoffice pending-показателей и payout-потока,
   * сохраняя строки в истории (без удаления).
   */
  public async resetPendingOwnerNet(opts: {
    botInstanceId: string;
    actorUserId: string;
    note?: string | null;
  }): Promise<ResetOwnerNetResult> {
    const { botInstanceId, actorUserId, note } = opts;

    const { pendingBeforeNetAmount, entriesResetCount } = await this.prisma.$transaction(async (tx) => {
      const pendingAgg = await tx.ownerSettlementEntry.aggregate({
        where: { botInstanceId, status: "PENDING" },
        _count: true,
        _sum: { netAmountBeforePayoutFee: true }
      });

      const pendingBeforeNetAmount = Number(pendingAgg._sum.netAmountBeforePayoutFee ?? 0);
      const entriesResetCount = await tx.ownerSettlementEntry.updateMany({
        where: { botInstanceId, status: "PENDING" },
        data: { status: "RESET" }
      });

      return { pendingBeforeNetAmount, entriesResetCount: entriesResetCount.count };
    });

    const pendingAfterAgg = await this.prisma.ownerSettlementEntry.aggregate({
      where: { botInstanceId, status: "PENDING" },
      _sum: { netAmountBeforePayoutFee: true }
    });
    const pendingAfterNetAmount = Number(pendingAfterAgg._sum.netAmountBeforePayoutFee ?? 0);

    await this.audit.log(actorUserId, "reset_owner_net_pending", "bot_instance", botInstanceId, {
      pendingBeforeNetAmount,
      pendingAfterNetAmount,
      entriesResetCount,
      note: note ?? null
    });

    return {
      botInstanceId,
      pendingBeforeNetAmount,
      pendingAfterNetAmount,
      entriesResetCount
    };
  }
}

