import { Markup, Scenes } from "telegraf";

import type { BotContext } from "../context";
import { extractFormattedContentText, extractMessageContent, readTextMessage } from "../helpers/message-content";
import { buildNavigationRow, SCENE_CANCEL_DATA } from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";

export const ADD_DRIP_STEP_SCENE = "add-drip-step-scene";
const PREFIX = "dripm";

type Phase = "delay" | "delay_number" | "delay_unit" | "content";

type State = {
  campaignId: string;
  phase: Phase;
  pendingDelay?: { value: number; unit: "MINUTES" | "HOURS" | "DAYS" };
};

const kb = (i18n: BotContext["services"]["i18n"], locale: string, rows: { text: string; data: string }[][]) =>
  Markup.inlineKeyboard([
    ...rows.map((r) => r.map((c) => Markup.button.callback(c.text, c.data))),
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

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
          await ctx.reply("Шаг 2. Отправьте текст или медиа одного сообщения для этого шага:", kb(i18n, locale, []));
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
        await ctx.reply("Шаг 2. Отправьте текст или медиа одного сообщения для этого шага:", kb(i18n, locale, []));
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

    const content = extractMessageContent(ctx);
    const hasContent = (content.text && content.text.trim()) || content.mediaType;
    if (!hasContent) {
      await ctx.reply(i18n.t(locale, "drip_error_content"), kb(i18n, locale, []));
      return;
    }

    const delay = state.pendingDelay ?? { value: 0, unit: "DAYS" as const };
    const textForStorage = extractFormattedContentText(content);
    const saved = await ctx.services.drips.appendStep(ctx.currentUser!.id, state.campaignId, {
      languageCode: locale,
      delayValue: delay.value,
      delayUnit: delay.unit,
      text: textForStorage.trim() || "",
      mediaType: content.mediaType,
      mediaFileId: content.mediaFileId ?? null,
      externalUrl: content.externalUrl ?? null
    });

    if (!saved) {
      await ctx.reply(i18n.t(locale, "error_generic"));
      return ctx.scene.leave();
    }

    await ctx.reply(
      "✅ Шаг добавлен.",
      Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData(PREFIX, "open", state.campaignId))],
        [Markup.button.callback(i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
        ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
      ])
    );
    return ctx.scene.leave();
  }
);

