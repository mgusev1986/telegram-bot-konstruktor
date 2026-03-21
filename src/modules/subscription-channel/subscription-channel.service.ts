/**
 * Подписка + канал/чат: напоминания об истечении, исключение из канала при просрочке,
 * приглашение при оплате.
 */
import type { PrismaClient } from "@prisma/client";
import type { Telegram } from "telegraf";
import type { SchedulerService } from "../jobs/scheduler.service";
import { getBanIdentifiers, getDisplayLinks } from "../../common/linked-chat-parser";
import { logger } from "../../common/logger";

const REMINDER_DAYS = [3, 2, 1] as const;

export class SubscriptionChannelService {
  private telegram: Telegram | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  setTelegram(tg: Telegram): void {
    this.telegram = tg;
  }

  /**
   * Вызывается после создания UserAccessRight при подтверждении оплаты.
   * Планирует напоминания (3, 2, 1 день до истечения) и задачу исключения при expiry.
   */
  async scheduleRemindersAndExpiry(
    accessRightId: string,
    activeUntil: Date,
    botInstanceId: string | null,
    scheduler: SchedulerService
  ): Promise<void> {
    const now = Date.now();
    const untilMs = activeUntil.getTime();
    const msPerDay = 24 * 60 * 60 * 1000;

    for (const daysLeft of REMINDER_DAYS) {
      const remindAt = new Date(untilMs - daysLeft * msPerDay);
      if (remindAt.getTime() <= now) continue;

      try {
        await scheduler.schedule(
          "SEND_SUBSCRIPTION_REMINDER",
          { accessRightId, daysLeft, botInstanceId: botInstanceId ?? undefined },
          remindAt,
          `sub-rem:${accessRightId}:${daysLeft}d`
        );
      } catch (e) {
        logger.warn({ accessRightId, daysLeft, err: e }, "Failed to schedule subscription reminder");
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
  async sendReminder(accessRightId: string, daysLeft: number): Promise<void> {
    const right = await this.prisma.userAccessRight.findUnique({
      where: { id: accessRightId },
      include: { user: true, product: { include: { localizations: true } } }
    });
    if (!right || right.status !== "ACTIVE" || !right.activeUntil) return;

    const loc = right.product.localizations.find((l) => l.languageCode === right.user.selectedLanguage)
      ?? right.product.localizations.find((l) => l.languageCode === "ru")
      ?? right.product.localizations[0];
    const msg =
      daysLeft === 3
        ? loc?.description?.includes("подписк") ? "Подписка истекает через 3 дня. Продлите, чтобы сохранить доступ к каналу и материалам." : "Your subscription expires in 3 days. Renew to keep access."
        : daysLeft === 2
          ? "Подписка истекает через 2 дня. Продлите оплату."
          : "Подписка истекает завтра! Продлите, иначе доступ будет закрыт.";

    if (this.telegram) {
      try {
        await this.telegram.sendMessage(Number(right.user.telegramUserId), msg);
      } catch (e) {
        logger.warn({ accessRightId, userId: right.userId, err: e }, "Failed to send subscription reminder");
      }
    }
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

    const identifiers = getBanIdentifiers(right.product.linkedChats);
    if (identifiers.length && this.telegram) {
      const chatId = (id: string) => (id.startsWith("@") ? id : Number(id));
      for (const ident of identifiers) {
        try {
          await this.telegram.banChatMember(chatId(ident), Number(right.user.telegramUserId));
          logger.info({ accessRightId, userId: right.userId, chatId: ident }, "Banned user from subscription chat");
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const hint =
            /not enough rights|need admin|CHAT_ADMIN_REQUIRED|not an admin/i.test(errMsg)
              ? " (бот не администратор в чате/канале или нет прав на бан)"
              : "";
          logger.warn(
            { accessRightId, chatId: ident, err: e },
            `Failed to ban user from chat${hint}`
          );
        }
      }
    } else if (identifiers.length === 0 && Array.isArray(right.product.linkedChats) && (right.product.linkedChats as any[]).length > 0) {
      logger.warn(
        { accessRightId, productId: right.productId },
        "linkedChats has no identifier entries (only invite links); cannot ban via API. Add chat identifier (numeric id or @username) for ban on expiry."
      );
    }

    const expiryMsg =
      right.user.selectedLanguage === "en"
        ? "Your access has expired. Please renew your subscription to regain access to the chat and materials."
        : right.user.selectedLanguage === "de"
          ? "Ihr Zugang ist abgelaufen. Bitte verlängern Sie Ihr Abonnement."
          : "Ваш доступ истёк. Продлите подписку, чтобы снова получить доступ к чату и материалам.";
    if (this.telegram) {
      try {
        await this.telegram.sendMessage(Number(right.user.telegramUserId), expiryMsg);
      } catch (e) {
        logger.warn({ accessRightId, userId: right.userId, err: e }, "Failed to send expiry DM to user");
      }
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
    const product = await this.prisma.product.findUnique({
      where: { id: productId }
    });
    const linkedChats = product?.linkedChats as Array<{ link?: string; identifier?: string; label?: string }> | null;
    if (!linkedChats?.length || !this.telegram) return;

    const lines: string[] = [];
    const identifiers = getBanIdentifiers(linkedChats);
    const chatId = (id: string) => id.startsWith("@") ? id : Number(id);

    for (const ident of identifiers) {
      try {
        await this.telegram.unbanChatMember(chatId(ident), Number(telegramUserId)).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }

    for (const entry of linkedChats) {
      let url: string | null = null;
      if (entry.link) {
        url = entry.link;
      } else if (entry.identifier) {
        try {
          const inv = await this.telegram.createChatInviteLink(chatId(entry.identifier), { member_limit: 1 } as any);
          url = (inv as { invite_link?: string }).invite_link ?? null;
        } catch {
          /* skip */
        }
      }
      if (url) {
        const label = entry.label ?? "Перейти";
        lines.push(`${label}: ${url}`);
      }
    }

    if (lines.length) {
      try {
        await this.telegram.sendMessage(
          Number(telegramUserId),
          `Оплата подтверждена. Ваши ссылки:\n\n${lines.join("\n\n")}`
        );
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

    const chatId = (id: string) => id.startsWith("@") ? id : Number(id);
    const out = [...direct];

    for (const entry of linkedChats as Array<{ link?: string; identifier?: string; label?: string }>) {
      if (entry.link) continue;
      if (!entry.identifier) continue;
      try {
        const inv = await telegram.createChatInviteLink(chatId(entry.identifier), { member_limit: 1 } as any);
        const url = (inv as { invite_link?: string }).invite_link;
        if (url) out.push({ link: url, label: entry.label ?? "Перейти" });
      } catch {
        /* skip */
      }
    }
    return out;
  }
}
