import { Markup, Scenes } from "telegraf";

import type { BotContext } from "../context";
import { extractFormattedContentText, extractMessageContent, readTextMessage } from "../helpers/message-content";
import { buildNavigationRow, SCENE_CANCEL_DATA } from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";

export const ADD_DRIP_STEP_SCENE = "add-drip-step-scene";
const PREFIX = "dripm";

type Phase = "delay" | "delay_number" | "delay_unit" | "content" | "content_mode" | "follow_up_text";

type State = {
  campaignId: string;
  phase: Phase;
  pendingDelay?: { value: number; unit: "MINUTES" | "HOURS" | "DAYS" };
  pendingContent?: import("../helpers/message-content").MessageContent;
};

const kb = (i18n: BotContext["services"]["i18n"], locale: string, rows: { text: string; data: string }[][]) =>
  Markup.inlineKeyboard([
    ...rows.map((r) => r.map((c) => Markup.button.callback(c.text, c.data))),
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

const FOLLOW_UP_MEDIA_TYPES = new Set(["PHOTO", "VIDEO", "DOCUMENT", "VOICE", "VIDEO_NOTE"] as const);

const canUseFollowUpDelivery = (content: import("../helpers/message-content").MessageContent | undefined): boolean =>
  Boolean(content?.mediaType && FOLLOW_UP_MEDIA_TYPES.has(content.mediaType as any));

export const addDripStepScene = new Scenes.WizardScene<any>(
  ADD_DRIP_STEP_SCENE,
  async (ctx) => {
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const sceneState = ctx.scene.state as { campaignId?: string };
    const campaignId = sceneState?.campaignId;
    if (!campaignId) {
      await ctx.reply(ctx.services.i18n.t(locale, "error_generic"));
      return ctx.scene.leave();
    }
    const state: State = { campaignId, phase: "delay" };
    ctx.wizard.state = state;

    await ctx.reply(
      "Шаг 1. Выберите задержку для нового шага:",
      kb(ctx.services.i18n, locale, [
        [{ text: ctx.services.i18n.t(locale, "drip_delay_now"), data: makeCallbackData(PREFIX, "delay", "0", "DAYS") }],
        [{ text: ctx.services.i18n.t(locale, "drip_delay_1d"), data: makeCallbackData(PREFIX, "delay", "1", "DAYS") }],
        [{ text: ctx.services.i18n.t(locale, "drip_delay_2d"), data: makeCallbackData(PREFIX, "delay", "2", "DAYS") }],
        [{ text: ctx.services.i18n.t(locale, "drip_delay_3d"), data: makeCallbackData(PREFIX, "delay", "3", "DAYS") }],
        [{ text: ctx.services.i18n.t(locale, "drip_delay_7d"), data: makeCallbackData(PREFIX, "delay", "7", "DAYS") }],
        [{ text: ctx.services.i18n.t(locale, "drip_delay_other"), data: makeCallbackData(PREFIX, "delay_other") }]
      ])
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const state = ctx.wizard.state as State;
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const i18n = ctx.services.i18n;

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const parts = ctx.callbackQuery.data.split(":");
      if (parts[0] === PREFIX && state.phase === "delay") {
        if (parts[1] === "delay" && parts[2] != null && parts[3] != null) {
          await ctx.answerCbQuery();
          const value = parseInt(parts[2], 10);
          const unit = parts[3] as "MINUTES" | "HOURS" | "DAYS";
          state.pendingDelay = { value, unit };
          state.phase = "content";
          await ctx.reply("Шаг 2. Отправьте текст, фото, видео, документ, голосовое или кружок для этого шага:", kb(i18n, locale, []));
          return ctx.wizard.next();
        }
        if (parts[1] === "delay_other") {
          await ctx.answerCbQuery();
          state.phase = "delay_number";
          await ctx.reply(i18n.t(locale, "drip_wizard_step_custom_value"), kb(i18n, locale, []));
          return;
        }
      }

      if (parts[0] === PREFIX && state.phase === "delay_unit" && parts[1] === "delay_unit" && parts[2]) {
        await ctx.answerCbQuery();
        const unit = parts[2] as "MINUTES" | "HOURS" | "DAYS";
        if (state.pendingDelay) state.pendingDelay.unit = unit;
        state.phase = "content";
        await ctx.reply("Шаг 2. Отправьте текст, фото, видео, документ, голосовое или кружок для этого шага:", kb(i18n, locale, []));
        return ctx.wizard.next();
      }
    }

    if (state.phase === "delay_number") {
      const raw = readTextMessage(ctx).trim();
      const num = parseInt(raw, 10);
      if (Number.isNaN(num) || num < 1 || num > 999) {
        await ctx.reply(i18n.t(locale, "drip_error_delay_number"), kb(i18n, locale, []));
        return;
      }
      state.pendingDelay = { value: num, unit: "DAYS" };
      state.phase = "delay_unit";
      await ctx.reply(
        i18n.t(locale, "drip_wizard_step_custom_unit"),
        kb(i18n, locale, [
          [{ text: i18n.t(locale, "drip_unit_minutes"), data: makeCallbackData(PREFIX, "delay_unit", "MINUTES") }],
          [{ text: i18n.t(locale, "drip_unit_hours"), data: makeCallbackData(PREFIX, "delay_unit", "HOURS") }],
          [{ text: i18n.t(locale, "drip_unit_days"), data: makeCallbackData(PREFIX, "delay_unit", "DAYS") }]
        ])
      );
      return;
    }

    // fallback: show delay keyboard again
    state.phase = "delay";
    await ctx.reply("Выберите задержку кнопкой ниже:", kb(i18n, locale, [
      [{ text: i18n.t(locale, "drip_delay_now"), data: makeCallbackData(PREFIX, "delay", "0", "DAYS") }],
      [{ text: i18n.t(locale, "drip_delay_1d"), data: makeCallbackData(PREFIX, "delay", "1", "DAYS") }],
      [{ text: i18n.t(locale, "drip_delay_2d"), data: makeCallbackData(PREFIX, "delay", "2", "DAYS") }],
      [{ text: i18n.t(locale, "drip_delay_3d"), data: makeCallbackData(PREFIX, "delay", "3", "DAYS") }],
      [{ text: i18n.t(locale, "drip_delay_7d"), data: makeCallbackData(PREFIX, "delay", "7", "DAYS") }],
      [{ text: i18n.t(locale, "drip_delay_other"), data: makeCallbackData(PREFIX, "delay_other") }]
    ]));
  },
  async (ctx) => {
    const state = ctx.wizard.state as State;
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const i18n = ctx.services.i18n;

    const persistStep = async (
      primaryContent: import("../helpers/message-content").MessageContent & { entities?: any[] },
      followUpText?: string
    ) => {
      const delay = state.pendingDelay ?? { value: 0, unit: "DAYS" as const };
      const textForStorage = extractFormattedContentText(primaryContent);
      return ctx.services.drips.appendStep(ctx.currentUser!.id, state.campaignId, {
        languageCode: locale,
        delayValue: delay.value,
        delayUnit: delay.unit,
        text: textForStorage.trim() || "",
        followUpText: followUpText?.trim() || "",
        mediaType: primaryContent.mediaType,
        mediaFileId: primaryContent.mediaFileId ?? null,
        externalUrl: primaryContent.externalUrl ?? null
      });
    };

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const parts = ctx.callbackQuery.data.split(":");
      if (parts[0] === PREFIX && state.phase === "content_mode" && parts[1] === "content_mode") {
        await ctx.answerCbQuery();
        const pendingContent = state.pendingContent as (import("../helpers/message-content").MessageContent & { entities?: any[] }) | undefined;
        if (!pendingContent) {
          state.phase = "content";
          await ctx.reply("Шаг 2. Отправьте текст, фото, видео, документ, голосовое или кружок для этого шага:", kb(i18n, locale, []));
          return;
        }

        if (parts[2] === "replace") {
          state.pendingContent = undefined;
          state.phase = "content";
          await ctx.reply("Шаг 2. Отправьте текст, фото, видео, документ, голосовое или кружок для этого шага:", kb(i18n, locale, []));
          return;
        }

        if (parts[2] === "follow_up") {
          const followUpText = extractFormattedContentText(pendingContent).trim();
          state.pendingContent = { ...pendingContent, text: "" };
          if (!followUpText) {
            state.phase = "follow_up_text";
            await ctx.reply(
              pendingContent.mediaType === "VIDEO_NOTE"
                ? "Теперь отправьте текст, который должен прийти сразу после кружка."
                : "Теперь отправьте текст, который должен прийти сразу после медиа отдельным сообщением.",
              kb(i18n, locale, [])
            );
            return;
          }

          const saved = await persistStep(state.pendingContent as import("../helpers/message-content").MessageContent & { entities?: any[] }, followUpText);
          if (!saved) {
            await ctx.reply(i18n.t(locale, "error_generic"));
            return ctx.scene.leave();
          }
          await ctx.reply(
            "✅ Шаг добавлен.",
            Markup.inlineKeyboard([
              [Markup.button.callback("🔗 Добавить кнопки к письму", makeCallbackData(PREFIX, "add_buttons", saved.id))],
              [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData(PREFIX, "open", state.campaignId))],
              [Markup.button.callback(i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
              ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
            ])
          );
          return ctx.scene.leave();
        }

        const saved = await persistStep(pendingContent);
        if (!saved) {
          await ctx.reply(i18n.t(locale, "error_generic"));
          return ctx.scene.leave();
        }
        await ctx.reply(
          "✅ Шаг добавлен.",
          Markup.inlineKeyboard([
            [Markup.button.callback("🔗 Добавить кнопки к письму", makeCallbackData(PREFIX, "add_buttons", saved.id))],
            [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData(PREFIX, "open", state.campaignId))],
            [Markup.button.callback(i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
            ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
          ])
        );
        return ctx.scene.leave();
      }
    }

    if (state.phase === "follow_up_text") {
      const followUpContent = extractMessageContent(ctx);
      const followUpText = extractFormattedContentText(followUpContent as import("../helpers/message-content").MessageContent & { entities?: any[] }).trim();
      if (followUpContent.mediaType || !followUpText) {
        await ctx.reply("Отправьте только текст вторым сообщением.", kb(i18n, locale, []));
        return;
      }

      const pendingContent = state.pendingContent as (import("../helpers/message-content").MessageContent & { entities?: any[] }) | undefined;
      if (!pendingContent) {
        state.phase = "content";
        await ctx.reply("Шаг 2. Отправьте текст, фото, видео, документ, голосовое или кружок для этого шага:", kb(i18n, locale, []));
        return;
      }

      const saved = await persistStep(pendingContent, followUpText);
      if (!saved) {
        await ctx.reply(i18n.t(locale, "error_generic"));
        return ctx.scene.leave();
      }

      await ctx.reply(
        "✅ Шаг добавлен.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Добавить кнопки к письму", makeCallbackData(PREFIX, "add_buttons", saved.id))],
          [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData(PREFIX, "open", state.campaignId))],
          [Markup.button.callback(i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
          ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
        ])
      );
      return ctx.scene.leave();
    }

    const content = extractMessageContent(ctx);
    const hasContent = (content.text && content.text.trim()) || content.mediaType;
    if (!hasContent) {
      await ctx.reply(i18n.t(locale, "drip_error_content"), kb(i18n, locale, []));
      return;
    }

    if (canUseFollowUpDelivery(content)) {
      state.pendingContent = content;
      state.phase = "content_mode";
      await ctx.reply(
        content.mediaType === "VIDEO_NOTE"
          ? (extractFormattedContentText(content as import("../helpers/message-content").MessageContent & { entities?: any[] }).trim()
              ? "Кружок получен. Оставить его как одно сообщение или отправить текст отдельным сообщением сразу после кружка?"
              : "Кружок получен. Оставить только кружок или добавить текст отдельным сообщением сразу после него?")
          : (extractFormattedContentText(content as import("../helpers/message-content").MessageContent & { entities?: any[] }).trim()
              ? "Контент получен. Отправить текст подписью в этом же сообщении или отдельным сообщением сразу после медиа?"
              : "Контент получен. Оставить только медиа или добавить отдельный текст сразу после него?"),
        kb(i18n, locale, [
          [{ text: "🧾 Одним сообщением", data: makeCallbackData(PREFIX, "content_mode", "single") }],
          [{ text: "➡️ Медиа, потом текст", data: makeCallbackData(PREFIX, "content_mode", "follow_up") }],
          [{ text: "✏️ Отправить другой контент", data: makeCallbackData(PREFIX, "content_mode", "replace") }]
        ])
      );
      return;
    }

    const saved = await persistStep(content as import("../helpers/message-content").MessageContent & { entities?: any[] });

    if (!saved) {
      await ctx.reply(i18n.t(locale, "error_generic"));
      return ctx.scene.leave();
    }

    await ctx.reply(
      "✅ Шаг добавлен.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔗 Добавить кнопки к письму", makeCallbackData(PREFIX, "add_buttons", saved.id))],
        [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData(PREFIX, "open", state.campaignId))],
        [Markup.button.callback(i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
        ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
      ])
    );
    return ctx.scene.leave();
  }
);
