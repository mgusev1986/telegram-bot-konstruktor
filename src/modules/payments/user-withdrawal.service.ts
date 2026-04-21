/**
 * End-user withdrawal flow for partner commission balance.
 *
 * Lifecycle:
 *   PENDING  → (admin approve OR auto-approve) → APPROVED
 *   APPROVED → (processWithdrawal) → SENT → COMPLETED
 *   PENDING/APPROVED → (reject / fail) → REJECTED or FAILED + balance reversal
 *
 * Funds are locked (DEBIT) at request time to prevent double-spend.
 * When a request is rejected or fails, a WITHDRAWAL_REVERSAL ledger entry
 * refunds the balance exactly once.
 *
 * Uses NOWPayments Mass Payout API — payouts are sent from the platform's
 * NOWPayments wallet to the user-provided external wallet address.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient, WithdrawalRequestStatus } from "@prisma/client";

import { logger } from "../../common/logger";
import {
  createNowPaymentsClientFromEnv,
  NowPaymentsClient,
  NowPaymentsPayoutNotConfiguredError,
  NowPaymentsProviderError
} from "./nowpayments.client";

const EVM_BEP20_REGEX = /^0x[0-9a-fA-F]{40}$/;
const TRON_TRC20_REGEX = /^T[A-Za-z0-9]{33}$/;
const TON_REGEX = /^(EQ|UQ)[A-Za-z0-9_-]{46}$/;

export type WithdrawalNetwork = "usdtbsc" | "usdttrc20" | "ton";

export interface RequestWithdrawalParams {
  userId: string;
  botInstanceId: string | null;
  amount: number;
  payoutAddress: string;
  payoutCurrency?: WithdrawalNetwork | string;
}

export type RequestWithdrawalError =
  | "program_disabled"
  | "invalid_amount"
  | "below_minimum"
  | "insufficient_balance"
  | "invalid_address"
  | "pending_exists"
  | "unknown_bot";

export type RequestWithdrawalResult =
  | { ok: true; withdrawalId: string; status: WithdrawalRequestStatus; autoSubmitted: boolean }
  | { ok: false; error: RequestWithdrawalError; message?: string };

export interface ProcessWithdrawalResult {
  withdrawalId: string;
  status: "sent" | "failed" | "skipped";
  providerBatchId?: string;
  providerPayoutId?: string;
  error?: string;
}

export class UserWithdrawalService {
  private readonly client: NowPaymentsClient | null = createNowPaymentsClientFromEnv();

  constructor(private readonly prisma: PrismaClient) {}

  isPayoutConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Create a withdrawal request for an end-user partner.
   * Locks funds via WITHDRAWAL_DEBIT ledger entry. Optionally auto-submits to NOWPayments.
   */
  async requestWithdrawal(params: RequestWithdrawalParams): Promise<RequestWithdrawalResult> {
    const { userId, botInstanceId, amount } = params;
    const payoutAddress = params.payoutAddress.trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "invalid_amount" };
    }
    if (!botInstanceId) {
      return { ok: false, error: "unknown_bot" };
    }

    const config = await this.prisma.referralProgramConfig.findUnique({
      where: { botInstanceId }
    });
    if (!config || !config.enabled) {
      return { ok: false, error: "program_disabled" };
    }

    const minAmount = Number(config.minWithdrawalAmount);
    if (amount < minAmount) {
      return { ok: false, error: "below_minimum", message: String(minAmount) };
    }

    const payoutCurrency = (params.payoutCurrency ?? config.payoutCurrency ?? "usdtbsc")
      .toString()
      .toLowerCase();

    if (!isAddressValidForCurrency(payoutAddress, payoutCurrency)) {
      return { ok: false, error: "invalid_address" };
    }

    const existingPending = await this.prisma.withdrawalRequest.findFirst({
      where: {
        userId,
        status: { in: ["PENDING", "APPROVED", "SENT"] }
      },
      select: { id: true }
    });
    if (existingPending) {
      return { ok: false, error: "pending_exists" };
    }

    const account = await this.ensureAccount(userId);
    const minReserve = Number(config.minBalanceReserve);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT 1 FROM user_balance_accounts WHERE id = ${account.id} FOR UPDATE`
      );
      const acc = await tx.userBalanceAccount.findUniqueOrThrow({ where: { id: account.id } });
      const balance = Number(acc.balance);
      if (balance < amount + minReserve) {
        return { ok: false as const, error: "insufficient_balance" as const };
      }

      const debitEntry = await tx.balanceLedgerEntry.create({
        data: {
          accountId: account.id,
          type: "WITHDRAWAL_DEBIT",
          amount: -amount,
          balanceAfter: balance - amount,
          referenceType: "withdrawal_request",
          referenceId: "pending",
          metadata: {
            payoutAddress,
            payoutCurrency,
            botInstanceId
          }
        }
      });

      await tx.userBalanceAccount.update({
        where: { id: account.id },
        data: { balance: { decrement: amount } }
      });

      const wr = await tx.withdrawalRequest.create({
        data: {
          userId,
          accountId: account.id,
          botInstanceId,
          amount,
          currency: config.currency,
          status: "PENDING",
          payoutAddress,
          payoutCurrency,
          debitLedgerEntryId: debitEntry.id
        }
      });

      await tx.balanceLedgerEntry.update({
        where: { id: debitEntry.id },
        data: { referenceId: wr.id }
      });

      return { ok: true as const, withdrawalId: wr.id };
    });

    if (!created.ok) {
      return { ok: false, error: created.error };
    }

    let status: WithdrawalRequestStatus = "PENDING";
    let autoSubmitted = false;

    if (config.autoApproveWithdrawals) {
      const approved = await this.approveWithdrawal(created.withdrawalId, {
        actor: "auto"
      });
      if (approved) status = "APPROVED";

      if (this.client) {
        const submitted = await this.processWithdrawal(created.withdrawalId).catch((err) => {
          logger.warn(
            { err, withdrawalId: created.withdrawalId },
            "auto-submit withdrawal failed; left in APPROVED"
          );
          return null;
        });
        if (submitted?.status === "sent") {
          status = "SENT";
          autoSubmitted = true;
        }
      }
    }

    return { ok: true, withdrawalId: created.withdrawalId, status, autoSubmitted };
  }

  async approveWithdrawal(
    id: string,
    opts?: { actor?: "auto" | "admin"; approvedBy?: string | null }
  ): Promise<boolean> {
    const wr = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return false;
    if (wr.status !== "PENDING") return false;
    await this.prisma.withdrawalRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        metadata: {
          ...(wr.metadata && typeof wr.metadata === "object" ? (wr.metadata as Record<string, unknown>) : {}),
          approvedBy: opts?.approvedBy ?? opts?.actor ?? null
        }
      }
    });
    return true;
  }

  /**
   * Submit APPROVED withdrawal to NOWPayments Mass Payout API.
   * On provider error: marks as FAILED and reverses the balance.
   */
  async processWithdrawal(id: string): Promise<ProcessWithdrawalResult> {
    if (!this.client) {
      return { withdrawalId: id, status: "skipped", error: "payout_not_configured" };
    }

    const wr = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return { withdrawalId: id, status: "skipped", error: "not_found" };
    if (wr.status !== "APPROVED") {
      return { withdrawalId: id, status: "skipped", error: `invalid_status_${wr.status}` };
    }
    if (!wr.payoutAddress || !wr.payoutCurrency) {
      return { withdrawalId: id, status: "skipped", error: "missing_payout_address" };
    }

    try {
      const response = await this.client.createMassPayoutBatch({
        withdrawals: [
          {
            address: wr.payoutAddress,
            currency: wr.payoutCurrency,
            amount: Number(Number(wr.amount).toFixed(6))
          }
        ]
      });
      const first = response.withdrawals?.[0];
      await this.prisma.withdrawalRequest.update({
        where: { id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerBatchId: response.id,
          providerPayoutId: first?.id != null ? String(first.id) : null,
          providerStatus: first?.status ?? null,
          providerResponse: response as unknown as Prisma.InputJsonValue
        }
      });
      logger.info(
        { withdrawalId: id, providerBatchId: response.id },
        "Withdrawal submitted to NOWPayments Mass Payout"
      );
      return {
        withdrawalId: id,
        status: "sent",
        providerBatchId: response.id,
        providerPayoutId: first?.id != null ? String(first.id) : undefined
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isNotConfigured = err instanceof NowPaymentsPayoutNotConfiguredError;
      const isProviderError = err instanceof NowPaymentsProviderError;

      logger.warn(
        { withdrawalId: id, err: errMsg, isNotConfigured, isProviderError },
        "processWithdrawal: submit failed"
      );

      await this.markFailedAndReverse(id, errMsg.slice(0, 500));

      return { withdrawalId: id, status: "failed", error: errMsg };
    }
  }

  /**
   * Poll NOWPayments for status and move SENT → COMPLETED / FAILED.
   * Called from a cron job or manually.
   */
  async pollProviderStatus(id: string): Promise<"completed" | "failed" | "pending" | "skipped"> {
    if (!this.client) return "skipped";
    const wr = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!wr || wr.status !== "SENT" || !wr.providerBatchId) return "skipped";
    try {
      const status = await this.client.getPayoutBatchStatus(wr.providerBatchId);
      const line = status.withdrawals?.find(
        (w) => wr.providerPayoutId && String(w.id) === wr.providerPayoutId
      ) ?? status.withdrawals?.[0];

      const raw = (line?.status ?? "").toLowerCase();

      if (raw === "finished" || raw === "paid" || raw === "completed") {
        await this.prisma.withdrawalRequest.update({
          where: { id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            providerStatus: raw,
            providerResponse: status as unknown as Prisma.InputJsonValue
          }
        });
        return "completed";
      }

      if (raw === "failed" || raw === "rejected" || raw === "error") {
        await this.markFailedAndReverse(id, `provider_status=${raw}`);
        return "failed";
      }

      await this.prisma.withdrawalRequest.update({
        where: { id },
        data: { providerStatus: raw || "pending" }
      });
      return "pending";
    } catch (err) {
      logger.warn({ withdrawalId: id, err }, "pollProviderStatus failed");
      return "skipped";
    }
  }

  async rejectWithdrawal(id: string, reason: string): Promise<boolean> {
    const wr = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return false;
    if (!["PENDING", "APPROVED"].includes(wr.status)) return false;
    await this.reverseAndUpdate(id, {
      status: "REJECTED",
      failedAt: new Date(),
      errorMessage: reason.slice(0, 500)
    });
    return true;
  }

  private async markFailedAndReverse(id: string, reason: string): Promise<void> {
    await this.reverseAndUpdate(id, {
      status: "FAILED",
      failedAt: new Date(),
      errorMessage: reason
    });
  }

  private async reverseAndUpdate(
    id: string,
    update: {
      status: WithdrawalRequestStatus;
      failedAt: Date;
      errorMessage: string;
    }
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const wr = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!wr) return;
      const alreadyReversed = await tx.balanceLedgerEntry.findFirst({
        where: {
          accountId: wr.accountId,
          type: "WITHDRAWAL_REVERSAL",
          referenceType: "withdrawal_request",
          referenceId: wr.id
        },
        select: { id: true }
      });
      if (!alreadyReversed) {
        await tx.$executeRaw(
          Prisma.sql`SELECT 1 FROM user_balance_accounts WHERE id = ${wr.accountId} FOR UPDATE`
        );
        const acc = await tx.userBalanceAccount.findUniqueOrThrow({ where: { id: wr.accountId } });
        const newBalance = Number(acc.balance) + Number(wr.amount);
        await tx.balanceLedgerEntry.create({
          data: {
            accountId: wr.accountId,
            type: "WITHDRAWAL_REVERSAL",
            amount: Number(wr.amount),
            balanceAfter: newBalance,
            referenceType: "withdrawal_request",
            referenceId: wr.id,
            metadata: { reason: update.errorMessage }
          }
        });
        await tx.userBalanceAccount.update({
          where: { id: wr.accountId },
          data: { balance: { increment: Number(wr.amount) } }
        });
      }
      await tx.withdrawalRequest.update({
        where: { id },
        data: {
          status: update.status,
          failedAt: update.failedAt,
          errorMessage: update.errorMessage
        }
      });
    });
  }

  private async ensureAccount(userId: string): Promise<{ id: string }> {
    const existing = await this.prisma.userBalanceAccount.findUnique({
      where: { userId },
      select: { id: true }
    });
    if (existing) return existing;
    return this.prisma.userBalanceAccount.create({ data: { userId }, select: { id: true } });
  }
}

function isAddressValidForCurrency(address: string, currency: string): boolean {
  if (!address) return false;
  const cur = currency.toLowerCase();
  if (cur === "usdtbsc" || cur === "usdtbep20") return EVM_BEP20_REGEX.test(address);
  if (cur === "usdttrc20") return TRON_TRC20_REGEX.test(address);
  if (cur === "ton") return TON_REGEX.test(address);
  return address.length >= 10 && address.length <= 128;
}
