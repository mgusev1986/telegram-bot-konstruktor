/**
 * Owner daily payout — aggregates PENDING settlement entries and sends via NOWPayments Mass Payout.
 */
import type { PrismaClient } from "@prisma/client";
import { logger } from "../../common/logger";
import { createNowPaymentsClientFromEnv } from "./nowpayments.client";

const PROVIDER = "nowpayments";

export interface ProcessPayoutResult {
  botInstanceId: string;
  batchId: string | null;
  entriesProcessed: number;
  netTotal: number;
  status: "sent" | "skipped" | "failed";
  error?: string;
}

export class OwnerPayoutService {
  private readonly client = createNowPaymentsClientFromEnv();

  constructor(private readonly prisma: PrismaClient) {}

  isConfigured(): boolean {
    return this.client != null;
  }

  /**
   * Process daily payout for one bot. Aggregates PENDING entries, creates batch, sends to NOWPayments.
   */
  async processBotPayout(botInstanceId: string): Promise<ProcessPayoutResult> {
    const config = await this.prisma.botPaymentProviderConfig.findUnique({
      where: { botInstanceId }
    });

    if (
      !config ||
      !config.enabled ||
      !config.ownerPayoutEnabled ||
      !config.dailyPayoutEnabled ||
      !config.ownerWalletAddress?.trim()
    ) {
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: 0,
        netTotal: 0,
        status: "skipped",
        error: "Payout not configured or disabled"
      };
    }

    const minAmount = Number(config.dailyPayoutMinAmount);
    const entries = await this.prisma.ownerSettlementEntry.findMany({
      where: {
        botInstanceId,
        status: "PENDING"
      },
      orderBy: { createdAt: "asc" }
    });

    const grossTotal = entries.reduce((s, e) => s + Number(e.grossAmount), 0);
    const netTotal = entries.reduce((s, e) => s + Number(e.netAmountBeforePayoutFee), 0);

    if (entries.length === 0 || netTotal < minAmount) {
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: 0,
        netTotal,
        status: "skipped",
        error: entries.length === 0 ? "No pending entries" : `Net total ${netTotal} below min ${minAmount}`
      };
    }

    if (!this.client) {
      return {
        botInstanceId,
        batchId: null,
        entriesProcessed: entries.length,
        netTotal,
        status: "failed",
        error: "NOWPayments payout client not configured"
      };
    }

    const settlementCurrency = (config.settlementCurrency ?? "usdttrc20").toLowerCase();
    const runDate = new Date();
    runDate.setHours(0, 0, 0, 0);

    const batch = await this.prisma.ownerPayoutBatch.create({
      data: {
        botInstanceId,
        runDate,
        currency: "USDT",
        status: "CREATED",
        entriesCount: entries.length,
        grossTotal,
        processorFeeTotal: entries.reduce((s, e) => s + Number(e.processorFeeAmount), 0),
        platformFeeTotal: entries.reduce((s, e) => s + Number(e.platformFeeAmount), 0),
        payoutNetworkFeeTotal: entries.reduce((s, e) => s + Number(e.payoutNetworkFeeAmount), 0),
        netTotal
      }
    });

    try {
      const response = await this.client.createMassPayoutBatch({
        withdrawals: [
          {
            address: config.ownerWalletAddress.trim(),
            currency: settlementCurrency,
            amount: Number(Number(netTotal).toFixed(6))
          }
        ]
      });

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
        await tx.ownerSettlementEntry.updateMany({
          where: { id: { in: entries.map((e) => e.id) } },
          data: {
            status: "BATCHED",
            batchId: batch.id
          }
        });
      });

      logger.info(
        {
          provider: PROVIDER,
          botInstanceId,
          batchId: batch.id,
          providerBatchId: response.id,
          entriesCount: entries.length,
          netTotal
        },
        "Owner payout batch sent"
      );

      return {
        botInstanceId,
        batchId: batch.id,
        entriesProcessed: entries.length,
        netTotal,
        status: "sent"
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
        entriesProcessed: entries.length,
        netTotal,
        status: "failed",
        error: errMsg
      };
    }
  }

  /**
   * Process daily payouts for all bots with payout enabled.
   */
  async processAllBots(): Promise<ProcessPayoutResult[]> {
    const configs = await this.prisma.botPaymentProviderConfig.findMany({
      where: {
        enabled: true,
        ownerPayoutEnabled: true,
        dailyPayoutEnabled: true,
        ownerWalletAddress: { not: null }
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
