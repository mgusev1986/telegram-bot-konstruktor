import { MediaType } from "@prisma/client";
import type { Telegram } from "telegraf";
import type { Message, MessageEntity } from "telegraf/types";

/**
 * Lightweight bold markup for admin prompts without parse_mode.
 * Use [b]...[/b] in text/caption; it will be converted to Telegram entities.
 * Not intended for nested tags.
 */
const renderBoldMarkers = (
  input: string
): { text: string; entities: MessageEntity[] } => {
  const startTag = "[b]";
  const endTag = "[/b]";

  const entities: MessageEntity[] = [];
  let out = "";
  let i = 0;

  while (i < input.length) {
    const start = input.indexOf(startTag, i);
    if (start === -1) {
      out += input.slice(i);
      break;
    }

    out += input.slice(i, start);
    const contentStart = start + startTag.length;
    const end = input.indexOf(endTag, contentStart);
    if (end === -1) {
      // Unclosed tag: keep literally.
      out += input.slice(start);
      break;
    }

    const boldText = input.slice(contentStart, end);
    const offset = out.length;
    out += boldText;
    if (boldText.length > 0) {
      entities.push({ type: "bold", offset, length: boldText.length });
    }
    i = end + endTag.length;
  }

  return { text: out, entities };
};

const toPlainTextFallback = (input: string): string => {
  // Keep anchor meaning in plain text: <a href="url">label</a> -> label (url)
  const withLinks = input.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,
    (_m, href: string, label: string) => `${label} (${href})`
  );
  // Remove remaining HTML tags.
  return withLinks.replace(/<\/?[^>]+>/g, "");
};

export interface RichMessage {
  text?: string;
  followUpText?: string;
  mediaType?: MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
  /**
   * Controls placeholder rendering for this message text.
   * - true/undefined: resolve placeholders (default)
   * - false: keep tokens literally (for admin help/instructions)
   */
  resolvePlaceholders?: boolean;
}

const TELEGRAM_CAPTION_LIMIT = 1024;
const CAPTION_MEDIA_TYPES = new Set<MediaType>([
  MediaType.PHOTO,
  MediaType.VIDEO,
  MediaType.AUDIO,
  MediaType.DOCUMENT,
  MediaType.VOICE
]);

const sendSingleRichMessage = async (
  telegram: Telegram,
  chatId: string | number | bigint,
  message: RichMessage,
  extra: object = {}
): Promise<Message> => {
  const normalizedChatId = typeof chatId === "bigint" ? Number(chatId) : chatId;
  const rawText = message.text?.trim() || "";
  const looksLikeHtml = /<\/?(b|strong|i|em|u|s|strike|del|code|pre|a|blockquote|tg-spoiler|tg-emoji)\b/i.test(rawText);
  const { text, entities } = looksLikeHtml ? { text: rawText, entities: [] } : renderBoldMarkers(rawText);
  const mergedExtra: Record<string, unknown> = { ...(extra as Record<string, unknown>) };
  if (looksLikeHtml) {
    // Telegram HTML parse mode is required to render <b>..</b> etc.
    // Do not mix parse_mode with entities.
    mergedExtra.parse_mode = mergedExtra.parse_mode ?? "HTML";
    delete mergedExtra.entities;
    delete mergedExtra.caption_entities;
  }

  try {
    switch (message.mediaType) {
      case MediaType.PHOTO:
        if (message.mediaFileId) {
          // Internal safeguard if caption overflow preprocessing was skipped upstream.
          if (text.length > TELEGRAM_CAPTION_LIMIT) {
            return telegram.sendMessage(normalizedChatId, text || message.externalUrl || "Сообщение без контента", {
              ...(mergedExtra as object),
              ...(looksLikeHtml ? {} : { entities })
            } as object);
          }
          if (text) {
            if (!looksLikeHtml) mergedExtra.caption_entities = entities;
          }
          return telegram.sendPhoto(normalizedChatId, message.mediaFileId, {
            caption: text || undefined,
            ...(mergedExtra as object)
          });
        }
        break;
      case MediaType.VIDEO:
        if (message.mediaFileId) {
          if (text.length > TELEGRAM_CAPTION_LIMIT) {
            return telegram.sendMessage(normalizedChatId, text || message.externalUrl || "Сообщение без контента", {
              ...(mergedExtra as object),
              ...(looksLikeHtml ? {} : { entities })
            } as object);
          }
          if (text) {
            if (!looksLikeHtml) mergedExtra.caption_entities = entities;
          }
          return telegram.sendVideo(normalizedChatId, message.mediaFileId, {
            caption: text || undefined,
            ...(mergedExtra as object)
          });
        }
        break;
      case MediaType.AUDIO:
        if (message.mediaFileId) {
          if (text.length > TELEGRAM_CAPTION_LIMIT) {
            return telegram.sendMessage(normalizedChatId, text || message.externalUrl || "Сообщение без контента", {
              ...(mergedExtra as object),
              ...(looksLikeHtml ? {} : { entities })
            } as object);
          }
          if (text) {
            if (!looksLikeHtml) mergedExtra.caption_entities = entities;
          }
          return telegram.sendAudio(normalizedChatId, message.mediaFileId, {
            caption: text || undefined,
            ...(mergedExtra as object)
          });
        }
        break;
      case MediaType.DOCUMENT:
        if (message.mediaFileId) {
          if (text.length > TELEGRAM_CAPTION_LIMIT) {
            return telegram.sendMessage(normalizedChatId, text || message.externalUrl || "Сообщение без контента", {
              ...(mergedExtra as object),
              ...(looksLikeHtml ? {} : { entities })
            } as object);
          }
          if (text) {
            if (!looksLikeHtml) mergedExtra.caption_entities = entities;
          }
          return telegram.sendDocument(normalizedChatId, message.mediaFileId, {
            caption: text || undefined,
            ...(mergedExtra as object)
          });
        }
        break;
      case MediaType.VOICE:
        if (message.mediaFileId) {
          if (text.length > TELEGRAM_CAPTION_LIMIT) {
            return telegram.sendMessage(normalizedChatId, text || message.externalUrl || "Сообщение без контента", {
              ...(mergedExtra as object),
              ...(looksLikeHtml ? {} : { entities })
            } as object);
          }
          if (text) {
            if (!looksLikeHtml) mergedExtra.caption_entities = entities;
          }
          return telegram.sendVoice(normalizedChatId, message.mediaFileId, {
            caption: text || undefined,
            ...(mergedExtra as object)
          });
        }
        break;
      case MediaType.VIDEO_NOTE:
        if (message.mediaFileId) {
          return telegram.sendVideoNote(normalizedChatId, message.mediaFileId, mergedExtra as object);
        }
        break;
      case MediaType.LINK:
        return telegram.sendMessage(
          normalizedChatId,
          [text, message.externalUrl].filter(Boolean).join("\n"),
          {
            ...(mergedExtra as object),
            ...(looksLikeHtml ? {} : { entities })
          } as object
        );
      default:
        break;
    }

    return telegram.sendMessage(
      normalizedChatId,
      text || message.externalUrl || "Сообщение без контента",
      {
        ...(mergedExtra as object),
        ...(looksLikeHtml ? {} : { entities })
      } as object
    );
  } catch (error: any) {
    const description = String(error?.response?.description ?? "");
    if (looksLikeHtml && /can't parse entities/i.test(description)) {
      const fallbackExtra: Record<string, unknown> = { ...(extra as Record<string, unknown>) };
      delete fallbackExtra.parse_mode;
      delete fallbackExtra.entities;
      delete fallbackExtra.caption_entities;
      return sendSingleRichMessage(
        telegram,
        normalizedChatId,
        { ...message, text: toPlainTextFallback(rawText) },
        fallbackExtra
      );
    }
    throw error;
  }
};

const describeTelegramSendError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const responseDescription = (error as any)?.response?.description;
  if (typeof responseDescription === "string" && responseDescription.trim()) {
    return responseDescription;
  }
  return "Unknown Telegram send error";
};

const stripReplyMarkup = (extra: object): object => {
  const normalized = { ...(extra as Record<string, unknown>) };
  delete normalized.reply_markup;
  return normalized;
};

export const sendRichMessage = async (
  telegram: Telegram,
  chatId: string | number | bigint,
  message: RichMessage,
  extra: object = {}
): Promise<Message> => {
  const primaryText = message.text?.trim() ?? "";
  const explicitFollowUpText = message.followUpText?.trim() ?? "";
  const shouldMovePrimaryTextToFollowUp =
    Boolean(message.mediaType && CAPTION_MEDIA_TYPES.has(message.mediaType) && primaryText.length > TELEGRAM_CAPTION_LIMIT);
  const normalizedFollowUpText = shouldMovePrimaryTextToFollowUp
    ? [primaryText, explicitFollowUpText].filter(Boolean).join("\n\n")
    : explicitFollowUpText;
  const legacyVideoNoteFollowUpText =
    message.mediaType === MediaType.VIDEO_NOTE && !normalizedFollowUpText
      ? primaryText
      : "";
  const followUpText = normalizedFollowUpText || legacyVideoNoteFollowUpText;
  const finalExtra = extra;
  const nonFinalExtra = stripReplyMarkup(extra);
  const primaryMessagePayload = shouldMovePrimaryTextToFollowUp
    ? { ...message, text: undefined, followUpText: undefined }
    : message;

  if (message.mediaType === MediaType.VIDEO_NOTE) {
    const primaryMessage = await sendSingleRichMessage(
      telegram,
      chatId,
      {
        ...primaryMessagePayload,
        text: undefined,
        followUpText: undefined
      },
      followUpText ? nonFinalExtra : finalExtra
    );

    if (followUpText) {
      try {
        await sendSingleRichMessage(
          telegram,
          chatId,
          { text: followUpText },
          finalExtra
        );
      } catch (error) {
        throw new Error(
          `Primary media sent, but follow-up text failed: ${describeTelegramSendError(error)}`
        );
      }
    }

    return primaryMessage;
  }

  if (followUpText) {
    const primaryMessage = await sendSingleRichMessage(
      telegram,
      chatId,
      {
        ...primaryMessagePayload,
        followUpText: undefined
      },
      nonFinalExtra
    );

    try {
      await sendSingleRichMessage(
        telegram,
        chatId,
        { text: followUpText },
        finalExtra
      );
    } catch (error) {
      throw new Error(
        `Primary media sent, but follow-up text failed: ${describeTelegramSendError(error)}`
      );
    }

    return primaryMessage;
  }

  return sendSingleRichMessage(telegram, chatId, primaryMessagePayload, extra);
};
