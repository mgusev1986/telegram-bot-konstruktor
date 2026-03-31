import { MediaType } from "@prisma/client";
import type { MessageEntity } from "telegraf/types";

import { telegramEntitiesToHtml } from "../../common/telegram-entities";
import type { BotContext } from "../context";

export interface MessageContent {
  text?: string;
  /** When entities exist, contentText is HTML from telegramEntitiesToHtml. Otherwise plain text. */
  mediaType?: MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
}

function getTextAndEntities(
  msg: NonNullable<BotContext["message"]>
): { text: string; entities?: MessageEntity[] } {
  if ("text" in msg && msg.text) {
    return {
      text: msg.text,
      entities: "entities" in msg ? msg.entities : undefined
    };
  }
  if ("caption" in msg) {
    return {
      text: msg.caption ?? "",
      entities: "caption_entities" in msg ? msg.caption_entities : undefined
    };
  }
  return { text: "" };
}

/**
 * Extracts message content including text/caption. Does NOT convert to HTML -
 * use extractFormattedContentText when saving to DB for formatted storage.
 */
export const extractMessageContent = (ctx: BotContext): MessageContent => {
  if (!ctx.message) {
    return {};
  }

  const msg = ctx.message;

  if ("text" in msg) {
    const { text, entities } = getTextAndEntities(msg);
    const content: MessageContent = { text };
    if (entities?.length) {
      (content as MessageContent & { entities?: MessageEntity[] }).entities = entities;
    }
    return content;
  }

  if ("photo" in msg) {
    const photo = msg.photo.at(-1);
    const { text, entities } = getTextAndEntities(msg);
    const content: MessageContent = {
      text,
      mediaType: "PHOTO",
      mediaFileId: photo?.file_id ?? null
    };
    if (entities?.length) {
      (content as MessageContent & { entities?: MessageEntity[] }).entities = entities;
    }
    return content;
  }

  if ("video" in msg) {
    const { text, entities } = getTextAndEntities(msg);
    const content: MessageContent = {
      text,
      mediaType: "VIDEO",
      mediaFileId: msg.video.file_id
    };
    if (entities?.length) {
      (content as MessageContent & { entities?: MessageEntity[] }).entities = entities;
    }
    return content;
  }

  if ("audio" in msg) {
    const { text, entities } = getTextAndEntities(msg);
    const content: MessageContent = {
      text,
      mediaType: "AUDIO",
      mediaFileId: msg.audio.file_id
    };
    if (entities?.length) {
      (content as MessageContent & { entities?: MessageEntity[] }).entities = entities;
    }
    return content;
  }

  if ("document" in msg) {
    const { text, entities } = getTextAndEntities(msg);
    const content: MessageContent = {
      text,
      mediaType: "DOCUMENT",
      mediaFileId: msg.document.file_id
    };
    if (entities?.length) {
      (content as MessageContent & { entities?: MessageEntity[] }).entities = entities;
    }
    return content;
  }

  if ("voice" in msg) {
    const { text, entities } = getTextAndEntities(msg);
    const content: MessageContent = {
      text,
      mediaType: "VOICE",
      mediaFileId: msg.voice.file_id
    };
    if (entities?.length) {
      (content as MessageContent & { entities?: MessageEntity[] }).entities = entities;
    }
    return content;
  }

  if ("video_note" in msg) {
    return {
      mediaType: "VIDEO_NOTE",
      mediaFileId: msg.video_note.file_id
    };
  }

  return {};
};

/**
 * Returns content text suitable for storing in contentText/welcomeText.
 * Preserves formatting: converts Telegram entities to HTML when present,
 * otherwise returns plain text as-is.
 */
export function extractFormattedContentText(content: MessageContent & { entities?: MessageEntity[] }): string {
  const text = content.text ?? "";
  const entities = content.entities;
  if (entities?.length) {
    return telegramEntitiesToHtml(text, entities);
  }
  return text;
}

export const readTextMessage = (ctx: BotContext): string => {
  if (!ctx.message || !("text" in ctx.message)) {
    return "";
  }

  return ctx.message.text;
};

export const parseAudienceInput = (
  rawInput: string
): {
  audienceType: "ALL_USERS" | "OWN_FIRST_LINE" | "OWN_STRUCTURE" | "SPECIFIC_LEVEL" | "LANGUAGE" | "ROLE" | "TAGS" | "PAYMENT_STATUS" | "ACTIVITY" | "CUSTOM";
  segmentQuery: Record<string, unknown>;
} => {
  const normalized = rawInput.trim().toLowerCase();

  if (normalized === "all") {
    return { audienceType: "ALL_USERS", segmentQuery: {} };
  }

  if (normalized === "first_line") {
    return { audienceType: "OWN_FIRST_LINE", segmentQuery: {} };
  }

  if (normalized === "structure") {
    return { audienceType: "OWN_STRUCTURE", segmentQuery: {} };
  }

  if (normalized.startsWith("level:")) {
    return {
      audienceType: "SPECIFIC_LEVEL",
      segmentQuery: {
        level: Number(normalized.replace("level:", ""))
      }
    };
  }

  if (normalized.startsWith("language:")) {
    return {
      audienceType: "LANGUAGE",
      segmentQuery: {
        languages: [normalized.replace("language:", "")]
      }
    };
  }

  if (normalized.startsWith("role:")) {
    return {
      audienceType: "ROLE",
      segmentQuery: {
        roles: [normalized.replace("role:", "").toUpperCase()]
      }
    };
  }

  if (normalized.startsWith("tag:")) {
    return {
      audienceType: "TAGS",
      segmentQuery: {
        tagCodes: [normalized.replace("tag:", "")]
      }
    };
  }

  if (normalized.startsWith("inactive:")) {
    return {
      audienceType: "ACTIVITY",
      segmentQuery: {
        inactiveDays: Number(normalized.replace("inactive:", ""))
      }
    };
  }

  if (normalized === "paid") {
    return {
      audienceType: "PAYMENT_STATUS",
      segmentQuery: {
        paid: true
      }
    };
  }

  if (normalized === "unpaid") {
    return {
      audienceType: "PAYMENT_STATUS",
      segmentQuery: {
        paid: false
      }
    };
  }

  return {
    audienceType: "CUSTOM",
    segmentQuery: {}
  };
};

export const parseDripLines = (
  languageCode: string,
  input: string
): Array<{ languageCode: string; delayValue: number; delayUnit: "MINUTES" | "HOURS" | "DAYS"; text: string }> =>
  input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [delayToken, ...messageParts] = line.split("|");
      const text = messageParts.join("|").trim();
      const match = delayToken?.trim().match(/^(\d+)(m|h|d)$/i);

      if (!match) {
        throw new Error(`Invalid delay token: ${delayToken}`);
      }

      const [, value, unit] = match;
      return {
        languageCode,
        delayValue: Number(value),
        delayUnit: unit!.toLowerCase() === "m" ? "MINUTES" : unit!.toLowerCase() === "h" ? "HOURS" : "DAYS",
        text
      };
    });
