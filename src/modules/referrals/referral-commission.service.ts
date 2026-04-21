/**
 * Multi-level referral commission engine.
 *
 * - `accrueForPurchase` walks up the `users.invited_by_user_id` chain after a
 *   ProductPurchase is committed and credits every upline partner with a share
 *   of the gross price according to the bot's ReferralProgramConfig.
 * - Runs inside the same Prisma transaction as the purchase itself, so a crash
 *   before commit rolls back both the DEBIT on the buyer and the CREDIT on the
 *   partners — no ghost commissions.
 * - Idempotent via the unique (product_purchase_id, partner_user_id, level) index.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../../common/logger";

type TxClient = Prisma.TransactionClient;

const MAX_CHAIN_LENGTH = 50;

export interface AccrueCommissionsParams {
  tx: TxClient;
  botInstanceId: string | null;
  productPurchaseId: string;
  productId: string;
  buyerUserId: string;
  basisAmount: number;
}

export interface AccrueCommissionsResult {
  credited: Array<{
    partnerUserId: string;
    level: number;
    amount: number;
    percent: number;
  }>;
  skippedReason?: "program_disabled" | "no_levels" | "no_upline" | "no_bot_instance" | "zero_basis";
}

interface LoadedLevel {
  level: number;
  percent: number;
}

interface LoadedConfig {
  id: string;
  botInstanceId: string;
  enabled: boolean;
  currency: string;
  levels: LoadedLevel[];
}

export interface PartnerEarningsSummary {
  totalAmount: number;
  totalAccruals: number;
  perLevel: Array<{ level: number; amount: number; count: number }>;
}

export interface PartnerAccrualRow {
  id: string;
  level: number;
  percent: number;
  amount: number;
  currency: string;
  createdAt: Date;
  productId: string;
  productTitle: string | null;
  sourceUserId: string;
  sourceDisplayName: string;
}

export class ReferralCommissionService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Load config + levels for a bot. Returns null if no config row exists. */
  async getConfigForBot(botInstanceId: string): Promise<LoadedConfig | null> {
    const row = await this.prisma.referralProgramConfig.findUnique({
      where: { botInstanceId },
      include: {
        levels: {
          orderBy: { level: "asc" }
        }
      }
    });
    if (!row) return null;
    return {
      id: row.id,
      botInstanceId: row.botInstanceId,
      enabled: row.enabled,
      currency: row.currency,
      levels: row.levels.map((l) => ({ level: l.level, percent: Number(l.percent) }))
    };
  }

  /**
   * Credit referral commissions up the upline for a completed purchase.
   * MUST be called inside the same transaction that created the ProductPurchase.
   */
  async accrueForPurchase(params: AccrueCommissionsParams): Promise<AccrueCommissionsResult> {
    const { tx, botInstanceId, productPurchaseId, productId, buyerUserId, basisAmount } = params;

    if (!botInstanceId) {
      return { credited: [], skippedReason: "no_bot_instance" };
    }
    if (!Number.isFinite(basisAmount) || basisAmount <= 0) {
      return { credited: [], skippedReason: "zero_basis" };
    }

    const config = await tx.referralProgramConfig.findUnique({
      where: { botInstanceId },
      include: {
        levels: { orderBy: { level: "asc" } }
      }
    });

    if (!config || !config.enabled) {
      return { credited: [], skippedReason: "program_disabled" };
    }

    const activeLevels = config.levels
      .map((l) => ({ level: l.level, percent: Number(l.percent) }))
      .filter((l) => l.level > 0 && l.percent > 0);

    if (activeLevels.length === 0) {
      return { credited: [], skippedReason: "no_levels" };
    }

    const maxLevel = activeLevels.reduce((max, l) => Math.max(max, l.level), 0);
    const upline = await this.walkUpline(tx, buyerUserId, Math.min(maxLevel, MAX_CHAIN_LENGTH));

    if (upline.length === 0) {
      return { credited: [], skippedReason: "no_upline" };
    }

    const credited: AccrueCommissionsResult["credited"] = [];

    for (const { userId: partnerUserId, level } of upline) {
      const rule = activeLevels.find((l) => l.level === level);
      if (!rule) continue;

      const amount = roundAmount((basisAmount * rule.percent) / 100);
      if (amount <= 0) continue;

      const existing = await tx.referralCommissionAccrual.findUnique({
        where: {
          productPurchaseId_partnerUserId_level: {
            productPurchaseId,
            partnerUserId,
            level
          }
        }
      });
      if (existing) continue;

      const account = await this.getOrCreateBalanceAccount(tx, partnerUserId);

      await tx.$executeRaw(
        Prisma.sql`SELECT 1 FROM user_balance_accounts WHERE id = ${account.id} FOR UPDATE`
      );

      const refreshedAccount = await tx.userBalanceAccount.findUniqueOrThrow({
        where: { id: account.id }
      });
      const newBalance = Number(refreshedAccount.balance) + amount;

      const ledgerEntry = await tx.balanceLedgerEntry.create({
        data: {
          accountId: account.id,
          type: "REFERRAL_COMMISSION",
          amount,
          balanceAfter: newBalance,
          referenceType: "referral_commission_accrual",
          referenceId: productPurchaseId,
          metadata: {
            level,
            percent: rule.percent,
            sourceUserId: buyerUserId,
            productId
          }
        }
      });

      await tx.userBalanceAccount.update({
        where: { id: account.id },
        data: { balance: { increment: amount } }
      });

      await tx.referralCommissionAccrual.create({
        data: {
          botInstanceId,
          configId: config.id,
          partnerUserId,
          sourceUserId: buyerUserId,
          productPurchaseId,
          productId,
          level,
          percent: rule.percent,
          basisAmount,
          amount,
          currency: config.currency,
          ledgerEntryId: ledgerEntry.id,
          status: "CREDITED"
        }
      });

      credited.push({ partnerUserId, level, amount, percent: rule.percent });
    }

    if (credited.length > 0) {
      logger.info(
        {
          botInstanceId,
          productPurchaseId,
          buyerUserId,
          basisAmount,
          creditedCount: credited.length,
          creditedTotal: credited.reduce((s, c) => s + c.amount, 0)
        },
        "Referral commissions credited"
      );
    }

    return { credited };
  }

  /** Aggregate earnings for a partner: total, per-level breakdown. */
  async getEarningsSummary(userId: string): Promise<PartnerEarningsSummary> {
    const rows = await this.prisma.referralCommissionAccrual.findMany({
      where: { partnerUserId: userId, status: "CREDITED" },
      select: { level: true, amount: true }
    });

    const perLevelMap = new Map<number, { amount: number; count: number }>();
    let totalAmount = 0;
    for (const row of rows) {
      const amt = Number(row.amount);
      totalAmount += amt;
      const cur = perLevelMap.get(row.level) ?? { amount: 0, count: 0 };
      cur.amount += amt;
      cur.count += 1;
      perLevelMap.set(row.level, cur);
    }

    const perLevel = [...perLevelMap.entries()]
      .map(([level, v]) => ({ level, amount: roundAmount(v.amount), count: v.count }))
      .sort((a, b) => a.level - b.level);

    return {
      totalAmount: roundAmount(totalAmount),
      totalAccruals: rows.length,
      perLevel
    };
  }

  /** Recent commission accruals for partner cabinet history screen. */
  async getRecentAccruals(userId: string, limit: number = 10): Promise<PartnerAccrualRow[]> {
    const rows = await this.prisma.referralCommissionAccrual.findMany({
      where: { partnerUserId: userId, status: "CREDITED" },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 50),
      include: {
        source: {
          select: { username: true, fullName: true, firstName: true, telegramUserId: true }
        },
        productPurchase: {
          include: {
            product: {
              include: {
                localizations: { take: 1 }
              }
            }
          }
        }
      }
    });

    return rows.map((r) => {
      const src = r.source;
      const displayName =
        (src?.username ? `@${src.username}` : src?.fullName || src?.firstName) ||
        (src?.telegramUserId ? String(src.telegramUserId) : "—");
      const loc = r.productPurchase?.product?.localizations?.[0];
      return {
        id: r.id,
        level: r.level,
        percent: Number(r.percent),
        amount: Number(r.amount),
        currency: r.currency,
        createdAt: r.createdAt,
        productId: r.productId,
        productTitle: loc?.title ?? null,
        sourceUserId: r.sourceUserId,
        sourceDisplayName: displayName
      };
    });
  }

  /** Upsert config row. Levels are replaced atomically. */
  async upsertProgram(params: {
    botInstanceId: string;
    enabled: boolean;
    minWithdrawalAmount: number;
    minBalanceReserve: number;
    autoApproveWithdrawals: boolean;
    payoutCurrency: string | null;
    description: string | null;
    levels: Array<{ level: number; percent: number }>;
  }): Promise<void> {
    const cleaned = dedupeLevels(params.levels);

    await this.prisma.$transaction(async (tx) => {
      const config = await tx.referralProgramConfig.upsert({
        where: { botInstanceId: params.botInstanceId },
        create: {
          botInstanceId: params.botInstanceId,
          enabled: params.enabled,
          minWithdrawalAmount: params.minWithdrawalAmount,
          minBalanceReserve: params.minBalanceReserve,
          autoApproveWithdrawals: params.autoApproveWithdrawals,
          payoutCurrency: params.payoutCurrency,
          description: params.description
        },
        update: {
          enabled: params.enabled,
          minWithdrawalAmount: params.minWithdrawalAmount,
          minBalanceReserve: params.minBalanceReserve,
          autoApproveWithdrawals: params.autoApproveWithdrawals,
          payoutCurrency: params.payoutCurrency,
          description: params.description
        }
      });

      await tx.referralCommissionLevel.deleteMany({ where: { configId: config.id } });

      if (cleaned.length > 0) {
        await tx.referralCommissionLevel.createMany({
          data: cleaned.map((l) => ({
            configId: config.id,
            level: l.level,
            percent: l.percent
          }))
        });
      }
    });
  }

  /**
   * Walk upline chain via users.invited_by_user_id. Returns levels starting at 1.
   * Protects against cycles (invariant should hold thanks to ReferralService.validateInviter,
   * but we stop anyway if we revisit a node).
   */
  private async walkUpline(
    tx: TxClient,
    startUserId: string,
    maxLevel: number
  ): Promise<Array<{ userId: string; level: number }>> {
    if (maxLevel <= 0) return [];

    const rows = await tx.$queryRaw<Array<{ id: string; level: number }>>`
      WITH RECURSIVE uplink AS (
        SELECT u.id, u.invited_by_user_id, 1 AS level
        FROM users u
        WHERE u.id = ${startUserId} AND u.invited_by_user_id IS NOT NULL
        UNION ALL
        SELECT parent.id, parent.invited_by_user_id, up.level + 1
        FROM users parent
        INNER JOIN uplink up ON parent.id = up.invited_by_user_id
        WHERE up.level < ${maxLevel}
          AND parent.invited_by_user_id IS NOT NULL
      )
      SELECT invited_by_user_id AS id, level
      FROM uplink
      WHERE invited_by_user_id IS NOT NULL
      ORDER BY level ASC
    `;

    const seen = new Set<string>();
    const result: Array<{ userId: string; level: number }> = [];
    for (const row of rows) {
      if (seen.has(row.id)) break;
      seen.add(row.id);
      if (row.id === startUserId) break;
      result.push({ userId: row.id, level: row.level });
    }
    return result;
  }

  private async getOrCreateBalanceAccount(tx: TxClient, userId: string): Promise<{ id: string }> {
    const existing = await tx.userBalanceAccount.findUnique({
      where: { userId },
      select: { id: true }
    });
    if (existing) return existing;
    return tx.userBalanceAccount.create({
      data: { userId },
      select: { id: true }
    });
  }
}

function roundAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e8) / 1e8;
}

function dedupeLevels(
  levels: Array<{ level: number; percent: number }>
): Array<{ level: number; percent: number }> {
  const byLevel = new Map<number, number>();
  for (const { level, percent } of levels) {
    if (!Number.isFinite(level) || level < 1) continue;
    if (!Number.isFinite(percent) || percent < 0) continue;
    if (percent > 100) continue;
    byLevel.set(Math.floor(level), percent);
  }
  return [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, percent]) => ({ level, percent }));
}
