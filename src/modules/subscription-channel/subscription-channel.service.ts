/**
 * Подписка + канал/чат: напоминания об истечении, исключение из канала при просрочке,
 * приглашение при оплате.
 */
import type { PrismaClient } from "@prisma/client";
import type { Telegram } from "telegraf";
import type { SchedulerService } from "../jobs/scheduler.service";
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
   * При истечении: отзывает доступ, исключает из канала (если product.linkedChatId).
   */
  async processExpiry(accessRightId: string): Promise<void> {
    const right = await this.prisma.userAccessRight.findUnique({
      where: { id: accessRightId },
      include: { user: true, product: true }
    });
    if (!right || right.status !== "ACTIVE") return;

    await this.prisma.userAccessRight.update({
      where: { id: accessRightId },
      data: { status: "EXPIRED" }
    });

    const chatId = right.product.linkedChatId;
    if (chatId && this.telegram) {
      try {
        await this.telegram.banChatMember(Number(chatId), Number(right.user.telegramUserId));
        logger.info({ accessRightId, userId: right.userId, chatId: chatId.toString() }, "Banned user from subscription chat");
      } catch (e) {
        logger.warn({ accessRightId, chatId: chatId.toString(), err: e }, "Failed to ban user from chat");
      }
    }
  }

  /**
   * При оплате: разбанить в канале и отправить приглашение (если product.linkedChatId).
   */
  async onAccessGranted(
    userId: string,
    productId: string,
    telegramUserId: bigint
  ): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId }
    });
    if (!product?.linkedChatId || !this.telegram) return;

    try {
      await this.telegram.unbanChatMember(Number(product.linkedChatId), Number(telegramUserId)).catch(() => undefined);
      const link = await this.telegram.createChatInviteLink(Number(product.linkedChatId), {
        member_limit: 1
      } as any);
      await this.telegram.sendMessage(
        Number(telegramUserId),
        `Оплата подтверждена. Присоединяйтесь к каналу: ${(link as { invite_link?: string }).invite_link ?? link}`
      );
    } catch (e) {
      logger.warn({ userId, productId, err: e }, "Failed to unban/send invite for subscription");
    }
  }
}
