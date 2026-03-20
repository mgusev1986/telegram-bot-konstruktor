import type { PrismaClient, User } from "@prisma/client";
import type { Telegram } from "telegraf";

import { logger } from "../../common/logger";
import { sendRichMessage, type RichMessage } from "../../common/media";
import { renderPersonalizedText } from "../../common/personalization";

export class NavigationService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async replaceScreen(
    user: User,
    telegram: Telegram,
    chatId: string | number | bigint,
    message: RichMessage,
    extra: object = {}
  ): Promise<number | null> {
    const normalizedChatId = typeof chatId === "bigint" ? Number(chatId) : chatId;
    const resolvePlaceholders = message.resolvePlaceholders !== false;
    const personalizedMessage: RichMessage = {
      ...message,
      text: message.text ? renderPersonalizedText(message.text, user, { resolvePlaceholders }) : message.text
    };

    if (user.lastContentMessageId) {
      try {
        await telegram.deleteMessage(normalizedChatId, user.lastContentMessageId);
      } catch (error) {
        logger.debug(
          {
            userId: user.id,
            messageId: user.lastContentMessageId,
            error
          },
          "Failed to delete previous content message"
        );
      }
    }

    const sent = await sendRichMessage(telegram, normalizedChatId, personalizedMessage, extra);
    const messageId = "message_id" in sent ? sent.message_id : null;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastContentMessageId: messageId ?? undefined
      }
    });

    user.lastContentMessageId = messageId ?? null;

    return messageId;
  }
}
