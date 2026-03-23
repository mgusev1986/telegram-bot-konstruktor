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

const PROVIDER = "nowpayments";
const NOWPAYMENTS_FINAL_SUCCESS_STATUSES = new Set(["finished"]);
const NOWPAYMENTS_FAILURE_STATUSES = new Set(["failed", "refunded", "expired"]);

type NowPaymentsProcessSource = "ipn" | "status_sync";
type NowPaymentsProcessResult = {
  ok: boolean;
  credited?: boolean;
  duplicate?: boolean;
  status?: string;
  error?: string;
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
    private readonly subscriptionChannel?: SubscriptionChannelService
  ) {}

  isNowPaymentsEnabled(): boolean {
    return this.nowPayments != null && Boolean(env.NOWPAYMENTS_IPN_SECRET?.trim());
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
   * Variant A: user pays exactly priceAmount; we absorb commission.
   */
  async createDepositIntent(
    user: User,
    amount: number,
    currency: string,
    network: PaymentNetwork
  ): Promise<DepositIntent | null> {
    if (!this.nowPayments) return null;

    const { id: accountId } = await this.getOrCreateAccount(user.id);
    const orderId = `dep_${user.id}_${Date.now()}_${randomUUID().slice(0, 8)}`;

    const payCurrency = NowPaymentsAdapter.payCurrencyFromNetwork(network);

    const ipnUrl = env.NOWPAYMENTS_IPN_CALLBACK_URL?.trim() || undefined;
    if (!ipnUrl) {
      logger.warn(
        { userId: user.id, provider: PROVIDER, orderId },
        "NOWPayments createDepositIntent: ipn_callback_url is not configured; status polling will be the only confirmation path"
      );
    }

    try {
      const resp = await this.nowPayments.createPayment({
        priceAmount: amount,
        priceCurrency: currency,
        payCurrency,
        orderId,
        orderDescription: `Deposit ${amount} ${currency}`,
        ipnCallbackUrl: ipnUrl,
        fixedRate: true
      });

      const deposit = await this.prisma.depositTransaction.create({
        data: {
          userId: user.id,
          accountId,
          provider: PROVIDER,
          providerPaymentId: String(resp.payment_id),
          orderId,
          amount,
          currency,
          status: "PENDING",
          rawPayload: resp as unknown as object
        }
      });

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
      logger.warn(
        {
          userId: user.id,
          provider: PROVIDER,
          orderId,
          amount,
          currency,
          network,
          error: error instanceof Error ? error.message : String(error)
        },
        "NOWPayments createDepositIntent failed"
      );
      return null;
    }
  }

  /**
   * Process IPN from NOWPayments — idempotent, credits balance on finished.
   * Variant A: credit price_amount (what user was supposed to pay), not outcome_amount.
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
    const payloadObject = payload as object;
    const processedAt = new Date();
    let credited = false;
    let duplicate = false;
    let ignored = false;

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
            rawPayload: payloadObject
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

      if (mappedStatus === "PENDING") {
        await tx.depositTransaction.update({
          where: { id: lockedDeposit.id },
          data: {
            status: "PENDING",
            providerPaymentId: lockedDeposit.providerPaymentId ?? paymentId,
            rawPayload: payloadObject
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

      const creditAmount = readNowPaymentsAmount(payload.price_amount, Number(lockedDeposit.amount));

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
          rawPayload: payloadObject
        }
      });

      await tx.providerEventLog.update({
        where: { id: eventLog.id },
        data: { status: "processed", processedAt, errorMessage: null }
      });

      credited = true;
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
        { provider: PROVIDER, source, paymentId, orderId, paymentStatus, depositId: deposit.id },
        mappedStatus === "FAILED"
          ? "NOWPayments event marked deposit as failed"
          : "NOWPayments event stored without credit"
      );
      return { ok: true, status: paymentStatus };
    }

    const creditedAmount = readNowPaymentsAmount(payload.price_amount, Number(deposit.amount));

    logger.info(
      {
        provider: PROVIDER,
        source,
        paymentId,
        orderId,
        paymentStatus,
        depositId: deposit.id,
        amount: creditedAmount,
        currency: deposit.currency,
        userId: deposit.userId
      },
      "NOWPayments deposit credited"
    );

    void (async () => {
      await this.notifications.sendText(
        deposit.user,
        "PAYMENT_CONFIRMED",
        deposit.user.selectedLanguage === "en"
          ? `Deposit confirmed. ${creditedAmount} ${deposit.currency} credited to your balance.`
          : `Пополнение подтверждено. ${creditedAmount} ${deposit.currency} зачислено на баланс.`,
        { depositId: deposit.id }
      );

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
        "NOWPayments follow-up notification/audit failed"
      );
    });

    return { ok: true, credited: true, status: paymentStatus };
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
      return { success: true, accessGranted: true };
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
        await this.crm.assignTag(user.id, "paid", owner.id);
        await this.audit.log(owner.id, "product_purchase_balance", "product_purchase", result.purchaseAuditRef, {
          userId: user.id,
          productId,
          amount: price
        });
      }
    }

    return { success: true, accessGranted: true };
  }

  async checkDepositStatus(depositIdOrOrderId: string): Promise<{ status: string; credited?: boolean }> {
    const deposit = await this.prisma.depositTransaction.findFirst({
      where: {
        OR: [{ id: depositIdOrOrderId }, { orderId: depositIdOrOrderId }]
      }
    });
    if (!deposit) return { status: "not_found" };
    if (deposit.status === "CONFIRMED") return { status: "confirmed", credited: true };
    if (deposit.status === "PENDING" && this.nowPayments) {
      const paymentId = deposit.providerPaymentId;
      if (paymentId) {
        try {
          const st = await this.nowPayments.getPaymentStatus(paymentId);
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

          if (result.credited || result.duplicate || st.payment_status === "finished") {
            return { status: "confirmed", credited: true };
          }
          return { status: result.status ?? normalizeNowPaymentsStatus(st.payment_status) };
        } catch {
          return { status: deposit.status };
        }
      }
    }
    return { status: deposit.status };
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
