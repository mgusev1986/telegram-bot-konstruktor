import { Markup, Scenes } from "telegraf";

import { extractFormattedContentText, extractMessageContent, readTextMessage, type MessageContent } from "../helpers/message-content";
import type { BotContext } from "../context";
import {
  buildCancelKeyboard,
  buildNavigationRow,
  buildReturnToAdminKeyboard,
  buildScheduledBroadcastDetailKeyboard,
  buildStaleActionKeyboard,
  SCENE_CANCEL_DATA
} from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";
import { env } from "../../config/env";
import { addDaysToZonedDateParts, getZonedDateParts, isValidTimeZone, zonedTimeToUtcMs } from "../../common/timezone";
import { logger } from "../../common/logger";

export const CREATE_BROADCAST_SCENE = "create-broadcast-scene";
export const CREATE_SCHEDULED_BROADCAST_SCENE = "create-scheduled-broadcast-scene";

const BROADCAST_PREFIX = "broadcast";
const LANG_CODES = ["ru", "en"] as const;
const AUDIENCE_CODES = ["first_line", "structure", "language"] as const;
const CONTENT_LANG_ALL = "all" as const;

const DELIVERY_DATE_PREFIX = "del_date";
const DELIVERY_TIME_PREFIX = "del_time";

const DATE_MODES = ["TODAY", "TOMORROW", "PLUS2", "CUSTOM"] as const;

const buildDeliveryDateKeyboard = (locale: string, i18n: BotContext["services"]["i18n"]) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📅 Сегодня", makeCallbackData(BROADCAST_PREFIX, DELIVERY_DATE_PREFIX, "today"))],
    [Markup.button.callback("📅 Завтра", makeCallbackData(BROADCAST_PREFIX, DELIVERY_DATE_PREFIX, "tomorrow"))],
    [Markup.button.callback("📅 Через 2 дня", makeCallbackData(BROADCAST_PREFIX, DELIVERY_DATE_PREFIX, "plus2"))],
    [Markup.button.callback("📅 Выбрать дату", makeCallbackData(BROADCAST_PREFIX, DELIVERY_DATE_PREFIX, "custom"))],
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);
};

const DELIVERY_TIME_PRESETS = ["09:00", "12:00", "15:00", "18:00", "21:00"] as const;

const buildDeliveryTimeKeyboard = (locale: string, i18n: BotContext["services"]["i18n"]) => {
  return Markup.inlineKeyboard([
    ...DELIVERY_TIME_PRESETS.map((t) => [Markup.button.callback(t, makeCallbackData(BROADCAST_PREFIX, DELIVERY_TIME_PREFIX, "preset", t))]),
    [Markup.button.callback("🕒 Указать своё время", makeCallbackData(BROADCAST_PREFIX, DELIVERY_TIME_PREFIX, "custom"))],
    [Markup.button.callback("⬅️ Назад", makeCallbackData(BROADCAST_PREFIX, DELIVERY_TIME_PREFIX, "back_to_date"))],
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);
};

const parseYmd = (raw: string): { year: number; month: number; day: number } | null => {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { year, month, day };
};

const parseHm = (raw: string): { hour: number; minute: number } | null => {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
};

const formatDateLabel = (draft: import("../context").CreateBroadcastDraft) => {
  if (draft.deliveryDateMode === "TODAY") return "Сегодня";
  if (draft.deliveryDateMode === "TOMORROW") return "Завтра";
  if (draft.deliveryDateMode === "PLUS2") return "Через 2 дня";
  if (draft.deliveryDateMode === "CUSTOM") return draft.deliveryDate ?? "Дата";
  return "Дата";
};

const formatAudienceLabel = (draft: import("../context").CreateBroadcastDraft) => {
  if (draft.audienceType === "OWN_FIRST_LINE") return "👥 Первая линия";
  if (draft.audienceType === "OWN_STRUCTURE") return "🕸 Вся структура";
  if (draft.audienceType === "LANGUAGE") {
    const languages = Array.isArray(draft.segmentQuery?.languages) ? (draft.segmentQuery?.languages as string[]) : [];
    const hasAll =
      languages.length >= LANG_CODES.length && LANG_CODES.every((c) => languages.includes(c as unknown as string));
    if (hasAll) return "🌐 Все языки";
    const code = languages[0];
    return code === "en" ? "🌍 По языку (English)" : "🌍 По языку (Русский)";
  }
  return "🗂 Все пользователи";
};

const formatContentLanguageLabel = (draft: import("../context").CreateBroadcastDraft) => {
  if (draft.languageCode === CONTENT_LANG_ALL) return "🌐 Все языки";
  return draft.languageCode ?? "ru";
};

const buildBroadcastContentLanguageKeyboard = (locale: string, i18n: BotContext["services"]["i18n"]) => {
  const rows = LANG_CODES.map((code) => [
    Markup.button.callback(code === "ru" ? "Русский" : "English", makeCallbackData(BROADCAST_PREFIX, "lang", code))
  ]);

  // Bottom "All languages" option.
  rows.push([Markup.button.callback("🌐 Все языки", makeCallbackData(BROADCAST_PREFIX, "lang", CONTENT_LANG_ALL))]);
  rows.push([Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)]);
  rows.push(...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn]));
  return Markup.inlineKeyboard(rows);
};

const buildAudienceKeyboard = (locale: string, i18n: BotContext["services"]["i18n"]) =>
  Markup.inlineKeyboard([
    [Markup.button.callback("👥 Первая линия", makeCallbackData(BROADCAST_PREFIX, "aud", "first_line"))],
    [Markup.button.callback("🕸 Вся структура", makeCallbackData(BROADCAST_PREFIX, "aud", "structure"))],
    [Markup.button.callback("🌍 По языку", makeCallbackData(BROADCAST_PREFIX, "aud", "language"))],
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

const buildAudienceLanguageKeyboard = (locale: string, i18n: BotContext["services"]["i18n"]) =>
  Markup.inlineKeyboard([
    [Markup.button.callback("Русский", makeCallbackData(BROADCAST_PREFIX, "aud_lang", "ru"))],
    [Markup.button.callback("English", makeCallbackData(BROADCAST_PREFIX, "aud_lang", "en"))],
    [Markup.button.callback("🌐 Все языки", makeCallbackData(BROADCAST_PREFIX, "aud_lang", CONTENT_LANG_ALL))],
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

type BroadcastDeliveryMode = "single" | "follow_up";

const FOLLOW_UP_MEDIA_TYPES = new Set(["PHOTO", "VIDEO", "DOCUMENT", "VOICE", "VIDEO_NOTE"] as const);

const canUseFollowUpDelivery = (content: MessageContent | undefined): boolean =>
  Boolean(content?.mediaType && FOLLOW_UP_MEDIA_TYPES.has(content.mediaType as any));

const clearPreparedBroadcastState = (
  state: {
    preparedContent?: MessageContent;
    preparedFollowUpText?: string;
    awaitingFollowUpTextInput?: boolean;
    preparedDeliveryMode?: BroadcastDeliveryMode;
  }
) => {
  state.preparedContent = undefined;
  state.preparedFollowUpText = undefined;
  state.awaitingFollowUpTextInput = false;
  state.preparedDeliveryMode = undefined;
};

const buildBroadcastContentModeKeyboard = (locale: string, i18n: BotContext["services"]["i18n"]) =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🧾 Одним сообщением", makeCallbackData(BROADCAST_PREFIX, "content_mode", "single"))],
    [Markup.button.callback("➡️ Медиа, потом текст", makeCallbackData(BROADCAST_PREFIX, "content_mode", "follow_up"))],
    [Markup.button.callback("✏️ Отправить другой контент", makeCallbackData(BROADCAST_PREFIX, "content_mode", "replace"))],
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

const buildBroadcastContentModePrompt = (
  content: MessageContent & { entities?: any[] }
): string => {
  const textPreview = extractFormattedContentText(content).trim();
  if (content.mediaType === "VIDEO_NOTE") {
    return textPreview
      ? "Кружок получен. Можно оставить его как одно сообщение или отправить текст отдельным сообщением сразу после кружка."
      : "Кружок получен. Оставить только кружок или добавить текст отдельным сообщением сразу после него?";
  }

  return textPreview
    ? "Контент получен. Отправить текст подписью в этом же сообщении или отдельным сообщением сразу после медиа?"
    : "Контент получен. Оставить только медиа или добавить отдельный текст сразу после него?";
};

const formatBroadcastDeliveryModeLabel = (
  content: MessageContent | undefined,
  followUpText?: string
): string => {
  if (!content?.mediaType || content.mediaType === "NONE") {
    return "1 сообщение: текст";
  }
  if (followUpText?.trim()) {
    return content.mediaType === "VIDEO_NOTE"
      ? "2 сообщения: кружок, затем текст"
      : "2 сообщения: медиа, затем текст";
  }
  if (content.mediaType === "VIDEO_NOTE") {
    return "1 сообщение: только кружок";
  }
  return "1 сообщение: медиа и подпись";
};

const createBroadcastWizard = (mode: "instant" | "scheduled") =>
  new Scenes.WizardScene<any>(
    mode === "instant" ? CREATE_BROADCAST_SCENE : CREATE_SCHEDULED_BROADCAST_SCENE,
    async (ctx) => {
      (ctx.wizard.state as { draft?: import("../context").CreateBroadcastDraft; awaitingAudienceLang?: boolean }).draft = {
        mode
      };
      (ctx.wizard.state as { awaitingAudienceLang?: boolean }).awaitingAudienceLang = false;

      // If entered from "scheduled broadcast detail" we can do true-edit.
      const editBroadcastId = (ctx.scene.state as any)?.editBroadcastId as string | undefined;
      const editScheduleToken = (ctx.scene.state as any)?.editScheduleToken as string | undefined;
      (ctx.wizard.state as any).editBroadcastId = editBroadcastId;
      (ctx.wizard.state as any).editScheduleToken = editScheduleToken;

      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
      await ctx.reply(
        "Шаг 1. Выберите аудиторию рассылки:",
        buildAudienceKeyboard(locale, ctx.services.i18n)
      );
      return ctx.wizard.next();
    },
    async (ctx) => {
      const state = (ctx.wizard.state as { draft?: import("../context").CreateBroadcastDraft; awaitingAudienceLang?: boolean });
      const draft = (state.draft ??= {});
      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);

      if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;
        const parts = data.split(":");
        if (parts[0] === BROADCAST_PREFIX && parts[1] === "aud" && AUDIENCE_CODES.includes(parts[2] as typeof AUDIENCE_CODES[number])) {
          await ctx.answerCbQuery();
          const code = parts[2] as typeof AUDIENCE_CODES[number];
          if (code === "first_line") {
            draft.audienceType = "OWN_FIRST_LINE";
            draft.segmentQuery = {};
          } else if (code === "structure") {
            draft.audienceType = "OWN_STRUCTURE";
            draft.segmentQuery = {};
          } else {
            state.awaitingAudienceLang = true;
            draft.audienceType = "LANGUAGE";
            draft.segmentQuery = {};
            await ctx.reply("Выберите язык аудитории:", buildAudienceLanguageKeyboard(locale, ctx.services.i18n));
            return;
          }

          if (mode === "scheduled") {
            await ctx.reply("Шаг 2. Выберите дату отправки:", buildDeliveryDateKeyboard(locale, ctx.services.i18n));
          } else {
            await ctx.reply("Шаг 2: Выберите язык контента рассылки.", buildBroadcastContentLanguageKeyboard(locale, ctx.services.i18n));
          }
          return ctx.wizard.next();
        }
        if (
          parts[0] === BROADCAST_PREFIX &&
          parts[1] === "aud_lang" &&
          (LANG_CODES.includes(parts[2] as typeof LANG_CODES[number]) || parts[2] === CONTENT_LANG_ALL)
        ) {
          await ctx.answerCbQuery();
          draft.audienceType = "LANGUAGE";
          draft.segmentQuery =
            parts[2] === CONTENT_LANG_ALL ? { languages: [...LANG_CODES] } : { languages: [parts[2]] };
          state.awaitingAudienceLang = false;
          if (mode === "scheduled") {
            await ctx.reply("Шаг 2. Выберите дату отправки:", buildDeliveryDateKeyboard(locale, ctx.services.i18n));
          } else {
            await ctx.reply("Шаг 2: Выберите язык контента рассылки.", buildBroadcastContentLanguageKeyboard(locale, ctx.services.i18n));
          }
          return ctx.wizard.next();
        }
        if (
          parts[0] === BROADCAST_PREFIX &&
          parts[1] === "lang" &&
          (LANG_CODES.includes(parts[2] as typeof LANG_CODES[number]) || parts[2] === CONTENT_LANG_ALL)
        ) {
          await ctx.answerCbQuery();
          draft.languageCode = parts[2] as any;
          await ctx.reply("Отправьте текст, фото, видео, документ, голосовое или кружок для рассылки.", buildCancelKeyboard(ctx.services.i18n, locale));
          return ctx.wizard.next();
        }
      }

      // If admin typed something instead of pressing buttons, re-show selection.
      await ctx.reply("Выберите аудиторию кнопкой ниже:", buildAudienceKeyboard(locale, ctx.services.i18n));
      return;
    },
    async (ctx) => {
      const draft = ((ctx.wizard.state as { draft?: import("../context").CreateBroadcastDraft }).draft ??= {});
      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);

      if (mode === "scheduled") {
        const state = ctx.wizard.state as {
          draft?: import("../context").CreateBroadcastDraft;
          awaitingCustomDateInput?: boolean;
          awaitingCustomTimeInput?: boolean;
        };

        const replyDateStep = async () => {
          await ctx.reply("Шаг 2. Выберите дату отправки:", buildDeliveryDateKeyboard(locale, ctx.services.i18n));
        };

        // Callback-driven buttons (date/time presets).
        if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
          const data = ctx.callbackQuery.data;
          const parts = data.split(":");
          if (parts[0] === BROADCAST_PREFIX && parts[1] === DELIVERY_DATE_PREFIX) {
            await ctx.answerCbQuery();
            const choice = parts[2];
            if (choice === "today") {
              draft.deliveryDateMode = "TODAY";
              draft.deliveryDate = undefined;
            } else if (choice === "tomorrow") {
              draft.deliveryDateMode = "TOMORROW";
              draft.deliveryDate = undefined;
            } else if (choice === "plus2") {
              draft.deliveryDateMode = "PLUS2";
              draft.deliveryDate = undefined;
            } else if (choice === "custom") {
              draft.deliveryDateMode = "CUSTOM";
              state.awaitingCustomDateInput = true;
              state.awaitingCustomTimeInput = false;
              await ctx.reply(
                "Введите дату в формате YYYY-MM-DD:",
                buildCancelKeyboard(ctx.services.i18n, locale)
              );
              return;
            }

            state.awaitingCustomDateInput = false;
            state.awaitingCustomTimeInput = false;
            await ctx.reply("Шаг 3. Выберите время отправки:", buildDeliveryTimeKeyboard(locale, ctx.services.i18n));
            return;
          }

          if (parts[0] === BROADCAST_PREFIX && parts[1] === DELIVERY_TIME_PREFIX) {
            await ctx.answerCbQuery();
            const action = parts[2];
            if (action === "back_to_date") {
              draft.deliveryTime = undefined;
              state.awaitingCustomTimeInput = false;
              await replyDateStep();
              return;
            }
            if (action === "preset") {
              const timeRaw = parts.slice(3).join(":");
              const parsed = parseHm(timeRaw);
              if (!parsed) {
                await ctx.reply("Некорректное время. Выберите заново:", buildDeliveryTimeKeyboard(locale, ctx.services.i18n));
                return;
              }
              const hh = String(parsed.hour).padStart(2, "0");
              const mm = String(parsed.minute).padStart(2, "0");
              draft.deliveryTime = `${hh}:${mm}`;
              await ctx.reply(
                "Шаг 4: Выберите язык контента рассылки.",
                buildBroadcastContentLanguageKeyboard(locale, ctx.services.i18n)
              );
              return ctx.wizard.next();
            }
            if (action === "custom") {
              state.awaitingCustomTimeInput = true;
              state.awaitingCustomDateInput = false;
              await ctx.reply("Укажите время в формате HH:MM:", buildCancelKeyboard(ctx.services.i18n, locale));
              return;
            }
          }
        }

        // Message input for custom date/time.
        if (state.awaitingCustomDateInput) {
          const rawDate = readTextMessage(ctx).trim();
          const parsed = parseYmd(rawDate);
          if (!parsed) {
            await ctx.reply("Некорректная дата. Пример: 2026-03-16");
            await replyDateStep();
            state.awaitingCustomDateInput = false;
            return;
          }
          draft.deliveryDateMode = "CUSTOM";
          draft.deliveryDate = `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
          state.awaitingCustomDateInput = false;
          state.awaitingCustomTimeInput = false;
          await ctx.reply("Шаг 3. Выберите время отправки:", buildDeliveryTimeKeyboard(locale, ctx.services.i18n));
          return;
        }

        if (state.awaitingCustomTimeInput) {
          const rawTime = readTextMessage(ctx).trim();
          const parsed = parseHm(rawTime);
          if (!parsed) {
            await ctx.reply("Некорректное время. Пример: 09:30");
            state.awaitingCustomTimeInput = false;
            await ctx.reply("Шаг 3. Выберите время отправки:", buildDeliveryTimeKeyboard(locale, ctx.services.i18n));
            return;
          }
          const hh = String(parsed.hour).padStart(2, "0");
          const mm = String(parsed.minute).padStart(2, "0");
          draft.deliveryTime = `${hh}:${mm}`;
          state.awaitingCustomTimeInput = false;
          await ctx.reply(
            "Шаг 4: Выберите язык контента рассылки.",
            buildBroadcastContentLanguageKeyboard(locale, ctx.services.i18n)
          );
          return ctx.wizard.next();
        }

        // If admin sent anything unexpected, re-show date selection.
        await replyDateStep();
        return;
      }

      if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;
        const parts = data.split(":");
        if (
          parts[0] === BROADCAST_PREFIX &&
          parts[1] === "lang" &&
          (LANG_CODES.includes(parts[2] as typeof LANG_CODES[number]) || parts[2] === CONTENT_LANG_ALL)
        ) {
          await ctx.answerCbQuery();
          draft.languageCode = parts[2] as any;
          await ctx.reply("Отправьте текст, фото, видео, документ, голосовое или кружок для рассылки.", buildCancelKeyboard(ctx.services.i18n, locale));
          return ctx.wizard.next();
        }
      }

      const langText = readTextMessage(ctx).trim().toLowerCase();
      if (["ru", "en"].includes(langText)) draft.languageCode = langText;
      if (["all", "all_languages", "все", "всеязыки"].includes(langText)) draft.languageCode = CONTENT_LANG_ALL;
      await ctx.reply("Отправьте текст, фото, видео, документ, голосовое или кружок для рассылки.", buildCancelKeyboard(ctx.services.i18n, locale));
      return ctx.wizard.next();
    },
    async (ctx) => {
      const draft = ((ctx.wizard.state as { draft?: import("../context").CreateBroadcastDraft }).draft ??= {});
      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);

      const state = ctx.wizard.state as {
        draft?: import("../context").CreateBroadcastDraft;
        preparedContent?: MessageContent;
        preparedFollowUpText?: string;
        awaitingFollowUpTextInput?: boolean;
        preparedDeliveryMode?: BroadcastDeliveryMode;
      };

      if (mode === "scheduled") {
        // keep legacy scheduled content step
        if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
          const data = ctx.callbackQuery.data;
          const parts = data.split(":");
          if (
            parts[0] === BROADCAST_PREFIX &&
            parts[1] === "lang" &&
            (LANG_CODES.includes(parts[2] as typeof LANG_CODES[number]) || parts[2] === CONTENT_LANG_ALL)
          ) {
            await ctx.answerCbQuery();
            draft.languageCode = parts[2] as any;
            await ctx.reply("Отправьте текст, фото, видео, документ, голосовое или кружок для рассылки.", buildCancelKeyboard(ctx.services.i18n, locale));
            return ctx.wizard.next();
          }
        }
        const langText = readTextMessage(ctx).trim().toLowerCase();
        if (["ru", "en"].includes(langText)) draft.languageCode = langText;
        if (["all", "all_languages", "все", "всеязыки"].includes(langText)) draft.languageCode = CONTENT_LANG_ALL;
        await ctx.reply("Отправьте текст, фото, видео, документ, голосовое или кружок для рассылки.", buildCancelKeyboard(ctx.services.i18n, locale));
        return ctx.wizard.next();
      }

      // instant mode: confirm-before-send
      const confirmSend = makeCallbackData(BROADCAST_PREFIX, "confirm", "send");
      const confirmEdit = makeCallbackData(BROADCAST_PREFIX, "confirm", "edit");
      const confirmCancel = makeCallbackData(BROADCAST_PREFIX, "confirm", "cancel");
      const showPreparedConfirmation = async () => {
        const formatLabel = formatBroadcastDeliveryModeLabel(state.preparedContent, state.preparedFollowUpText);
        await ctx.reply(
          `Готово. Подтвердите отправку рассылки:\nФормат: ${formatLabel}`,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Отправить", confirmSend)],
            [Markup.button.callback("✏️ Редактировать", confirmEdit)],
            [Markup.button.callback("❌ Отменить", confirmCancel)]
          ])
        );
      };

      if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;
        const parts = data.split(":");

        if (parts[0] === BROADCAST_PREFIX && parts[1] === "content_mode") {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }

          if (parts[2] === "replace") {
            clearPreparedBroadcastState(state);
            await ctx.reply(
              "Отправьте текст, фото, видео, документ, голосовое или кружок для рассылки.",
              buildCancelKeyboard(ctx.services.i18n, locale)
            );
            return;
          }

          const content = state.preparedContent;
          if (!content) {
            await ctx.reply("Контент не найден. Отправьте его заново.", buildCancelKeyboard(ctx.services.i18n, locale));
            return;
          }

          if (parts[2] === "single") {
            state.preparedDeliveryMode = "single";
            state.preparedFollowUpText = undefined;
            state.awaitingFollowUpTextInput = false;
            await showPreparedConfirmation();
            return;
          }

          if (parts[2] === "follow_up") {
            const extractedFollowUpText = extractFormattedContentText(content as MessageContent & { entities?: any[] }).trim();
            state.preparedDeliveryMode = "follow_up";
            state.preparedContent = { ...content, text: "" };
            state.preparedFollowUpText = extractedFollowUpText || undefined;

            if (extractedFollowUpText) {
              state.awaitingFollowUpTextInput = false;
              await showPreparedConfirmation();
              return;
            }

            state.awaitingFollowUpTextInput = true;
            await ctx.reply(
              content.mediaType === "VIDEO_NOTE"
                ? "Теперь отправьте текст, который должен прийти сразу после кружка."
                : "Теперь отправьте текст, который должен прийти сразу после медиа отдельным сообщением.",
              buildCancelKeyboard(ctx.services.i18n, locale)
            );
            return;
          }
        }

        if (data === confirmEdit) {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }
          clearPreparedBroadcastState(state);
          await ctx.reply(
            "Отправьте текст, фото, видео, документ, голосовое или кружок заново для рассылки.",
            buildCancelKeyboard(ctx.services.i18n, locale)
          );
          return;
        }

        if (data === confirmCancel) {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }
          clearPreparedBroadcastState(state);
          state.draft = undefined;
          await ctx.reply("Подготовка рассылки отменена.", buildReturnToAdminKeyboard(ctx.services.i18n, locale));
          return ctx.scene.leave();
        }

        if (data === confirmSend) {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }

          const content = state.preparedContent;
          if (!content || (!content.text && !content.mediaFileId && !content.externalUrl)) {
            await ctx.reply("Контент не найден. Повторите подготовку рассылки.", buildCancelKeyboard(ctx.services.i18n, locale));
            return;
          }

          const textForStorage = extractFormattedContentText(content);
          const broadcast = await ctx.services.broadcasts.createBroadcast({
            actorUserId: ctx.currentUser!.id,
            audienceType: draft.audienceType ?? "ALL_USERS",
            segmentQuery: draft.segmentQuery,
            languageCode: draft.languageCode === CONTENT_LANG_ALL ? LANG_CODES[0] : (draft.languageCode ?? "ru"),
            languageCodes:
              draft.languageCode === CONTENT_LANG_ALL
                ? [...LANG_CODES]
                : undefined,
            text: textForStorage,
            followUpText: state.preparedFollowUpText ?? "",
            mediaType: content.mediaType,
            mediaFileId: content.mediaFileId,
            externalUrl: content.externalUrl
          });

          const chatId = ctx.chat?.id ?? ctx.currentUser?.telegramUserId;
          if (chatId == null) {
            clearPreparedBroadcastState(state);
            state.draft = undefined;
            await ctx.reply("Не удалось определить чат для прогресса.", buildReturnToAdminKeyboard(ctx.services.i18n, locale));
            return ctx.scene.leave();
          }

          const progressMsg = await ctx.reply("Рассылка запускается...");
          const render = (s: any) => {
            const total = s?.totalRecipients ?? 0;
            const processed = s?.processedCount ?? 0;
            const success = s?.successCount ?? 0;
            const failed = s?.failedCount ?? 0;
            const pending = s?.pendingCount ?? Math.max(0, total - processed);
            return [
              "Рассылка выполняется",
              `- Всего: ${total}`,
              `- Отправлено: ${processed}`,
              `- Доставлено: ${success}`,
              `- С ошибкой: ${failed}`,
              `- Осталось: ${pending}`
            ].join("\n");
          };

          try {
            const finalStats = await ctx.services.broadcasts.dispatchBroadcast(broadcast.id, {
              onProgress: async (stats: any) => {
                try {
                  await ctx.telegram.editMessageText(chatId, progressMsg.message_id, undefined, render(stats));
                } catch {
                  // Ignore edit errors (rate-limit / same text / message already changed).
                }
              },
              progressEmitEvery: 20,
              progressEmitMinIntervalMs: 1200
            });

            const finalText = [
              "Рассылка завершена",
              `- Всего: ${finalStats.totalRecipients}`,
              `- Доставлено: ${finalStats.successCount}`,
              `- С ошибкой: ${finalStats.failedCount}`
            ].join("\n");

            const finalKb = buildStaleActionKeyboard(ctx.services.i18n, locale, true);
            try {
              await ctx.telegram.editMessageText(chatId, progressMsg.message_id, undefined, finalText, finalKb);
            } catch {
              // Ignore final edit errors (message already changed / can't be edited).
            }
          } finally {
            clearPreparedBroadcastState(state);
            state.draft = undefined;
          }
          return ctx.scene.leave();
        }
      }

      if (state.awaitingFollowUpTextInput) {
        const followUpContent = extractMessageContent(ctx);
        const followUpText = extractFormattedContentText(followUpContent as MessageContent & { entities?: any[] }).trim();
        if (followUpContent.mediaType || !followUpText) {
          await ctx.reply("Отправьте только текст вторым сообщением.", buildCancelKeyboard(ctx.services.i18n, locale));
          return;
        }
        state.preparedFollowUpText = followUpText;
        state.awaitingFollowUpTextInput = false;
        await showPreparedConfirmation();
        return;
      }

      const content = extractMessageContent(ctx);
      if (!content.text && !content.mediaFileId && !content.externalUrl) {
        await ctx.reply("Не получилось распознать контент. Отправьте текст, фото, видео, документ, голосовое или кружок.", buildCancelKeyboard(ctx.services.i18n, locale));
        return;
      }

      state.preparedContent = content;
      state.preparedFollowUpText = undefined;
      state.awaitingFollowUpTextInput = false;
      state.preparedDeliveryMode = "single";

      if (canUseFollowUpDelivery(content)) {
        await ctx.reply(
          buildBroadcastContentModePrompt(content as MessageContent & { entities?: any[] }),
          buildBroadcastContentModeKeyboard(locale, ctx.services.i18n)
        );
        return;
      }

      await showPreparedConfirmation();
    },
    async (ctx) => {
      const draft = ((ctx.wizard.state as { draft?: import("../context").CreateBroadcastDraft }).draft ??= {});
      const state = ctx.wizard.state as {
        draft?: import("../context").CreateBroadcastDraft;
        preparedContent?: MessageContent;
        preparedFollowUpText?: string;
        awaitingFollowUpTextInput?: boolean;
        preparedDeliveryMode?: BroadcastDeliveryMode;
        scheduledPrepared?: boolean;
        editBroadcastId?: string;
        editScheduleToken?: string;
      };
      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);

      const confirmSend = makeCallbackData(BROADCAST_PREFIX, "sched_confirm", "send");
      const confirmEdit = makeCallbackData(BROADCAST_PREFIX, "sched_confirm", "edit");
      const confirmCancel = makeCallbackData(BROADCAST_PREFIX, "sched_confirm", "cancel");
      const showScheduledConfirmation = async () => {
        const dateLabel = formatDateLabel(draft);
        const timeLabel = draft.deliveryTime ?? "—";
        const formatLabel = formatBroadcastDeliveryModeLabel(state.preparedContent, state.preparedFollowUpText);

        await ctx.reply(
          `Подтвердите отложенную рассылку:\n` +
            `Аудитория: ${formatAudienceLabel(draft)}\n` +
            `Язык контента: ${formatContentLanguageLabel(draft)}\n` +
            `Формат: ${formatLabel}\n` +
            `Дата: ${dateLabel}\n` +
            `Время: ${timeLabel}\n\n` +
            `Важно: отправка будет выполнена в это локальное время каждого пользователя.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Подтвердить", confirmSend)],
            [Markup.button.callback("✏️ Изменить", confirmEdit)],
            [Markup.button.callback("❌ Отменить", confirmCancel)]
          ])
        );
      };

      if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
        const data = ctx.callbackQuery.data;
        const parts = data.split(":");

        if (parts[0] === BROADCAST_PREFIX && parts[1] === "content_mode") {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }

          if (parts[2] === "replace") {
            clearPreparedBroadcastState(state);
            await ctx.reply(
              "Отправьте текст, фото, видео, документ, голосовое или кружок заново для рассылки.",
              buildCancelKeyboard(ctx.services.i18n, locale)
            );
            return;
          }

          const content = state.preparedContent;
          if (!content) {
            await ctx.reply("Контент не найден. Отправьте его заново.", buildCancelKeyboard(ctx.services.i18n, locale));
            return;
          }

          if (parts[2] === "single") {
            state.preparedDeliveryMode = "single";
            state.preparedFollowUpText = undefined;
            state.awaitingFollowUpTextInput = false;
            await showScheduledConfirmation();
            return;
          }

          if (parts[2] === "follow_up") {
            const extractedFollowUpText = extractFormattedContentText(content as MessageContent & { entities?: any[] }).trim();
            state.preparedDeliveryMode = "follow_up";
            state.preparedContent = { ...content, text: "" };
            state.preparedFollowUpText = extractedFollowUpText || undefined;

            if (extractedFollowUpText) {
              state.awaitingFollowUpTextInput = false;
              await showScheduledConfirmation();
              return;
            }

            state.awaitingFollowUpTextInput = true;
            await ctx.reply(
              content.mediaType === "VIDEO_NOTE"
                ? "Теперь отправьте текст, который должен прийти сразу после кружка."
                : "Теперь отправьте текст, который должен прийти сразу после медиа отдельным сообщением.",
              buildCancelKeyboard(ctx.services.i18n, locale)
            );
            return;
          }
        }

        if (data === confirmEdit) {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }
          clearPreparedBroadcastState(state);
          await ctx.reply(
            "Отправьте текст, фото, видео, документ, голосовое или кружок заново для рассылки.",
            buildCancelKeyboard(ctx.services.i18n, locale)
          );
          return;
        }

        if (data === confirmCancel) {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }
          clearPreparedBroadcastState(state);
          state.draft = undefined;
          await ctx.reply("Подготовка отложенной рассылки отменена.", buildReturnToAdminKeyboard(ctx.services.i18n, locale));
          return ctx.scene.leave();
        }

        if (data === confirmSend) {
          try {
            await ctx.answerCbQuery();
          } catch {
            // ignore
          }

          const content = state.preparedContent;
          if (!content) {
            await ctx.reply("Контент не найден. Подготовьте рассылку заново.", buildCancelKeyboard(ctx.services.i18n, locale));
            return;
          }

          const deliveryDateMode = draft.deliveryDateMode;
          const deliveryTime = draft.deliveryTime;
          if (!deliveryDateMode || !deliveryTime) {
            await ctx.reply("Не выбрано время/датa доставки. Повторите настройку.", buildCancelKeyboard(ctx.services.i18n, locale));
            return;
          }

          const parsedTime = parseHm(deliveryTime);
          if (!parsedTime) {
            await ctx.reply("Некорректный формат времени. Ожидается HH:MM.", buildCancelKeyboard(ctx.services.i18n, locale));
            return;
          }

          const fallbackTimeZone = env.APP_TIMEZONE;

          const recipients = await ctx.services.segments.resolveAudience({
            audienceType: draft.audienceType ?? "ALL_USERS",
            requesterUserId: ctx.currentUser!.id,
            segmentQuery: draft.segmentQuery
          });

          // OWNER verification recipient:
          // ensure bot OWNER also receives the delayed broadcast as a normal recipient.
          // This is required for preview/verification even when he is not in the segment.
          const isAlphaOwner = ctx.currentUser?.telegramUserId === env.SUPER_ADMIN_TELEGRAM_ID;
          const botRole = await ctx.services.permissions.getActiveBotRole(ctx.currentUser!.id);
          if (isAlphaOwner || botRole === "OWNER") {
            const ownerId = ctx.currentUser!.id;
            const already = (recipients as any[]).some((u: any) => u.id === ownerId);
            if (!already) recipients.push(ctx.currentUser as any);
          }

          const timeZoneGroups = new Map<string, number>();
          let unknownTzCount = 0;

          for (const u of recipients) {
            const userTz = u.timeZone;
            const effective = userTz && isValidTimeZone(userTz) ? userTz : fallbackTimeZone;
            if (!userTz || !isValidTimeZone(userTz)) unknownTzCount += 1;
            timeZoneGroups.set(effective, (timeZoneGroups.get(effective) ?? 0) + 1);
          }

          const nowMs = Date.now();
          const now = new Date();

          const runAtByTz = new Map<string, Date>();
          let earliestRunAt: Date | null = null;

          for (const tz of timeZoneGroups.keys()) {
            let targetDateParts;
            if (deliveryDateMode === "CUSTOM") {
              const parsedDate = draft.deliveryDate ? parseYmd(draft.deliveryDate) : null;
              if (!parsedDate) {
                await ctx.reply("Некорректная дата доставки. Ожидается YYYY-MM-DD.", buildCancelKeyboard(ctx.services.i18n, locale));
                return;
              }
              targetDateParts = parsedDate;
            } else {
              const base = getZonedDateParts(now, tz);
              const relDays = deliveryDateMode === "TODAY" ? 0 : deliveryDateMode === "TOMORROW" ? 1 : deliveryDateMode === "PLUS2" ? 2 : 0;
              targetDateParts = addDaysToZonedDateParts(base, relDays, tz);
            }

            const firstUtcMs = zonedTimeToUtcMs(
              { ...targetDateParts, hour: parsedTime.hour, minute: parsedTime.minute },
              tz
            );
            let utcMs = firstUtcMs;
            if (utcMs <= nowMs) {
              const shifted = addDaysToZonedDateParts(targetDateParts, 1, tz);
              utcMs = zonedTimeToUtcMs(
                { ...shifted, hour: parsedTime.hour, minute: parsedTime.minute },
                tz
              );
            }

            const runAt = new Date(utcMs);
            runAtByTz.set(tz, runAt);
            if (!earliestRunAt || runAt.getTime() < earliestRunAt.getTime()) {
              earliestRunAt = runAt;
            }
          }

          if (!earliestRunAt) {
            await ctx.reply("Не удалось вычислить время доставки. Попробуйте ещё раз.", buildReturnToAdminKeyboard(ctx.services.i18n, locale));
            return ctx.scene.leave();
          }

          const editBroadcastId = state.editBroadcastId as string | undefined;
          const editScheduleToken = (state.editScheduleToken as string | undefined) ?? `${Date.now()}`;

          const languageCode = draft.languageCode === CONTENT_LANG_ALL ? LANG_CODES[0] : (draft.languageCode ?? "ru");
          const languageCodes = draft.languageCode === CONTENT_LANG_ALL ? [...LANG_CODES] : undefined;
          const textForStorage = extractFormattedContentText(content);

          if (editBroadcastId) {
            await ctx.services.broadcasts.prepareScheduledBroadcastEdit(ctx.currentUser!.id, editBroadcastId, {
              audienceType: draft.audienceType ?? "ALL_USERS",
              segmentQuery: draft.segmentQuery,
              languageCode,
              languageCodes,
              text: textForStorage,
              followUpText: state.preparedFollowUpText ?? "",
              mediaType: content.mediaType,
              mediaFileId: content.mediaFileId,
              externalUrl: content.externalUrl,
              sendAt: earliestRunAt
            });

            for (const [tz, runAt] of runAtByTz.entries()) {
              await ctx.services.scheduler.schedule(
                "SEND_BROADCAST_BATCH",
                {
                  broadcastId: editBroadcastId,
                  recipientTimeZone: tz,
                  fallbackTimeZone
                },
                runAt,
                `broadcast:${editBroadcastId}:${editScheduleToken}:tz:${tz}`
              );
            }

            await ctx.services.broadcasts.markScheduledBroadcastRescheduled(ctx.currentUser!.id, editBroadcastId);

            logger.info(
              {
                broadcastId: editBroadcastId,
                audienceType: draft.audienceType ?? "ALL_USERS",
                recipientsCount: recipients.length,
                timeZoneGroupsCount: timeZoneGroups.size,
                editScheduleToken,
                runAtByTz: Array.from(runAtByTz.entries()).map(([tz, d]) => ({ tz, runAt: d.toISOString() }))
              },
              "Scheduled broadcast edited: batches enqueued"
            );

            await ctx.reply(
              `Отложенная рассылка обновлена и запланирована: ${editBroadcastId}\n\n` +
                `Доставка: ${formatAudienceLabel(draft)} / ${formatContentLanguageLabel(draft)}\n` +
                `Время: ${formatDateLabel(draft)}, ${draft.deliveryTime}\n` +
                `Часовой пояс: локально для каждого пользователя (fallback: ${fallbackTimeZone}).` +
                (unknownTzCount > 0 ? `\nНе задан timezone: ${unknownTzCount}` : ""),
              buildScheduledBroadcastDetailKeyboard(locale, ctx.services.i18n, editBroadcastId)
            );
          } else {
            const broadcast = await ctx.services.broadcasts.createBroadcast({
              actorUserId: ctx.currentUser!.id,
              audienceType: draft.audienceType ?? "ALL_USERS",
              segmentQuery: draft.segmentQuery,
              languageCode,
              languageCodes,
              text: textForStorage,
              followUpText: state.preparedFollowUpText ?? "",
              mediaType: content.mediaType,
              mediaFileId: content.mediaFileId,
              externalUrl: content.externalUrl,
              sendAt: earliestRunAt,
              skipScheduler: true
            });

            for (const [tz, runAt] of runAtByTz.entries()) {
              await ctx.services.scheduler.schedule(
                "SEND_BROADCAST_BATCH",
                {
                  broadcastId: broadcast.id,
                  recipientTimeZone: tz,
                  fallbackTimeZone
                },
                runAt,
                `broadcast:${broadcast.id}:tz:${tz}`
              );
            }

            logger.info(
              {
                broadcastId: broadcast.id,
                audienceType: draft.audienceType ?? "ALL_USERS",
                recipientsCount: recipients.length,
                timeZoneGroupsCount: timeZoneGroups.size,
                runAtByTz: Array.from(runAtByTz.entries()).map(([tz, d]) => ({ tz, runAt: d.toISOString() }))
              },
              "Scheduled broadcast batches enqueued"
            );

            await ctx.reply(
              `Отложенная рассылка запланирована: ${broadcast.id}\n\n` +
                `Доставка: ${formatAudienceLabel(draft)} / ${formatContentLanguageLabel(draft)}\n` +
                `Время: ${formatDateLabel(draft)}, ${draft.deliveryTime}\n` +
                `Часовой пояс: локально для каждого пользователя (fallback: ${fallbackTimeZone}).` +
                (unknownTzCount > 0 ? `\nНе задан timezone: ${unknownTzCount}` : ""),
              buildReturnToAdminKeyboard(ctx.services.i18n, locale)
            );
          }

          clearPreparedBroadcastState(state);
          state.draft = undefined;
          return ctx.scene.leave();
        }
      }

      if (state.awaitingFollowUpTextInput) {
        const followUpContent = extractMessageContent(ctx);
        const followUpText = extractFormattedContentText(followUpContent as MessageContent & { entities?: any[] }).trim();
        if (followUpContent.mediaType || !followUpText) {
          await ctx.reply("Отправьте только текст вторым сообщением.", buildCancelKeyboard(ctx.services.i18n, locale));
          return;
        }
        state.preparedFollowUpText = followUpText;
        state.awaitingFollowUpTextInput = false;
        await showScheduledConfirmation();
        return;
      }

      const content = extractMessageContent(ctx);
      if (!content.text && !content.mediaFileId && !content.externalUrl) {
        await ctx.reply("Не получилось распознать контент. Отправьте текст, фото, видео, документ, голосовое или кружок.", buildCancelKeyboard(ctx.services.i18n, locale));
        return;
      }

      state.preparedContent = content;
      state.preparedFollowUpText = undefined;
      state.awaitingFollowUpTextInput = false;
      state.preparedDeliveryMode = "single";

      if (canUseFollowUpDelivery(content)) {
        await ctx.reply(
          buildBroadcastContentModePrompt(content as MessageContent & { entities?: any[] }),
          buildBroadcastContentModeKeyboard(locale, ctx.services.i18n)
        );
        return;
      }

      await showScheduledConfirmation();
    }
  );

export const createBroadcastScene = createBroadcastWizard("instant");
export const createScheduledBroadcastScene = createBroadcastWizard("scheduled");
