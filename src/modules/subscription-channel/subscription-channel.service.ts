/**
 * Подписка + канал/чат: напоминания об истечении, исключение из канала при просрочке,
 * приглашение при оплате.
 */
import type { PrismaClient } from "@prisma/client";
import type { Telegram } from "telegraf";
import type { SchedulerService } from "../jobs/scheduler.service";
import { makeCallbackData } from "../../common/callback-data";
import { getBanIdentifiers, getDisplayLinks } from "../../common/linked-chat-parser";
import { logger } from "../../common/logger";
import type { NotificationService } from "../notifications/notification.service";
import {
  getReminderSchedule,
  type ProductTimingLike
} from "./subscription-access-policy";

function getRenewButtonText(
  languageCode: string | null | undefined,
  payButtonText: string | null | undefined
): string {
  const normalized = payButtonText?.trim();
  if (normalized) {
    return normalized;
  }

  switch ((languageCode ?? "ru").toLowerCase()) {
    case "en":
      return "Pay now";
    case "de":
      return "Jetzt bezahlen";
    case "uk":
      return "Оплатити";
    default:
      return "Оплатить";
  }
}

function buildRenewReplyMarkup(productId: string, buttonText: string) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `💳 ${buttonText}`, callback_data: makeCallbackData("pay", "checkout", productId) }]
      ]
    }
  };
}

export class SubscriptionChannelService {
  private telegram: Telegram | null = null;
  private static readonly JOIN_LINK_TTL_SECONDS = 15 * 60;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications?: NotificationService,
    private readonly botInstanceId?: string
  ) {}

  setTelegram(tg: Telegram): void {
    this.telegram = tg;
  }

  private normalizeChatIdentifier(chatId: string | number | bigint): string {
    return typeof chatId === "string" ? chatId : String(chatId);
  }

  private toTelegramChatId(identifier: string): string | number {
    return identifier.startsWith("@") ? identifier : Number(identifier);
  }

  private async createPaidAccessInviteLink(
    identifier: string,
    productId: string,
    userId: string
  ): Promise<string | null> {
    if (!this.telegram) return null;

    try {
      const inv = await this.telegram.createChatInviteLink(
        this.toTelegramChatId(identifier),
        {
          creates_join_request: true,
          expire_date: Math.floor(Date.now() / 1000) + SubscriptionChannelService.JOIN_LINK_TTL_SECONDS,
          name: `paid:${productId}:${userId}`.slice(0, 32)
        } as any
      );
      return (inv as { invite_link?: string }).invite_link ?? null;
    } catch (e) {
      logger.warn({ identifier, productId, userId, err: e }, "Failed to create join-request invite link");
      return null;
    }
  }

  private async resolveBotLinkedProducts(): Promise<Array<{
    id: string;
    linkedChats: unknown;
  }>> {
    if (this.botInstanceId) {
      const templateIds = await this.prisma.presentationTemplate.findMany({
        where: { botInstanceId: this.botInstanceId, isActive: true },
        select: { id: true }
      });
      if (templateIds.length === 0) return [];

      const productRows = await this.prisma.menuItem.findMany({
        where: {
          templateId: { in: templateIds.map((row) => row.id) },
          productId: { not: null }
        },
        select: { productId: true },
        distinct: ["productId"]
      });
      const productIds = productRows.map((row) => String(row.productId)).filter(Boolean);
      if (productIds.length === 0) return [];

      return this.prisma.product.findMany({
        where: { id: { in: productIds }, isActive: true },
        select: { id: true, linkedChats: true }
      });
    }

    return this.prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, linkedChats: true }
    });
  }

  async handleChatJoinRequest(input: {
    chatId: string | number | bigint;
    userTelegramId: bigint;
  }): Promise<"approved" | "declined" | "ignored"> {
    if (!this.telegram) return "ignored";

    const chatIdentifier = this.normalizeChatIdentifier(input.chatId);
    const linkedProducts = await this.resolveBotLinkedProducts();
    const matchedProducts = linkedProducts.filter((product) =>
      getBanIdentifiers(product.linkedChats).some((identifier) => this.normalizeChatIdentifier(identifier) === chatIdentifier)
    );
    if (matchedProducts.length === 0) {
      return "ignored";
    }

    const user = await this.prisma.user.findFirst({
      where: {
        telegramUserId: input.userTelegramId,
        ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {})
      },
      select: { id: true }
    });

    const hasActiveAccess = user
      ? await this.prisma.userAccessRight.findFirst({
          where: {
            userId: user.id,
            productId: { in: matchedProducts.map((product) => product.id) },
            status: "ACTIVE",
            OR: [
              { activeUntil: null },
              { activeUntil: { gt: new Date() } }
            ]
          },
          select: { id: true }
        })
      : null;

    const targetChatId = this.toTelegramChatId(chatIdentifier);
    if (hasActiveAccess) {
      await this.telegram.approveChatJoinRequest(targetChatId, Number(input.userTelegramId));
      logger.info(
        {
          chatId: chatIdentifier,
          userTelegramId: String(input.userTelegramId),
          botInstanceId: this.botInstanceId,
          matchedProductIds: matchedProducts.map((product) => product.id)
        },
        "Approved paid chat join request"
      );
      return "approved";
    }

    await this.telegram.declineChatJoinRequest(targetChatId, Number(input.userTelegramId));
    logger.info(
      {
        chatId: chatIdentifier,
        userTelegramId: String(input.userTelegramId),
        botInstanceId: this.botInstanceId,
        matchedProductIds: matchedProducts.map((product) => product.id)
      },
      "Declined unpaid chat join request"
    );
    return "declined";
  }

  /**
   * Вызывается после создания UserAccessRight при подтверждении оплаты.
   * Планирует напоминания (3, 2, 1 день до истечения) и задачу исключения при expiry.
   */
  async scheduleRemindersAndExpiry(
    accessRightId: string,
    activeUntil: Date,
    botInstanceId: string | null,
    scheduler: SchedulerService,
    product?: ProductTimingLike | null
  ): Promise<void> {
    const now = Date.now();
    const untilMs = activeUntil.getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const msPerMinute = 60 * 1000;

    for (const reminder of getReminderSchedule(product)) {
      const offsetMs = reminder.unit === "minutes" ? reminder.value * msPerMinute : reminder.value * msPerDay;
      const remindAt = new Date(untilMs - offsetMs);
      if (remindAt.getTime() <= now) continue;

      try {
        await scheduler.schedule(
          "SEND_SUBSCRIPTION_REMINDER",
          {
            accessRightId,
            botInstanceId: botInstanceId ?? undefined,
            ...(reminder.unit === "minutes" ? { minutesLeft: reminder.value } : { daysLeft: reminder.value })
          },
          remindAt,
          `sub-rem:${accessRightId}:${reminder.idempotencySuffix}`
        );
      } catch (e) {
        logger.warn({ accessRightId, reminder, err: e }, "Failed to schedule subscription reminder");
      }
    }

    try {
      await scheduler.schedule(
        "PROCESS_ACCESS_EXPIRY",
        { accessRightId, botInstanceId: botInstanceId ?? undefined },
        activeUntil,
        `access-exp:${accessRightId}`
      );
    } catch (e) {
      logger.warn({ accessRightId, err: e }, "Failed to schedule access expiry");
    }
  }

  /**
   * Отправляет напоминание об истечении подписки.
   */
  async sendReminder(
    accessRightId: string,
    reminder: { daysLeft?: number; minutesLeft?: number }
  ): Promise<void> {
    const right = await this.prisma.userAccessRight.findUnique({
      where: { id: accessRightId },
      include: { user: true, product: { include: { localizations: true } } }
    });
    if (!right || right.status !== "ACTIVE" || !right.activeUntil) return;

    const loc = right.product.localizations.find((l) => l.languageCode === right.user.selectedLanguage)
      ?? right.product.localizations.find((l) => l.languageCode === "ru")
      ?? right.product.localizations[0];
    const title = loc?.title ?? right.product.code;
    const renewButtonText = getRenewButtonText(right.user.selectedLanguage, loc?.payButtonText);
    const sendOptions = buildRenewReplyMarkup(right.productId, renewButtonText);
    const minutesLeft = reminder.minutesLeft && reminder.minutesLeft > 0 ? reminder.minutesLeft : null;
    const daysLeft = reminder.daysLeft && reminder.daysLeft > 0 ? reminder.daysLeft : null;
    const msg =
      right.user.selectedLanguage === "en"
        ? minutesLeft
          ? `Test access to "${title}" expires in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}. Renew to keep access.`
          : daysLeft === 1
            ? `Access to "${title}" expires tomorrow. Renew to keep access.`
            : `Access to "${title}" expires in ${daysLeft ?? 0} days. Renew to keep access.`
        : right.user.selectedLanguage === "de"
          ? minutesLeft
            ? `Testzugang zu "${title}" endet in ${minutesLeft} Minute${minutesLeft === 1 ? "" : "n"}. Verlängern Sie den Zugang.`
            : daysLeft === 1
              ? `Der Zugang zu "${title}" endet morgen. Bitte verlängern Sie ihn.`
              : `Der Zugang zu "${title}" endet in ${daysLeft ?? 0} Tagen. Bitte verlängern Sie ihn.`
          : minutesLeft
            ? `Тестовый доступ к «${title}» истекает через ${minutesLeft} мин. Продлите доступ, чтобы не потерять чат и материалы.`
            : daysLeft === 1
              ? `Доступ к «${title}» истекает завтра. Продлите оплату, чтобы сохранить чат и материалы.`
              : `Доступ к «${title}» истекает через ${daysLeft ?? 0} дн. Продлите оплату, чтобы сохранить чат и материалы.`;

    if (this.notifications) {
      await this.notifications.sendText(
        right.user,
        "ACCESS_EXPIRING",
        msg,
        {
          accessRightId,
          productId: right.productId,
          ...(minutesLeft ? { minutesLeft } : {}),
          ...(daysLeft ? { daysLeft } : {})
        },
        sendOptions
      );
      return;
    }

    if (!this.telegram) return;
    await this.telegram.sendMessage(Number(right.user.telegramUserId), msg, sendOptions);
  }

  /**
   * При истечении: отзывает доступ, исключает из всех чатов/каналов (product.linkedChats),
   * отправляет DM пользователю о необходимости продления.
   */
  async processExpiry(accessRightId: string): Promise<void> {
    const right = await this.prisma.userAccessRight.findUnique({
      where: { id: accessRightId },
      include: { user: true, product: { include: { localizations: true } } }
    });
    if (!right || right.status !== "ACTIVE") return;

    await this.prisma.userAccessRight.update({
      where: { id: accessRightId },
      data: { status: "EXPIRED" }
    });

    const replacementAccess = await this.prisma.userAccessRight.findFirst({
      where: {
        userId: right.userId,
        productId: right.productId,
        status: "ACTIVE",
        OR: [
          { activeUntil: null },
          { activeUntil: { gt: new Date() } }
        ]
      },
      select: { id: true }
    });

    if (replacementAccess) {
      logger.info(
        { accessRightId, replacementAccessRightId: replacementAccess.id, userId: right.userId, productId: right.productId },
        "Skipping expiry removal because a newer active access right already exists"
      );
      return;
    }

    const removalIssues: string[] = [];
    const identifiers = getBanIdentifiers(right.product.linkedChats);
    if (Array.isArray(right.product.linkedChats) && (right.product.linkedChats as any[]).length > 0) {
      if (!this.telegram) {
        removalIssues.push("Telegram client is not configured for expiry removal");
      } else if (identifiers.length === 0) {
        removalIssues.push(
          "linkedChats has no identifier entries (only invite links); cannot ban via API. Add chat identifier (numeric id or @username) for ban on expiry."
        );
      } else {
        const chatId = (id: string) => (id.startsWith("@") ? id : Number(id));
        for (const ident of identifiers) {
          try {
            await this.telegram.banChatMember(chatId(ident), Number(right.user.telegramUserId));
            logger.info({ accessRightId, userId: right.userId, chatId: ident }, "Banned user from subscription chat");
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const hint =
              /not enough rights|need admin|CHAT_ADMIN_REQUIRED|not an admin/i.test(errMsg)
                ? "бот не администратор в чате/канале или нет прав на бан"
                : errMsg;
            removalIssues.push(`${ident}: ${hint}`);
            logger.warn(
              { accessRightId, chatId: ident, err: e },
              "Failed to ban user from chat on expiry"
            );
          }
        }
      }
    }

    const expiryMsg =
      right.user.selectedLanguage === "en"
        ? "Your access has expired. Please renew your subscription to regain access to the chat and materials."
        : right.user.selectedLanguage === "de"
          ? "Ihr Zugang ist abgelaufen. Bitte verlängern Sie Ihr Abonnement."
          : "Ваш доступ к платному разделу системы истёк.\n\nПродлите подписку, чтобы снова получить доступ к платному контенту и материалам. (Чат / Канал)";
    const loc = right.product.localizations.find((l) => l.languageCode === right.user.selectedLanguage)
      ?? right.product.localizations.find((l) => l.languageCode === "ru")
      ?? right.product.localizations[0];
    const renewButtonText = getRenewButtonText(right.user.selectedLanguage, loc?.payButtonText);
    const sendOptions = buildRenewReplyMarkup(right.productId, renewButtonText);

    if (this.notifications) {
      try {
        await this.notifications.sendText(
          right.user,
          "SYSTEM_ALERT",
          expiryMsg,
          { accessRightId, productId: right.productId, event: "access_expired" },
          sendOptions
        );
      } catch (e) {
        logger.warn({ accessRightId, userId: right.userId, err: e }, "Failed to send expiry DM to user");
      }
    } else if (this.telegram) {
      try {
        await this.telegram.sendMessage(Number(right.user.telegramUserId), expiryMsg, sendOptions);
      } catch (e) {
        logger.warn({ accessRightId, userId: right.userId, err: e }, "Failed to send expiry DM to user");
      }
    }

    if (removalIssues.length > 0) {
      throw new Error(`Expiry processed, but linked chat removal failed: ${removalIssues.join("; ")}`);
    }
  }

  /**
   * При оплате: разбанить во всех чатах/каналах, отправить ссылки (product.linkedChats).
   */
  async onAccessGranted(
    userId: string,
    productId: string,
    telegramUserId: bigint
  ): Promise<void> {
    const [product, user] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: productId }
      }),
      this.prisma.user.findUnique({
        where: { id: userId }
      })
    ]);
    const linkedChats = product?.linkedChats as Array<{ link?: string; identifier?: string; label?: string }> | null;
    if (!linkedChats?.length || !this.telegram || !user) return;

    const lines: string[] = [];
    const identifiers = getBanIdentifiers(linkedChats);

    for (const ident of identifiers) {
      try {
        await this.telegram.unbanChatMember(this.toTelegramChatId(ident), Number(telegramUserId)).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }

    for (const entry of linkedChats) {
      let url: string | null = null;
      if (entry.identifier) {
        url = await this.createPaidAccessInviteLink(entry.identifier, productId, userId);
      }
      if (!url && entry.link) {
        url = entry.link;
      }
      if (url) {
        const label = entry.label ?? "Перейти";
        lines.push(`${label}: ${url}`);
      }
    }

    if (lines.length) {
      try {
        if (this.notifications) {
          await this.notifications.sendText(
            user,
            "ACCESS_GRANTED",
            `Оплата подтверждена. Ваши ссылки:\n\n${lines.join("\n\n")}`,
            { userId, productId, event: "access_granted_links" }
          );
        } else {
          await this.telegram.sendMessage(
            Number(telegramUserId),
            `Оплата подтверждена. Ваши ссылки:\n\n${lines.join("\n\n")}`
          );
        }
      } catch (e) {
        logger.warn({ userId, productId, err: e }, "Failed to send invite links");
      }
    }
  }

  /**
   * Отзывает весь платный доступ пользователя (ручное действие из бэкофиса/кабинета).
   * Устанавливает status=REVOKED для всех активных UserAccessRight и исключает пользователя из связанных чатов/каналов.
   */
  async revokeAllAccessForUser(userId: string): Promise<{ revokedCount: number }> {
    const rights = await this.prisma.userAccessRight.findMany({
      where: { userId, status: "ACTIVE" },
      include: { user: true, product: true }
    });
    if (rights.length === 0) {
      return { revokedCount: 0 };
    }

    for (const right of rights) {
      await this.prisma.userAccessRight.update({
        where: { id: right.id },
        data: { status: "REVOKED" }
      });

      const identifiers = getBanIdentifiers(right.product.linkedChats);
      if (identifiers.length && this.telegram) {
        const chatId = (id: string) => (id.startsWith("@") ? id : Number(id));
        for (const ident of identifiers) {
          try {
            await this.telegram.banChatMember(chatId(ident), Number(right.user.telegramUserId));
            logger.info({ userId, accessRightId: right.id, chatId: ident }, "Banned user from subscription chat (revoked)");
          } catch (e) {
            logger.warn({ userId, chatId: ident, err: e }, "Failed to ban user from chat on revoke");
          }
        }
      }
    }
    return { revokedCount: rights.length };
  }

  /** Возвращает ссылки для кнопок — для отображения в секции после оплаты. Для identifier-only запрашивает invite через API. */
  async resolveProductLinksForDisplay(
    linkedChats: unknown,
    telegram: import("telegraf").Telegram
  ): Promise<Array<{ link: string; label: string }>> {
    const direct = getDisplayLinks(linkedChats);
    if (!Array.isArray(linkedChats)) return direct;

    const out = [...direct];

    for (const entry of linkedChats as Array<{ link?: string; identifier?: string; label?: string }>) {
      if (!entry.identifier) continue;
      try {
        const inv = await telegram.createChatInviteLink(this.toTelegramChatId(entry.identifier), {
          creates_join_request: true,
          expire_date: Math.floor(Date.now() / 1000) + SubscriptionChannelService.JOIN_LINK_TTL_SECONDS,
          name: "paid-access"
        } as any);
        const url = (inv as { invite_link?: string }).invite_link;
        if (url) {
          const label = entry.label ?? "Перейти";
          const existingIndex = out.findIndex((item) => item.label === label);
          if (existingIndex >= 0) {
            out[existingIndex] = { link: url, label };
          } else {
            out.push({ link: url, label });
          }
        }
      } catch {
        /* skip */
      }
    }
    return out.filter((row) => row.link.trim() && /^https?:\/\//i.test(row.link.trim()));
  }
}
