/**
 * Balance-based payment flow: internal ledger, deposits, product purchases.
 */
import { Prisma } from "@prisma/client";
import type {
  DepositTransactionStatus,
  PaymentNetwork,
  PrismaClient,
  Product,
  User
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuditService } from "../audit/audit.service";
import type { CrmService } from "../crm/crm.service";
import type { NotificationService } from "../notifications/notification.service";
import type { SchedulerService } from "../jobs/scheduler.service";
import type { SubscriptionChannelService } from "../subscription-channel/subscription-channel.service";
import { env } from "../../config/env";
import { logger } from "../../common/logger";
import { NowPaymentsAdapter } from "./nowpayments.adapter";
import { isTemporaryAccessProduct } from "../subscription-channel/subscription-access-policy";
import { grantOrExtendAccess } from "./access-grant";
import {
  attributeOwnerUserIdFromDepositor,
  loadActiveOwnerUserIdsForBot
} from "./owner-settlement-attribution";

const PROVIDER = "nowpayments";
const NOWPAYMENTS_FINAL_SUCCESS_STATUSES = new Set(["finished"]);
const NOWPAYMENTS_FAILURE_STATUSES = new Set(["failed", "refunded", "expired"]);
/** Fixed-price top-up: credit full expectedAmount if received >= this fraction (98%). */
const CREDIT_TOLERANCE_PERCENT = 98;

type NowPaymentsProcessSource = "ipn" | "status_sync";
export type NowPaymentsProcessResult = {
  ok: boolean;
  credited?: boolean;
  duplicate?: boolean;
  status?: string;
  error?: string;
  /** When credited: deposit with user for notification routing by deposit.botInstanceId */
  deposit?: {
    id: string;
    userId: string;
    botInstanceId: string | null;
    user: { telegramUserId: string; selectedLanguage: string };
    currency: string;
    productId?: string;
  };
  creditedAmount?: number;
  currency?: string;
};

function normalizeNowPaymentsStatus(status: unknown): string {
  return String(status ?? "").trim().toLowerCase();
}

function mapNowPaymentsStatusToDepositStatus(status: string): DepositTransactionStatus {
  if (NOWPAYMENTS_FINAL_SUCCESS_STATUSES.has(status)) {
    return "CONFIRMED";
  }
  if (NOWPAYMENTS_FAILURE_STATUSES.has(status)) {
    return "FAILED";
  }
  return "PENDING";
}

function readNowPaymentsAmount(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function readRequestedProductId(rawPayload: unknown): string | undefined {
  if (!rawPayload || typeof rawPayload !== "object") return undefined;
  const value = (rawPayload as Record<string, unknown>).requestedProductId;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Merge NOWPayments payload into deposit.rawPayload — never drop requestedProductId / createPaymentResponse from createDepositIntent. */
function mergeDepositRawPayload(existing: unknown, providerUpdate: Record<string, unknown>): object {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, ...providerUpdate };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DepositIntent {
  depositId: string;
  orderId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  network: PaymentNetwork;
  amount: number;
  currency: string;
}

export interface PurchaseResult {
  success: boolean;
  accessGranted: boolean;
  error?: string;
  linkedChats?: unknown;
}

export interface EmergencyConfirmResult {
  ok: boolean;
  alreadyConfirmed?: boolean;
  error?: "not_found" | "invalid_amount";
  depositId?: string;
  creditedAmount?: number;
}

export interface DepositStatusResult {
  status: string;
  credited?: boolean;
  creditedAmount?: number;
  expectedAmount?: number;
  missingAmount?: number;
}

export class BalanceService {
  private readonly nowPayments: NowPaymentsAdapter | null =
    env.NOWPAYMENTS_API_KEY?.trim()
      ? new NowPaymentsAdapter(env.NOWPAYMENTS_API_KEY!, env.NOWPAYMENTS_BASE_URL)
      : null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly crm: CrmService,
    private readonly scheduler?: SchedulerService,
    private readonly subscriptionChannel?: SubscriptionChannelService,
    private readonly onDepositCredited?: (params: {
      depositId: string;
      userId: string;
      botInstanceId: string | null;
      telegramUserId: string;
      selectedLanguage: string;
      creditedAmount: number;
      currency: string;
      productId?: string;
    }) => Promise<void>
  ) {}

  isNowPaymentsEnabled(): boolean {
    return this.nowPayments != null && Boolean(env.NOWPAYMENTS_IPN_SECRET?.trim());
  }

  /** Diagnostic: why NOWPayments might be disabled (no secrets logged). */
  getNowPaymentsDiagnostics(): {
    hasApiKey: boolean;
    hasIpnSecret: boolean;
    hasIpnCallbackUrl: boolean;
    enabled: boolean;
  } {
    const hasApiKey = Boolean(env.NOWPAYMENTS_API_KEY?.trim());
    const hasIpnSecret = Boolean(env.NOWPAYMENTS_IPN_SECRET?.trim());
    const hasIpnCallbackUrl = Boolean(env.NOWPAYMENTS_IPN_CALLBACK_URL?.trim());
    return {
      hasApiKey,
      hasIpnSecret,
      hasIpnCallbackUrl,
      enabled: this.nowPayments != null && hasIpnSecret
    };
  }

  async getOrCreateAccount(userId: string): Promise<{ id: string; balance: number }> {
    let account = await this.prisma.userBalanceAccount.findUnique({
      where: { userId }
    });
    if (!account) {
      account = await this.prisma.userBalanceAccount.create({
        data: { userId }
      });
    }
    return { id: account.id, balance: Number(account.balance) };
  }

  async getBalance(userId: string): Promise<number> {
    const { balance } = await this.getOrCreateAccount(userId);
    return balance;
  }

  /**
   * Create deposit intent — returns per-user payment details from NOWPayments.
   * Flow: 1) create local DepositTransaction, 2) call NOWPayments, 3) update with provider data.
   * orderId format: bot:{botId}:user:{userId}:topup:{uuid} for webhook correlation.
   *
   * Previous PENDING deposits for the same user are never cancelled or superseded: each has its own
   * orderId, address and NOWPayments payment. IPN/polling credits whichever payment completes; no conflict.
   */
  async createDepositIntent(
    user: User,
    amount: number,
    currency: string,
    network: PaymentNetwork,
    productId?: string
  ): Promise<DepositIntent | null> {
    const botId = user.botInstanceId ?? "global";
    const diag = this.getNowPaymentsDiagnostics();

    if (!this.nowPayments) {
      logger.warn(
        {
          userId: user.id,
          botId,
          productAmount: amount,
          currency,
          network,
          hasApiKey: diag.hasApiKey,
          hasIpnSecret: diag.hasIpnSecret,
          hasIpnCallbackUrl: diag.hasIpnCallbackUrl
        },
        "createDepositIntent: NOWPayments adapter is null (missing NOWPAYMENTS_API_KEY)"
      );
      return null;
    }

    const { id: accountId } = await this.getOrCreateAccount(user.id);
    const orderId = `bot:${botId}:user:${user.id}:topup:${randomUUID().slice(0, 12)}`;

    const deposit = await this.prisma.depositTransaction.create({
      data: {
        userId: user.id,
        accountId,
        botInstanceId: user.botInstanceId ?? undefined,
        provider: PROVIDER,
        orderId,
        amount,
        currency,
        status: "PENDING",
        requestedAmountUsd: currency.toUpperCase() === "USD" || currency.toUpperCase() === "USDT" ? amount : undefined,
        rawPayload: productId ? ({ requestedProductId: productId } as object) : undefined
      }
    });

    const payCurrency = NowPaymentsAdapter.payCurrencyFromNetwork(network);
    const ipnUrl = env.NOWPAYMENTS_IPN_CALLBACK_URL?.trim() || undefined;
    if (!ipnUrl) {
      logger.warn(
        { userId: user.id, provider: PROVIDER, orderId },
        "NOWPayments createDepositIntent: ipn_callback_url is not configured; status polling will be the only confirmation path"
      );
    }

    try {
      // NOWPayments fails with "Can not get estimate from USDT to USDTBSC" when price_currency=usdt.
      // Use "usd" as price_currency — it's the API base, and USDT ≈ USD 1:1.
      const priceCurrencyForApi = (currency?.toUpperCase() === "USDT" || currency?.toUpperCase() === "USD") ? "usd" : currency?.toLowerCase() ?? "usd";
      const maxAttempts = 2;
      let resp: Awaited<ReturnType<NowPaymentsAdapter["createPayment"]>> | null = null;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          resp = await this.nowPayments.createPayment({
            priceAmount: amount,
            priceCurrency: priceCurrencyForApi,
            payCurrency,
            orderId,
            orderDescription: `Deposit ${amount} ${currency}`,
            ipnCallbackUrl: ipnUrl,
            fixedRate: true
          });
          break;
        } catch (err) {
          lastError = err;
          const errMsg = err instanceof Error ? err.message : String(err);
          const isRetryable =
            /\b500\b/.test(errMsg) || errMsg.toUpperCase().includes("INTERNAL_ERROR");
          const willRetry = isRetryable && attempt < maxAttempts;

          logger.warn(
            {
              userId: user.id,
              botId,
              provider: PROVIDER,
              orderId,
              depositId: deposit.id,
              attempt,
              maxAttempts,
              isRetryable,
              willRetry,
              error: errMsg
            },
            "createDepositIntent: NOWPayments createPayment attempt failed"
          );

          if (!willRetry) break;
          await sleep(600);
        }
      }

      if (!resp) {
        throw (lastError ?? new Error("NOWPayments createPayment failed without response"));
      }

      await this.prisma.depositTransaction.update({
        where: { id: deposit.id },
        data: {
          providerPaymentId: String(resp.payment_id),
          providerStatus: resp.payment_status ?? undefined,
          providerPayAddress: resp.pay_address ?? undefined,
          rawPayload: {
            requestedProductId: productId ?? null,
            createPaymentResponse: resp
          } as object
        }
      });

      const otherPendingCount = await this.prisma.depositTransaction.count({
        where: {
          userId: user.id,
          provider: PROVIDER,
          status: "PENDING",
          id: { not: deposit.id }
        }
      });
      if (otherPendingCount > 0) {
        logger.info(
          { userId: user.id, depositId: deposit.id, orderId, otherPendingCount, botId },
          "createDepositIntent: user has other PENDING deposits; they remain valid (parallel invoices)"
        );
      }

      return {
        depositId: deposit.id,
        orderId,
        payAddress: resp.pay_address,
        payAmount: resp.pay_amount,
        payCurrency: resp.pay_currency,
        network,
        amount,
        currency
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const statusCode = typeof (error as any)?.response?.status === "number" ? (error as any).response.status : undefined;
      const statusMatch = errMsg.match(/(\d{3})\s/);
      const extractedStatus = statusMatch ? Number(statusMatch[1]) : statusCode;
      await this.prisma.depositTransaction.update({
        where: { id: deposit.id },
        data: {
          status: "FAILED",
          providerStatus: "create_failed",
          rawPayload: {
            requestedProductId: productId ?? null,
            createPaymentError: errMsg
          } as object
        }
      });

      logger.warn(
        {
          userId: user.id,
          botId,
          provider: PROVIDER,
          orderId,
          depositId: deposit.id,
          amount,
          currency,
          network,
          error: errMsg,
          statusCode: extractedStatus,
          hint:
            extractedStatus === 401
              ? "Invalid API key (NOWPAYMENTS_API_KEY)"
              : extractedStatus === 403
                ? "API key forbidden or IP not whitelisted"
                : extractedStatus === 400
                  ? "Bad request: check pay_currency, amount, or IPN URL"
                  : extractedStatus === 404
                    ? "API endpoint or resource not found"
                    : undefined
        },
        "createDepositIntent: NOWPayments createPayment failed; deposit marked FAILED"
      );
      return null;
    }
  }

  /**
   * Process IPN from NOWPayments — idempotent, credits balance on finished.
   * v1: credit actualOutcomeAmount when available, else price_amount.
   */
  async processNowPaymentsIpn(
    rawBody: string,
    signature: string | undefined
  ): Promise<NowPaymentsProcessResult> {
    const secret = env.NOWPAYMENTS_IPN_SECRET?.trim();
    if (!secret) {
      logger.warn({ provider: PROVIDER }, "NOWPayments IPN rejected: secret is not configured");
      return { ok: false, error: "ipn_secret_missing" };
    }
    if (!(await NowPaymentsAdapter.verifyIpnSignature(rawBody, signature, secret))) {
      logger.warn({ provider: PROVIDER }, "NOWPayments IPN rejected: invalid signature");
      return { ok: false, error: "invalid_signature" };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      logger.warn({ provider: PROVIDER }, "NOWPayments IPN rejected: invalid JSON");
      return { ok: false, error: "invalid_json" };
    }

    return this.processTrustedNowPaymentsPayload(payload, "ipn");
  }

  private async processTrustedNowPaymentsPayload(
    payload: Record<string, unknown>,
    source: NowPaymentsProcessSource
  ): Promise<NowPaymentsProcessResult> {
    const paymentId = String(payload.payment_id ?? "");
    const paymentStatus = normalizeNowPaymentsStatus(payload.payment_status);
    const orderId = String(payload.order_id ?? "");

    if (!paymentId || !orderId || !paymentStatus) {
      logger.warn(
        { provider: PROVIDER, source, paymentId, orderId, paymentStatus },
        "NOWPayments event rejected: missing required fields"
      );
      return { ok: false, error: "invalid_payload" };
    }

    logger.info(
      { provider: PROVIDER, source, paymentId, orderId, paymentStatus },
      "NOWPayments event received"
    );

    const eventLog = await this.prisma.providerEventLog.upsert({
      where: {
        provider_providerTxId: { provider: PROVIDER, providerTxId: paymentId }
      },
      create: {
        provider: PROVIDER,
        providerTxId: paymentId,
        orderId,
        rawPayload: payload as object,
        status: "processing"
      },
      update: {
        orderId,
        rawPayload: payload as object
      }
    });

    if (eventLog.status === "processed") {
      logger.info(
        { provider: PROVIDER, source, paymentId, orderId, paymentStatus },
        "NOWPayments event already processed"
      );
      return { ok: true, duplicate: true, status: paymentStatus };
    }

    const deposit = await this.prisma.depositTransaction.findUnique({
      where: { orderId },
      include: { user: true }
    });

    if (!deposit) {
      await this.prisma.providerEventLog.update({
        where: { id: eventLog.id },
        data: { status: "ignored", errorMessage: "Deposit not found for orderId" }
      });
      logger.warn(
        { provider: PROVIDER, source, paymentId, orderId, paymentStatus },
        "NOWPayments event ignored: deposit not found"
      );
      return { ok: true, status: paymentStatus };
    }

    if (deposit.providerPaymentId && deposit.providerPaymentId !== paymentId) {
      await this.prisma.providerEventLog.update({
        where: { id: eventLog.id },
        data: { status: "ignored", errorMessage: "Payment id mismatch for orderId" }
      });
      logger.warn(
        {
          provider: PROVIDER,
          source,
          paymentId,
          orderId,
          paymentStatus,
          expectedPaymentId: deposit.providerPaymentId
        },
        "NOWPayments event ignored: payment id mismatch"
      );
      return { ok: true, status: paymentStatus };
    }

    const mappedStatus = mapNowPaymentsStatusToDepositStatus(paymentStatus);
    const requestedProductId = readRequestedProductId(deposit.rawPayload);
    logger.info(
      {
        provider: PROVIDER,
        source,
        depositId: deposit.id,
        userId: deposit.userId,
        orderId,
        providerPaymentId: paymentId,
        providerStatus: paymentStatus,
        providerPayAddress: deposit.providerPayAddress,
        requestedAmountUsd: deposit.requestedAmountUsd,
        actualOutcomeAmount: payload.outcome_amount ?? null,
        creditedBalanceAmount: deposit.creditedBalanceAmount,
        botInstanceId: deposit.botInstanceId,
        productId: requestedProductId ?? null
      },
      "NOWPayments deposit diagnostics snapshot"
    );
    const payloadRecord = payload as Record<string, unknown>;
    const processedAt = new Date();
    let credited = false;
    let duplicate = false;
    let ignored = false;
    let creditedAmountForResult = 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT 1 FROM deposit_transactions WHERE id = ${deposit.id} FOR UPDATE`
      );

      const lockedDeposit = await tx.depositTransaction.findUniqueOrThrow({
        where: { id: deposit.id }
      });

      if (lockedDeposit.providerPaymentId && lockedDeposit.providerPaymentId !== paymentId) {
        ignored = true;
        await tx.providerEventLog.update({
          where: { id: eventLog.id },
          data: { status: "ignored", errorMessage: "Payment id mismatch for locked deposit" }
        });
        return;
      }

      if (lockedDeposit.status === "CONFIRMED") {
        duplicate = true;
        await tx.providerEventLog.update({
          where: { id: eventLog.id },
          data: { status: "processed", processedAt, errorMessage: null }
        });
        return;
      }

      if (mappedStatus === "FAILED") {
        await tx.depositTransaction.update({
          where: { id: lockedDeposit.id },
          data: {
            status: "FAILED",
            providerPaymentId: lockedDeposit.providerPaymentId ?? paymentId,
            rawPayload: mergeDepositRawPayload(lockedDeposit.rawPayload, payloadRecord)
          }
        });

        await tx.providerEventLog.update({
          where: { id: eventLog.id },
          data: {
            status: "received",
            errorMessage: `Status ${paymentStatus}`
          }
        });
        return;
      }

      const normalizedPayStatus = normalizeNowPaymentsStatus(paymentStatus);
      const allowCreditablePartialStatus =
        normalizedPayStatus === "partially_paid" || normalizedPayStatus === "partially_paid_overpaid";

      if (mappedStatus === "PENDING") {
        if (allowCreditablePartialStatus) {
          const actualOutcomeProbe = readNowPaymentsAmount(payload.outcome_amount, 0);
          const payAmountProbe = readNowPaymentsAmount(payload.pay_amount, 0);
          const receivedProbe = actualOutcomeProbe > 0 ? actualOutcomeProbe : payAmountProbe;
          if (receivedProbe <= 0) {
            logger.info(
              {
                provider: PROVIDER,
                source,
                depositId: lockedDeposit.id,
                orderId,
                providerPaymentId: paymentId,
                providerStatus: paymentStatus,
                providerPayAddress: lockedDeposit.providerPayAddress,
                requestedAmountUsd: lockedDeposit.requestedAmountUsd,
                actualOutcomeAmount: payload.outcome_amount ?? null,
                creditedBalanceAmount: lockedDeposit.creditedBalanceAmount,
                botInstanceId: lockedDeposit.botInstanceId,
                productId: readRequestedProductId(lockedDeposit.rawPayload) ?? null
              },
              "NOWPayments partially_paid without outcome/pay amount yet; credit skipped"
            );
            await tx.depositTransaction.update({
              where: { id: lockedDeposit.id },
              data: {
                status: "PENDING",
                providerPaymentId: lockedDeposit.providerPaymentId ?? paymentId,
                rawPayload: mergeDepositRawPayload(lockedDeposit.rawPayload, payloadRecord)
              }
            });

            await tx.providerEventLog.update({
              where: { id: eventLog.id },
              data: {
                status: "received",
                errorMessage: `Status ${paymentStatus}`
              }
            });
            return;
          }
        } else {
          logger.info(
            {
              provider: PROVIDER,
              source,
              depositId: lockedDeposit.id,
              orderId,
              providerPaymentId: paymentId,
              providerStatus: paymentStatus,
              providerPayAddress: lockedDeposit.providerPayAddress,
              requestedAmountUsd: lockedDeposit.requestedAmountUsd,
              actualOutcomeAmount: payload.outcome_amount ?? null,
              creditedBalanceAmount: lockedDeposit.creditedBalanceAmount,
              botInstanceId: lockedDeposit.botInstanceId,
              productId: readRequestedProductId(lockedDeposit.rawPayload) ?? null
            },
            "NOWPayments status still pending; credit skipped"
          );
          await tx.depositTransaction.update({
            where: { id: lockedDeposit.id },
            data: {
              status: "PENDING",
              providerPaymentId: lockedDeposit.providerPaymentId ?? paymentId,
              rawPayload: mergeDepositRawPayload(lockedDeposit.rawPayload, payloadRecord)
            }
          });

          await tx.providerEventLog.update({
            where: { id: eventLog.id },
            data: {
              status: "received",
              errorMessage: `Status ${paymentStatus}`
            }
          });
          return;
        }
      }

      const actualOutcome = readNowPaymentsAmount(payload.outcome_amount, 0);
      const payAmount = readNowPaymentsAmount(payload.pay_amount, 0);
      const expectedAmount = Number(lockedDeposit.requestedAmountUsd ?? lockedDeposit.amount);
      const receivedAmount = actualOutcome > 0 ? actualOutcome : payAmount;
      const minAccepted = (expectedAmount * CREDIT_TOLERANCE_PERCENT) / 100;

      let creditAmount: number;
      if (receivedAmount >= minAccepted) {
        creditAmount = expectedAmount;
      } else if (receivedAmount > 0) {
        logger.warn(
          {
            provider: PROVIDER,
            depositId: lockedDeposit.id,
            expectedAmount,
            receivedAmount,
            minAccepted,
            tolerancePercent: CREDIT_TOLERANCE_PERCENT
          },
          "NOWPayments underpaid: crediting actual received amount (below tolerance threshold)"
        );
        creditAmount = receivedAmount;
      } else {
        creditAmount = readNowPaymentsAmount(payload.price_amount, expectedAmount);
      }

      const account = await tx.userBalanceAccount.update({
        where: { id: lockedDeposit.accountId },
        data: {
          balance: { increment: creditAmount }
        }
      });

      const entry = await tx.balanceLedgerEntry.create({
        data: {
          accountId: lockedDeposit.accountId,
          type: "CREDIT",
          amount: creditAmount,
          balanceAfter: account.balance,
          referenceType: "deposit",
          referenceId: lockedDeposit.id
        }
      });

      await tx.depositTransaction.update({
        where: { id: lockedDeposit.id },
        data: {
          status: "CONFIRMED",
          providerPaymentId: lockedDeposit.providerPaymentId ?? paymentId,
          creditedAt: processedAt,
          ledgerEntryId: entry.id,
          rawPayload: mergeDepositRawPayload(lockedDeposit.rawPayload, payloadRecord),
          creditedBalanceAmount: creditAmount,
          actualOutcomeAmount: actualOutcome > 0 ? actualOutcome : undefined,
          confirmedAt: processedAt,
          webhookLastProcessedAt: processedAt
        }
      });

      if (lockedDeposit.botInstanceId) {
        const config = await tx.botPaymentProviderConfig.findUnique({
          where: { botInstanceId: lockedDeposit.botInstanceId }
        });
        const platformFeePercent = config ? Number(config.platformFeePercent) : 0;
        const platformFeeFixedUsd = config ? Number(config.platformFeeFixedUsd) : 0;
        const platformFeeAmount = Math.max(
          0,
          (creditAmount * platformFeePercent) / 100 + platformFeeFixedUsd
        );
        const processorFeeAmount =
          payAmount > 0 && actualOutcome > 0 && payAmount >= actualOutcome
            ? payAmount - actualOutcome
            : 0;
        const netAmountBeforePayoutFee = Math.max(
          0,
          creditAmount - processorFeeAmount - platformFeeAmount
        );
        const depositor = await tx.user.findUnique({
          where: { id: lockedDeposit.userId },
          select: { invitedByUserId: true, mentorUserId: true }
        });
        const ownerIds = await loadActiveOwnerUserIdsForBot(tx, lockedDeposit.botInstanceId);
        const attributedOwnerUserId = attributeOwnerUserIdFromDepositor(ownerIds, depositor);
        await tx.ownerSettlementEntry.create({
          data: {
            botInstanceId: lockedDeposit.botInstanceId,
            depositTransactionId: lockedDeposit.id,
            currency: String(payload.outcome_currency ?? payload.pay_currency ?? "USDT").toUpperCase(),
            grossAmount: creditAmount,
            processorFeeAmount,
            platformFeeAmount,
            netAmountBeforePayoutFee,
            attributedOwnerUserId,
            status: "PENDING"
          }
        });
      }

      await tx.providerEventLog.update({
        where: { id: eventLog.id },
        data: { status: "processed", processedAt, errorMessage: null }
      });

      credited = true;
      creditedAmountForResult = creditAmount;
    });

    if (ignored) {
      logger.warn(
        { provider: PROVIDER, source, paymentId, orderId, paymentStatus },
        "NOWPayments event ignored during locked processing"
      );
      return { ok: true, status: paymentStatus };
    }

    if (duplicate) {
      logger.info(
        { provider: PROVIDER, source, paymentId, orderId, paymentStatus, depositId: deposit.id },
        "NOWPayments event finished but deposit was already confirmed"
      );
      return { ok: true, duplicate: true, status: paymentStatus };
    }

    if (!credited) {
      const logLevel = mappedStatus === "FAILED" ? "warn" : "info";
      logger[logLevel](
        {
          provider: PROVIDER,
          source,
          paymentId,
          orderId,
          paymentStatus,
          depositId: deposit.id,
          providerPaymentId: deposit.providerPaymentId,
          providerStatus: deposit.providerStatus,
          providerPayAddress: deposit.providerPayAddress,
          requestedAmountUsd: deposit.requestedAmountUsd,
          actualOutcomeAmount: deposit.actualOutcomeAmount,
          creditedBalanceAmount: deposit.creditedBalanceAmount,
          botInstanceId: deposit.botInstanceId,
          productId: requestedProductId ?? null,
          reason: mappedStatus === "FAILED" ? "provider_failed_status" : "pending_or_not_final"
        },
        mappedStatus === "FAILED"
          ? "NOWPayments event marked deposit as failed"
          : "NOWPayments event stored without credit"
      );
      return { ok: true, status: paymentStatus };
    }

    const creditedAmount = creditedAmountForResult;

    logger.info(
      {
        provider: PROVIDER,
        source,
        paymentId,
        orderId,
        paymentStatus,
        depositId: deposit.id,
        userId: deposit.userId,
        depositBotInstanceId: deposit.botInstanceId,
        amount: creditedAmount,
        currency: deposit.currency
      },
      "NOWPayments deposit credited (notification sent via deposit.botInstanceId)"
    );

    if (this.onDepositCredited) {
      void this.onDepositCredited({
        depositId: deposit.id,
        userId: deposit.userId,
        botInstanceId: deposit.botInstanceId,
        telegramUserId: String(deposit.user.telegramUserId),
        selectedLanguage: deposit.user.selectedLanguage,
        creditedAmount,
        currency: deposit.currency,
        productId: requestedProductId
      }).catch((err: unknown) => {
        logger.warn(
          { provider: PROVIDER, source, paymentId, orderId, depositId: deposit.id, err },
          "Deposit notification (onDepositCredited) failed"
        );
      });
    }

    void (async () => {
      const owner = await this.prisma.user.findFirst({
        where: { role: "ALPHA_OWNER" }
      });

      if (owner) {
        await this.audit.log(owner.id, "deposit_credited", "deposit_transaction", deposit.id, {
          amount: creditedAmount,
          userId: deposit.userId
        });
      }
    })().catch((err: unknown) => {
      logger.warn(
        { provider: PROVIDER, source, paymentId, orderId, depositId: deposit.id, err },
        "NOWPayments follow-up audit failed"
      );
    });

    return {
      ok: true,
      credited: true,
      status: paymentStatus,
      deposit: {
        id: deposit.id,
        userId: deposit.userId,
        botInstanceId: deposit.botInstanceId,
        user: {
          telegramUserId: String(deposit.user.telegramUserId),
          selectedLanguage: deposit.user.selectedLanguage
        },
        currency: deposit.currency,
        productId: requestedProductId
      },
      creditedAmount,
      currency: deposit.currency
    };
  }

  /**
   * Purchase product from balance — idempotent by (userId, productId).
   */
  async purchaseFromBalance(user: User, productId: string): Promise<PurchaseResult> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { localizations: true }
    });
    if (!product || !product.isActive) {
      return { success: false, accessGranted: false, error: "Product not found" };
    }

    const price = Number(product.price);
    const renewablePurchase = isTemporaryAccessProduct(product) || product.billingType === "RECURRING";
    const duplicateWindowStart = new Date(Date.now() - 30 * 1000);
    const idempotencyKey = renewablePurchase
      ? `purchase_${user.id}_${productId}_${randomUUID()}`
      : `purchase_${user.id}_${productId}`;

    if (!renewablePurchase) {
      const existing = await this.prisma.productPurchase.findUnique({
        where: { idempotencyKey }
      });
      if (existing && existing.status === "COMPLETED") {
        return { success: true, accessGranted: true };
      }
    } else {
      const recentCompletedPurchase = await this.prisma.productPurchase.findFirst({
        where: {
          userId: user.id,
          productId,
          status: "COMPLETED",
          createdAt: { gte: duplicateWindowStart }
        },
        select: { id: true }
      });
      if (recentCompletedPurchase) {
        return { success: true, accessGranted: true };
      }
    }

    const { id: accountId, balance } = await this.getOrCreateAccount(user.id);
    if (balance < price) {
      return { success: false, accessGranted: false, error: "Insufficient balance" };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT 1 FROM user_balance_accounts WHERE id = ${accountId} FOR UPDATE`);
      const acc = await tx.userBalanceAccount.findUniqueOrThrow({
        where: { id: accountId }
      });
      const currentBalance = Number(acc.balance);
      if (currentBalance < price) {
        return { success: false as const };
      }

      const existingPurchase = renewablePurchase
        ? await tx.productPurchase.findFirst({
            where: {
              userId: user.id,
              productId,
              status: "COMPLETED",
              createdAt: { gte: duplicateWindowStart }
            }
          })
        : await tx.productPurchase.findUnique({
            where: { idempotencyKey }
          });
      if (existingPurchase?.status === "COMPLETED") {
        return { success: true, alreadyCompleted: true };
      }

      const ledgerEntry = await tx.balanceLedgerEntry.create({
        data: {
          accountId,
          type: "DEBIT",
          amount: -price,
          balanceAfter: currentBalance - price,
          referenceType: "product_purchase",
          referenceId: idempotencyKey
        }
      });

      const purchase = renewablePurchase
        ? await tx.productPurchase.create({
            data: {
              userId: user.id,
              productId,
              accountId,
              amount: price,
              ledgerEntryId: ledgerEntry.id,
              idempotencyKey,
              status: "COMPLETED"
            }
          })
        : await tx.productPurchase.upsert({
            where: { idempotencyKey },
            create: {
              userId: user.id,
              productId,
              accountId,
              amount: price,
              ledgerEntryId: ledgerEntry.id,
              idempotencyKey,
              status: "COMPLETED"
            },
            update: {
              ledgerEntryId: ledgerEntry.id,
              status: "COMPLETED"
            }
          });

      await tx.userBalanceAccount.update({
        where: { id: accountId },
        data: { balance: { decrement: price } }
      });

      const accessGrant = await grantOrExtendAccess(tx.userAccessRight, {
        userId: user.id,
        productId,
        product,
        now: new Date()
      });

      await tx.user.update({
        where: { id: user.id },
        data: { status: "PAID" }
      });

      return {
        success: true,
        accessGrant,
        purchaseAuditRef: renewablePurchase ? purchase.id : idempotencyKey
      };
    });

    if (!result.success) {
      return { success: false, accessGranted: false, error: "Insufficient balance" };
    }

    if ("alreadyCompleted" in result && result.alreadyCompleted) {
      return { success: true, accessGranted: true, linkedChats: product.linkedChats ?? null };
    }

    if ("accessGrant" in result && result.accessGrant) {
      if (result.accessGrant.activeUntil && this.scheduler && this.subscriptionChannel) {
        if (result.accessGrant.extendedExisting) {
          await this.scheduler.cancelByIdempotencyKeyPrefix(`sub-rem:${result.accessGrant.accessRight.id}:`);
          await this.scheduler.cancelByIdempotencyKeyPrefix(`access-exp:${result.accessGrant.accessRight.id}`);
        }
        await this.subscriptionChannel.scheduleRemindersAndExpiry(
          result.accessGrant.accessRight.id,
          result.accessGrant.activeUntil,
          user.botInstanceId ?? null,
          this.scheduler,
          product
        );
      }

      const hasLinkedChats = Array.isArray(product.linkedChats) && (product.linkedChats as unknown[]).length > 0;
      if (hasLinkedChats && this.subscriptionChannel) {
        await this.subscriptionChannel.onAccessGranted(
          user.id,
          productId,
          user.telegramUserId
        );
      }

      const owner = await this.prisma.user.findFirst({ where: { role: "ALPHA_OWNER" } });
      if (owner) {
        try {
          await this.crm.assignTag(user.id, "paid", owner.id);
          await this.audit.log(owner.id, "product_purchase_balance", "product_purchase", result.purchaseAuditRef, {
            userId: user.id,
            productId,
            amount: price
          });
        } catch (err) {
          logger.warn(
            { userId: user.id, productId, err },
            "post-purchase CRM/audit failed (purchase already committed)"
          );
        }
      }
    }

    return { success: true, accessGranted: true, linkedChats: product.linkedChats ?? null };
  }

  async checkDepositStatus(depositIdOrOrderId: string): Promise<DepositStatusResult> {
    const deposit = await this.prisma.depositTransaction.findFirst({
      where: {
        OR: [{ id: depositIdOrOrderId }, { orderId: depositIdOrOrderId }]
      }
    });
    if (!deposit) {
      logger.warn({ provider: PROVIDER, depositIdOrOrderId }, "checkDepositStatus: deposit not found");
      return { status: "not_found" };
    }

    logger.info(
      {
        provider: PROVIDER,
        depositId: deposit.id,
        orderId: deposit.orderId,
        providerPaymentId: deposit.providerPaymentId,
        providerStatus: deposit.providerStatus,
        providerPayAddress: deposit.providerPayAddress,
        requestedAmountUsd: deposit.requestedAmountUsd,
        actualOutcomeAmount: deposit.actualOutcomeAmount,
        creditedBalanceAmount: deposit.creditedBalanceAmount,
        botInstanceId: deposit.botInstanceId,
        productId: readRequestedProductId(deposit.rawPayload) ?? null
      },
      "checkDepositStatus called"
    );

    if (deposit.status === "CONFIRMED") {
      const expectedAmount = Number(deposit.requestedAmountUsd ?? deposit.amount ?? 0);
      const creditedAmount = Number(deposit.creditedBalanceAmount ?? 0);
      const missingAmount = Math.max(0, expectedAmount - creditedAmount);
      return { status: "confirmed", credited: true, creditedAmount, expectedAmount, missingAmount };
    }
    if (deposit.status === "FAILED" && !deposit.providerPaymentId) {
      return { status: "create_failed" };
    }
    if (deposit.status === "PENDING" && this.nowPayments) {
      const paymentId = deposit.providerPaymentId;
      if (paymentId) {
        try {
          const st = await this.nowPayments.getPaymentStatus(paymentId);
          logger.info(
            {
              provider: PROVIDER,
              depositId: deposit.id,
              orderId: deposit.orderId,
              providerPaymentId: paymentId,
              providerStatus: st.payment_status,
              providerPayAddress: st.pay_address ?? deposit.providerPayAddress,
              requestedAmountUsd: deposit.requestedAmountUsd,
              actualOutcomeAmount: st.outcome_amount ?? null,
              creditedBalanceAmount: deposit.creditedBalanceAmount,
              botInstanceId: deposit.botInstanceId,
              productId: readRequestedProductId(deposit.rawPayload) ?? null
            },
            "checkDepositStatus fetched provider status"
          );
          const result = await this.processTrustedNowPaymentsPayload(
            {
              payment_id: st.payment_id,
              payment_status: st.payment_status,
              order_id: deposit.orderId,
              price_amount: st.price_amount,
              pay_amount: st.pay_amount,
              pay_currency: st.pay_currency,
              pay_address: st.pay_address,
              outcome_amount: st.outcome_amount,
              outcome_currency: st.outcome_currency
            },
            "status_sync"
          );

          if (result.credited || result.duplicate) {
            const refreshed = await this.prisma.depositTransaction.findUnique({
              where: { id: deposit.id }
            });
            const expectedAmount = Number(refreshed?.requestedAmountUsd ?? deposit.requestedAmountUsd ?? deposit.amount ?? 0);
            const creditedAmount = Number(refreshed?.creditedBalanceAmount ?? deposit.creditedBalanceAmount ?? 0);
            const missingAmount = Math.max(0, expectedAmount - creditedAmount);
            return { status: "confirmed", credited: true, creditedAmount, expectedAmount, missingAmount };
          }
          return { status: result.status ?? normalizeNowPaymentsStatus(st.payment_status) };
        } catch (err) {
          logger.warn(
            {
              provider: PROVIDER,
              depositId: deposit.id,
              orderId: deposit.orderId,
              providerPaymentId: paymentId,
              err
            },
            "checkDepositStatus provider refresh failed"
          );
          return { status: deposit.status };
        }
      }

      logger.info(
        {
          provider: PROVIDER,
          depositId: deposit.id,
          orderId: deposit.orderId,
          reason: "missing_provider_payment_id"
        },
        "checkDepositStatus skipped provider refresh"
      );
    }
    return { status: deposit.status };
  }

  /** Background poll: sync PENDING deposits with NOWPayments status. Returns count credited. */
  async pollPendingDeposits(opts?: { limit?: number }): Promise<{ polled: number; credited: number }> {
    if (!this.nowPayments) return { polled: 0, credited: 0 };

    const limit = opts?.limit ?? 40;
    const pending = await this.prisma.depositTransaction.findMany({
      where: {
        status: "PENDING",
        provider: PROVIDER,
        providerPaymentId: { not: null }
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, orderId: true }
    });

    let credited = 0;
    for (const d of pending) {
      try {
        const result = await this.checkDepositStatus(d.orderId);
        if (result.credited) credited++;
      } catch (err) {
        logger.warn(
          { provider: PROVIDER, depositId: d.id, orderId: d.orderId, err },
          "pollPendingDeposits: checkDepositStatus failed"
        );
      }
    }

    if (pending.length > 0) {
      logger.info(
        { provider: PROVIDER, polled: pending.length, credited },
        "pollPendingDeposits completed"
      );
    }
    return { polled: pending.length, credited };
  }

  /**
   * Emergency/manual confirm by support:
   * force-credit deposit even when provider status/amount is not auto-confirmable.
   * Idempotent: if already confirmed, no extra credit is created.
   */
  async emergencyConfirmDeposit(
    depositIdOrOrderId: string,
    actorUserId: string,
    reason: string,
    opts?: { creditAmount?: number }
  ): Promise<EmergencyConfirmResult> {
    const deposit = await this.prisma.depositTransaction.findFirst({
      where: { OR: [{ id: depositIdOrOrderId }, { orderId: depositIdOrOrderId }] },
      include: { user: true }
    });
    if (!deposit) return { ok: false, error: "not_found" };

    const expectedAmount = Number(deposit.requestedAmountUsd ?? deposit.amount);
    const creditAmount = opts?.creditAmount ?? expectedAmount;
    if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
      return { ok: false, error: "invalid_amount" };
    }

    const now = new Date();
    let alreadyConfirmed = false;
    let finalCreditedAmount = creditAmount;

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT 1 FROM deposit_transactions WHERE id = ${deposit.id} FOR UPDATE`
      );
      const locked = await tx.depositTransaction.findUniqueOrThrow({ where: { id: deposit.id } });

      if (locked.status === "CONFIRMED") {
        alreadyConfirmed = true;
        return;
      }

      const account = await tx.userBalanceAccount.update({
        where: { id: locked.accountId },
        data: { balance: { increment: creditAmount } }
      });

      const entry = await tx.balanceLedgerEntry.create({
        data: {
          accountId: locked.accountId,
          type: "CREDIT",
          amount: creditAmount,
          balanceAfter: account.balance,
          referenceType: "deposit",
          referenceId: locked.id
        }
      });

      const raw = locked.rawPayload && typeof locked.rawPayload === "object"
        ? (locked.rawPayload as Record<string, unknown>)
        : {};
      const mergedRaw = {
        ...raw,
        manualConfirm: {
          actorUserId,
          reason: reason?.trim() || "support_emergency_confirm",
          at: now.toISOString()
        }
      } as object;

      await tx.depositTransaction.update({
        where: { id: locked.id },
        data: {
          status: "CONFIRMED",
          creditedAt: now,
          confirmedAt: now,
          webhookLastProcessedAt: now,
          ledgerEntryId: entry.id,
          creditedBalanceAmount: creditAmount,
          providerStatus: "manual_confirmed",
          rawPayload: mergedRaw
        }
      });

      if (locked.botInstanceId) {
        const existingSettlement = await tx.ownerSettlementEntry.findUnique({
          where: { depositTransactionId: locked.id }
        });
        if (!existingSettlement) {
          const config = await tx.botPaymentProviderConfig.findUnique({
            where: { botInstanceId: locked.botInstanceId }
          });
          const platformFeePercent = config ? Number(config.platformFeePercent) : 0;
          const platformFeeFixedUsd = config ? Number(config.platformFeeFixedUsd) : 0;
          const platformFeeAmount = Math.max(
            0,
            (creditAmount * platformFeePercent) / 100 + platformFeeFixedUsd
          );
          const netAmountBeforePayoutFee = Math.max(0, creditAmount - platformFeeAmount);
          const depositor = await tx.user.findUnique({
            where: { id: locked.userId },
            select: { invitedByUserId: true, mentorUserId: true }
          });
          const ownerIds = await loadActiveOwnerUserIdsForBot(tx, locked.botInstanceId);
          const attributedOwnerUserId = attributeOwnerUserIdFromDepositor(ownerIds, depositor);
          await tx.ownerSettlementEntry.create({
            data: {
              botInstanceId: locked.botInstanceId,
              depositTransactionId: locked.id,
              currency: String(locked.currency ?? "USDT").toUpperCase(),
              grossAmount: creditAmount,
              processorFeeAmount: 0,
              platformFeeAmount,
              netAmountBeforePayoutFee,
              attributedOwnerUserId,
              status: "PENDING"
            }
          });
        }
      }
    });

    if (alreadyConfirmed) {
      return { ok: true, alreadyConfirmed: true, depositId: deposit.id };
    }

    const productId = readRequestedProductId(deposit.rawPayload);
    if (this.onDepositCredited) {
      void this.onDepositCredited({
        depositId: deposit.id,
        userId: deposit.userId,
        botInstanceId: deposit.botInstanceId,
        telegramUserId: String(deposit.user.telegramUserId),
        selectedLanguage: deposit.user.selectedLanguage,
        creditedAmount: finalCreditedAmount,
        currency: deposit.currency,
        productId
      }).catch((err: unknown) => {
        logger.warn(
          { provider: PROVIDER, depositId: deposit.id, err },
          "Emergency confirm notification failed"
        );
      });
    }

    await this.audit.log(actorUserId, "deposit_force_confirmed", "deposit_transaction", deposit.id, {
      reason: reason?.trim() || "support_emergency_confirm",
      creditedAmount: finalCreditedAmount,
      userId: deposit.userId,
      botInstanceId: deposit.botInstanceId,
      productId: productId ?? null
    });

    return {
      ok: true,
      depositId: deposit.id,
      creditedAmount: finalCreditedAmount
    };
  }

  async getRecentLedgerEntries(userId: string, limit = 10) {
    const account = await this.prisma.userBalanceAccount.findUnique({
      where: { userId }
    });
    if (!account) return [];
    return this.prisma.balanceLedgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "desc" },
      take: limit
    });
  }

  async createWithdrawalRequest(userId: string, amount: number): Promise<{ id: string } | null> {
    const { id: accountId, balance } = await this.getOrCreateAccount(userId);
    if (balance < amount || amount <= 0) return null;
    const pending = await this.prisma.withdrawalRequest.findFirst({
      where: { userId, status: "PENDING" }
    });
    if (pending) return null;

    const wr = await this.prisma.withdrawalRequest.create({
      data: {
        userId,
        accountId,
        amount,
        status: "PENDING"
      }
    });
    return { id: wr.id };
  }
}
