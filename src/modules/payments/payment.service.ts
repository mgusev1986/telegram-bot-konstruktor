import type { BillingType, PaymentNetwork, PrismaClient, Product, User } from "@prisma/client";

import { randomUUID } from "node:crypto";

import { env } from "../../config/env";
import type { AuditService } from "../audit/audit.service";
import type { CrmService } from "../crm/crm.service";
import type { SchedulerService } from "../jobs/scheduler.service";
import type { NotificationService } from "../notifications/notification.service";
import type { SubscriptionChannelService } from "../subscription-channel/subscription-channel.service";

export class PaymentService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly crm: CrmService,
    private readonly scheduler?: SchedulerService,
    private readonly subscriptionChannel?: SubscriptionChannelService
  ) {}

  public async ensureDemoProducts(): Promise<void> {
    const existing = await this.prisma.product.count();

    if (existing > 0) {
      return;
    }

    const product = await this.prisma.product.create({
      data: {
        code: "starter_access",
        type: "SECTION",
        price: "49.00",
        currency: "USDT",
        billingType: "ONE_TIME",
        durationDays: null
      }
    });

    await this.prisma.productLocalization.createMany({
      data: [
        {
          productId: product.id,
          languageCode: "ru",
          title: "Премиум-доступ",
          description: "Открывает платные материалы и бизнес-обучение.",
          payButtonText: "Оплатить доступ"
        },
        {
          productId: product.id,
          languageCode: "en",
          title: "Premium access",
          description: "Unlocks paid materials and business onboarding.",
          payButtonText: "Buy access"
        },
        {
          productId: product.id,
          languageCode: "de",
          title: "Premium-Zugang",
          description: "Schaltet bezahlte Materialien und Onboarding frei.",
          payButtonText: "Zugang kaufen"
        },
        {
          productId: product.id,
          languageCode: "uk",
          title: "Преміум-доступ",
          description: "Відкриває платні матеріали та бізнес-навчання.",
          payButtonText: "Оплатити доступ"
        }
      ]
    });
  }

  public async createPaymentRequest(user: User, productId: string, network: PaymentNetwork) {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: {
        localizations: true
      }
    });

    const walletAddress = this.resolveWallet(network);

    const payment = await this.prisma.payment.create({
      data: {
        userId: user.id,
        productId: product.id,
        botInstanceId: user.botInstanceId ?? undefined,
        provider: env.PAYMENT_PROVIDER_MODE === "manual" ? "MANUAL" : "CRYPTO",
        network,
        walletAddress,
        amount: product.price,
        currency: product.currency,
        referenceCode: randomUUID(),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    if (this.scheduler && payment.expiresAt) {
      await this.scheduler.schedule(
        "PROCESS_PAYMENT_EXPIRY",
        { paymentId: payment.id },
        payment.expiresAt,
        `pay-exp:${payment.id}`
      );
    }

    await this.notifications.create(user.id, "PAYMENT_REQUESTED", {
      paymentId: payment.id,
      productId: product.id,
      network
    });

    return {
      payment,
      product
    };
  }

  public async confirmPayment(paymentId: string, actorUserId: string, externalTxId?: string): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        user: true,
        product: true
      }
    });

    if (payment.status === "PAID") return;

    if (payment.expiresAt && payment.expiresAt.getTime() <= Date.now()) {
      // If it is expired, do not grant access.
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: "EXPIRED" }
      });
      return;
    }

    // Only allow confirmation for in-flight intents.
    if (!["PENDING", "UNPAID"].includes(payment.status)) {
      return;
    }

    const accessType: BillingType = payment.product.billingType;
    const activeUntil =
      payment.product.durationDays && payment.product.durationDays > 0
        ? new Date(Date.now() + payment.product.durationDays * 24 * 60 * 60 * 1000)
        : null;

    const accessRight = await this.prisma.$transaction(async (tx) => {
      const created = await tx.userAccessRight.create({
        data: {
          userId: payment.userId,
          productId: payment.productId,
          accessType: accessType === "ONE_TIME" ? "LIFETIME" : accessType === "TEMPORARY" ? "TEMPORARY" : "SUBSCRIPTION",
          activeFrom: new Date(),
          activeUntil
        }
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: new Date(),
          externalTxId: externalTxId ?? payment.externalTxId ?? undefined
        }
      });
      await tx.user.update({
        where: { id: payment.userId },
        data: { status: "PAID" }
      });
      return created;
    });

    if (activeUntil && this.scheduler && this.subscriptionChannel) {
      await this.subscriptionChannel.scheduleRemindersAndExpiry(
        accessRight.id,
        activeUntil,
        payment.botInstanceId ?? null,
        this.scheduler
      );
    }

    if (payment.product.linkedChatId && this.subscriptionChannel) {
      await this.subscriptionChannel.onAccessGranted(
        payment.userId,
        payment.productId,
        payment.user.telegramUserId
      );
    }

    await this.crm.assignTag(payment.userId, "paid", actorUserId);
    await this.audit.log(actorUserId, "confirm_payment", "payment", payment.id, {
      externalTxId
    });
    await this.notifications.sendText(
      payment.user,
      "PAYMENT_CONFIRMED",
      payment.user.selectedLanguage === "en"
        ? "Payment confirmed. Premium access is now active."
        : payment.user.selectedLanguage === "de"
          ? "Zahlung bestätigt. Premium-Zugang ist jetzt aktiv."
          : "Оплата подтверждена. Премиум-доступ активирован.",
      {
        paymentId: payment.id
      }
    );
  }

  public async confirmPaymentByReference(referenceCode: string, actorUserId: string, externalTxId?: string): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { referenceCode },
      select: { id: true }
    });

    await this.confirmPayment(payment.id, actorUserId, externalTxId);
  }

  public async rejectPayment(paymentId: string, actorUserId: string, reason?: string): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { id: true, status: true, userId: true }
    });

    if (payment.status === "PAID" || payment.status === "CANCELLED" || payment.status === "EXPIRED") return;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: "CANCELLED" }
    });

    await this.audit.log(actorUserId, "reject_payment", "payment", payment.id, { reason });
  }

  public async getFirstProduct(): Promise<Product | null> {
    return this.prisma.product.findFirst({
      orderBy: { id: "asc" }
    });
  }

  public async getAccessSummary(userId: string): Promise<{ paidStatus: boolean; activeProducts: Product[] }> {
    const rights = await this.prisma.userAccessRight.findMany({
      where: {
        userId,
        status: "ACTIVE",
        OR: [
          { activeUntil: null },
          {
            activeUntil: {
              gt: new Date()
            }
          }
        ]
      },
      include: {
        product: true
      }
    });

    return {
      paidStatus: rights.length > 0,
      activeProducts: rights.map((right) => right.product)
    };
  }

  private resolveWallet(network: PaymentNetwork): string {
    switch (network) {
      case "USDT_TRC20":
        return env.USDT_TRC20_WALLET;
      case "USDT_BEP20":
        return env.USDT_BEP20_WALLET;
      default:
        return env.USDT_TRC20_WALLET || env.USDT_BEP20_WALLET;
    }
  }
}
