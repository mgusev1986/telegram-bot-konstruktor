/**
 * Owner daily payout — aggregates PENDING settlement entries, splits by owner wallet / pool, sends via NOWPayments Mass Payout.
 */
import type { PrismaClient } from "@prisma/client";
import { logger } from "../../common/logger";
import { createNowPaymentsClientFromEnv } from "./nowpayments.client";
import { attributeOwnerUserIdFromDepositor } from "./owner-settlement-attribution";

const PROVIDER = "nowpayments";
const EVM_BEP20 = /^0x[0-9a-fA-F]{40}$/;

export interface ProcessPayoutResult {
  botInstanceId: string;
  batchId: string | null;
  entriesProcessed: number;
  netTotal: number;
  status: "sent" | "skipped" | "failed";
  error?: string;
  /** Distinct payout destinations in the mass payout request */
  withdrawalLines?: number;
}

type SettlementEntryWithDeposit = {
  id: string;
  attributedOwnerUserId: string | null;
  grossAmount: unknown;
  processorFeeAmount: unknown;
  platformFeeAmount: unknown;
  payoutNetworkFeeAmount: unknown;
  netAmountBeforePayoutFee: unknown;
  depositTransaction: {
    user: { invitedByUserId: string | null; mentorUserId: string | null } | null;
  } | null;
};

export class OwnerPayoutService {
  private readonly client = createNowPaymentsClientFromEnv();

  constructor(private readonly prisma: PrismaClient) {}

  isConfigured(): boolean {
    return this.client != null;
  }

  /**
   * Resolve attributed owner for an entry (DB field or live rule from depositor).
   */
  private resolveAttributedOwnerId(
    entry: SettlementEntryWithDeposit,
    ownerUserIdSet: Set<string>
  ): string | null {
    const stored = entry.attributedOwnerUserId;
    if (stored && ownerUserIdSet.has(stored)) return stored;
    const u = entry.depositTransaction?.user;
    return attributeOwnerUserIdFromDepositor(ownerUserIdSet, u);
  }

  /**
   * Process daily payout for one bot. Routes each PENDING line to OWNER wallet or pool; one mass payout with merged lines per address.
   */
  async processBotPayout(botInstanceId: string): Promise<ProcessPayoutResult> {
    const config = await this.prisma.botPaymentProviderConfig.findUnique({
      where: { botInstanceId }
    });

    if (!config || !config.enabled || !config.ownerPayoutEnabled || !config.dailyPayoutEnabled) {
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: 0,
        netTotal: 0,
        status: "skipped",
        error: "Payout not configured or disabled"
      };
    }

    const poolAddressRaw = config.ownerWalletAddress?.trim() ?? "";
    const poolAddress = EVM_BEP20.test(poolAddressRaw) ? poolAddressRaw : null;
    const minAmount = Number(config.dailyPayoutMinAmount);

    const [entries, ownerAssignments, ownerWallets] = await Promise.all([
      this.prisma.ownerSettlementEntry.findMany({
        where: { botInstanceId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        include: {
          depositTransaction: {
            include: {
              user: { select: { invitedByUserId: true, mentorUserId: true } }
            }
          }
        }
      }),
      this.prisma.botRoleAssignment.findMany({
        where: { botInstanceId, role: "OWNER", status: "ACTIVE", userId: { not: null } },
        select: { userId: true }
      }),
      this.prisma.botOwnerPayoutWallet.findMany({ where: { botInstanceId } })
    ]);

    const ownerUserIdSet = new Set(ownerAssignments.map((a) => a.userId!).filter(Boolean));
    const ownerWalletMap = new Map<string, string>();
    for (const w of ownerWallets) {
      const addr = w.walletAddress.trim();
      if (EVM_BEP20.test(addr)) ownerWalletMap.set(w.ownerUserId, addr);
    }

    type Routed = {
      entry: (typeof entries)[number];
      payoutAddress: string;
      attributed: string | null;
    };

    const routed: Routed[] = [];

    for (const entry of entries) {
      const attributed = this.resolveAttributedOwnerId(entry, ownerUserIdSet);
      let payoutAddress: string | null = null;
      if (attributed) {
        const ind = ownerWalletMap.get(attributed);
        if (ind && EVM_BEP20.test(ind)) {
          payoutAddress = ind;
        } else if (poolAddress) {
          payoutAddress = poolAddress;
        }
      } else if (poolAddress) {
        payoutAddress = poolAddress;
      }
      if (!payoutAddress) continue;
      routed.push({ entry, payoutAddress, attributed });
    }

    if (routed.length === 0) {
      const err =
        entries.length === 0
          ? "No pending entries"
          : "No routable entries (set общий кошелёк и/или BEP20-кошельки OWNER)";
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: 0,
        netTotal: 0,
        status: "skipped",
        error: err
      };
    }

    const netTotal = routed.reduce((s, r) => s + Number(r.entry.netAmountBeforePayoutFee), 0);
    if (netTotal < minAmount) {
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: 0,
        netTotal,
        status: "skipped",
        error: `Net total ${netTotal} below min ${minAmount}`
      };
    }

    if (!this.client) {
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: routed.length,
        netTotal,
        status: "failed",
        error: "NOWPayments payout client not configured"
      };
    }

    const settlementCurrency = (config.settlementCurrency ?? "usdtbep20").toLowerCase().replace("usdttrc20", "usdtbep20");
    const runDate = new Date();
    runDate.setHours(0, 0, 0, 0);

    const grossTotal = routed.reduce((s, r) => s + Number(r.entry.grossAmount), 0);
    const batch = await this.prisma.ownerPayoutBatch.create({
      data: {
        botInstanceId,
        runDate,
        currency: "USDT",
        status: "CREATED",
        entriesCount: routed.length,
        grossTotal,
        processorFeeTotal: routed.reduce((s, r) => s + Number(r.entry.processorFeeAmount), 0),
        platformFeeTotal: routed.reduce((s, r) => s + Number(r.entry.platformFeeAmount), 0),
        payoutNetworkFeeTotal: routed.reduce((s, r) => s + Number(r.entry.payoutNetworkFeeAmount), 0),
        netTotal
      }
    });

    const withdrawalMap = new Map<string, number>();
    for (const r of routed) {
      const n = Number(r.entry.netAmountBeforePayoutFee);
      withdrawalMap.set(r.payoutAddress, (withdrawalMap.get(r.payoutAddress) ?? 0) + n);
    }

    const withdrawals = [...withdrawalMap.entries()].map(([address, amount]) => ({
      address,
      currency: settlementCurrency,
      amount: Number(amount.toFixed(8))
    }));

    type RecipientAgg = {
      ownerUserId: string | null;
      walletAddress: string;
      net: number;
      count: number;
    };
    const recipientKey = (ownerUserId: string | null, wallet: string) => `${ownerUserId ?? "POOL"}|${wallet}`;
    const recipientMap = new Map<string, RecipientAgg>();
    for (const r of routed) {
      const key = recipientKey(r.attributed, r.payoutAddress);
      const cur = recipientMap.get(key) ?? {
        ownerUserId: r.attributed,
        walletAddress: r.payoutAddress,
        net: 0,
        count: 0
      };
      cur.net += Number(r.entry.netAmountBeforePayoutFee);
      cur.count += 1;
      recipientMap.set(key, cur);
    }

    try {
      const response = await this.client.createMassPayoutBatch({ withdrawals });

      await this.prisma.$transaction(async (tx) => {
        await tx.ownerPayoutBatch.update({
          where: { id: batch.id },
          data: {
            status: "SENT",
            providerBatchId: response.id,
            providerResponseJson: response as unknown as object,
            executedAt: new Date()
          }
        });

        for (const rec of recipientMap.values()) {
          await tx.ownerPayoutBatchRecipient.create({
            data: {
              batchId: batch.id,
              ownerUserId: rec.ownerUserId,
              walletAddress: rec.walletAddress,
              netAmount: rec.net,
              entryCount: rec.count
            }
          });
        }

        for (const r of routed) {
          const attr =
            r.entry.attributedOwnerUserId ?? attributeOwnerUserIdFromDepositor(ownerUserIdSet, r.entry.depositTransaction?.user ?? null);
          await tx.ownerSettlementEntry.update({
            where: { id: r.entry.id },
            data: {
              status: "BATCHED",
              batchId: batch.id,
              payoutWalletAddress: r.payoutAddress,
              attributedOwnerUserId: attr
            }
          });
        }
      });

      logger.info(
        {
          provider: PROVIDER,
          botInstanceId,
          batchId: batch.id,
          providerBatchId: response.id,
          entriesCount: routed.length,
          netTotal,
          withdrawalLines: withdrawals.length
        },
        "Owner payout batch sent (split)"
      );

      return {
        botInstanceId,
        batchId: batch.id,
        entriesProcessed: routed.length,
        netTotal,
        status: "sent",
        withdrawalLines: withdrawals.length
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(
        { provider: PROVIDER, botInstanceId, batchId: batch.id, error: errMsg },
        "Owner payout batch failed"
      );
      await this.prisma.ownerPayoutBatch.update({
        where: { id: batch.id },
        data: {
          status: "FAILED",
          errorMessage: errMsg.slice(0, 2000)
        }
      });
      return {
        botInstanceId,
        batchId: batch.id,
        entriesProcessed: routed.length,
        netTotal,
        status: "failed",
        error: errMsg
      };
    }
  }

  /**
   * Process daily payouts for all bots with payout enabled (общий кошелёк не обязателен, если все суммы уходят на индив. адреса).
   */
  async processAllBots(): Promise<ProcessPayoutResult[]> {
    const configs = await this.prisma.botPaymentProviderConfig.findMany({
      where: {
        enabled: true,
        ownerPayoutEnabled: true,
        dailyPayoutEnabled: true
      },
      select: { botInstanceId: true }
    });

    const results: ProcessPayoutResult[] = [];
    for (const { botInstanceId } of configs) {
      const r = await this.processBotPayout(botInstanceId);
      results.push(r);
    }
    return results;
  }
}
