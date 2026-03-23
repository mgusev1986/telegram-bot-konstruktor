import type { NotificationType, PrismaClient, User } from "@prisma/client";
import type { Telegram } from "telegraf";

import { toJsonValue } from "../../common/json";
import { sendRichMessage } from "../../common/media";
import { renderPersonalizedText } from "../../common/personalization";
import type { I18nService } from "../i18n/i18n.service";

/** Build label for first-line registration: clickable @username (HTML) or "Name [id]" (plain). */
function formatFirstLineInvitedLabel(invited: User): { text: string; parseMode?: "HTML" } {
  const username = invited.username?.trim();
  if (username) {
    const safeUsername = username.replace(/[^a-zA-Z0-9_]/g, "");
    if (safeUsername) {
      return {
        text: `<a href="https://t.me/${safeUsername}">@${safeUsername}</a>`,
        parseMode: "HTML"
      };
    }
  }
  const name = invited.fullName?.trim() || invited.firstName?.trim() || "";
  const id = String(invited.telegramUserId);
  return { text: name ? `${name} [${id}]` : `[${id}]` };
}

export class NotificationService {
  private telegram: Telegram | null = null;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly i18n: I18nService
  ) {}

  public setTelegram(telegram: Telegram): void {
    this.telegram = telegram;
  }

  public async create(
    userId: string,
    type: NotificationType,
    payloadJson: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.notification.create({
      data: {
        userId,
        type,
        payloadJson: toJsonValue(payloadJson)
      }
    });
  }

  public async sendText(
    user: User,
    type: NotificationType,
    text: string,
    payloadJson: Record<string, unknown>,
    sendOptions?: Record<string, unknown>
  ): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        userId: user.id,
        type,
        payloadJson: toJsonValue(payloadJson)
      }
    });

    if (!this.telegram) {
      return;
    }

    try {
      const personalizedText = renderPersonalizedText(text, user);
      await sendRichMessage(this.telegram, user.telegramUserId, { text: personalizedText }, sendOptions ?? {});

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: "SENT",
          sentAt: new Date()
        }
      });
    } catch (error) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: "FAILED"
        }
      });
      throw error;
    }
  }

  public async notifyFirstLineRegistration(inviter: User, invited: User): Promise<void> {
    const lang = inviter.selectedLanguage;
    const prefix = this.i18n.t(lang, "registration_notification_prefix");
    const invitedLabel = formatFirstLineInvitedLabel(invited);
    const text = invitedLabel.parseMode
      ? `${prefix}${invitedLabel.text}.`
      : `${prefix}${invitedLabel.text}.`;

    await this.sendText(inviter, "FIRST_LINE_REGISTRATION", text, { invitedUserId: invited.id }, invitedLabel.parseMode ? { parse_mode: "HTML" } : undefined);
  }

  public async notifyGlobalRegistration(owner: User, invited: User, inviter: User): Promise<void> {
    const text = this.i18n.t(owner.selectedLanguage, "user_registered", {
      fullName: `${invited.fullName || invited.firstName} <- ${inviter.fullName || inviter.firstName}`
    });

    await this.sendText(owner, "GLOBAL_REGISTRATION", text, {
      invitedUserId: invited.id,
      inviterUserId: inviter.id
    });
  }

  public async notifyMentorRequest(mentor: User, requester: User): Promise<void> {
    const language = mentor.selectedLanguage;
    const text =
      language === "en"
        ? `${requester.fullName || requester.firstName} requested contact with you.`
        : language === "de"
          ? `${requester.fullName || requester.firstName} hat einen Kontakt mit Ihnen angefordert.`
          : `${requester.fullName || requester.firstName} запросил(а) связь с вами как с наставником.`;

    await this.sendText(mentor, "SYSTEM_ALERT", text, {
      requesterUserId: requester.id
    });
  }
}
