import { Markup, Scenes } from "telegraf";

import type { BotContext } from "../context";
import { buildNavigationRow, SCENE_CANCEL_DATA } from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";
import type { DripStepButton } from "../../modules/drip/drip.service";

export const ADD_DRIP_STEP_BUTTONS_SCENE = "add-drip-step-buttons-scene";
const PREFIX = "drip_btns";

type Phase = "menu" | "add_label" | "add_url";

type State = {
  stepId: string;
  campaignId: string;
  languageCode: string;
  buttons: DripStepButton[];
  phase: Phase;
  pendingLabel?: string;
};

function isValidUrl(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
  try {
    const u = new URL(t);
    return Boolean(u.hostname);
  } catch {
    return false;
  }
}

const kb = (i18n: BotContext["services"]["i18n"], locale: string, rows: { text: string; data: string }[][]) =>
  Markup.inlineKeyboard([
    ...rows.map((r) => r.map((c) => Markup.button.callback(c.text, c.data))),
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

function formatButtonsList(buttons: DripStepButton[]): string {
  if (buttons.length === 0) return "—";
  return buttons.map((b, i) => `${i + 1}. ${b.label} → ${b.url}`).join("\n");
}

export const addDripStepButtonsScene = new Scenes.WizardScene<any>(
  ADD_DRIP_STEP_BUTTONS_SCENE,
  async (ctx) => {
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const sceneState = ctx.scene.state as { stepId?: string; campaignId?: string; languageCode?: string };
    const { stepId, campaignId, languageCode } = sceneState;
    if (!stepId || !campaignId) {
      await ctx.reply(ctx.services.i18n.t(locale, "error_generic"));
      return ctx.scene.leave();
    }
    const step = await ctx.services.drips.getStepWithCampaign(ctx.currentUser!.id, stepId);
    if (!step) {
      await ctx.reply("Шаг не найден.");
      return ctx.scene.leave();
    }
    const loc = step.localizations.find((l: { languageCode: string }) => l.languageCode === (languageCode ?? locale)) ?? step.localizations[0];
    const buttons: DripStepButton[] = Array.isArray(loc?.buttonsJson)
      ? (loc.buttonsJson as DripStepButton[])
      : [];
    const state: State = {
      stepId,
      campaignId,
      languageCode: languageCode ?? loc?.languageCode ?? locale,
      buttons,
      phase: "menu"
    };
    ctx.wizard.state = state;
    await showButtonsMenu(ctx, state);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const state = ctx.wizard.state as State;
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const i18n = ctx.services.i18n;

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === SCENE_CANCEL_DATA) {
        await ctx.answerCbQuery();
        await ctx.reply(i18n.t(locale, "action_cancelled"), Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData("dripm", "open", state.campaignId))],
          ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
        ]));
        return ctx.scene.leave();
      }
      const parts = data.split(":");
      if (parts[0] === PREFIX) {
        await ctx.answerCbQuery();
        if (parts[1] === "add") {
          state.phase = "add_label";
          await ctx.reply(
            "Введите текст кнопки (например: Стать партнёром):",
            kb(i18n, locale, [])
          );
          return;
        }
        if (parts[1] === "remove" && state.buttons.length > 0) {
          state.buttons.pop();
          await showButtonsMenu(ctx, state);
          return;
        }
        if (parts[1] === "done") {
          const ok = await ctx.services.drips.updateStepButtons(
            ctx.currentUser!.id,
            state.stepId,
            state.languageCode,
            state.buttons
          );
          if (ok == null) {
            await ctx.reply(i18n.t(locale, "error_generic"));
            return ctx.scene.leave();
          }
          await ctx.reply(
            state.buttons.length > 0
              ? `✅ Сохранено ${state.buttons.length} кнопок.`
              : "✅ Кнопки обновлены (список пуст).",
            Markup.inlineKeyboard([
              [Markup.button.callback("↩️ Назад к цепочке", makeCallbackData("dripm", "open", state.campaignId))],
              [Markup.button.callback(i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
              ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
            ])
          );
          return ctx.scene.leave();
        }
      }
    }

    if (ctx.message && "text" in ctx.message) {
      const text = ctx.message.text?.trim() ?? "";
      if (state.phase === "add_label") {
        if (!text || text.length > 64) {
          await ctx.reply("Текст кнопки: от 1 до 64 символов.");
          return;
        }
        const sep = text.indexOf("|");
        if (sep >= 0) {
          const label = text.slice(0, sep).trim();
          const urlPart = text.slice(sep + 1).trim();
          if (label && urlPart && isValidUrl(urlPart)) {
            state.buttons.push({ type: "url", label, url: urlPart });
            state.phase = "menu";
            await ctx.reply("✅ Кнопка добавлена.", kb(i18n, locale, []));
            await showButtonsMenu(ctx, state);
            return;
          }
        }
        state.pendingLabel = text;
        state.phase = "add_url";
        await ctx.reply("Теперь введите URL ссылки (начинается с https://):", kb(i18n, locale, []));
        return;
      }
      if (state.phase === "add_url" && state.pendingLabel) {
        if (!isValidUrl(text)) {
          await ctx.reply("Введите корректный URL (http:// или https://).");
          return;
        }
        state.buttons.push({ type: "url", label: state.pendingLabel, url: text.trim() });
        state.pendingLabel = undefined;
        state.phase = "menu";
        await ctx.reply("✅ Кнопка добавлена.", kb(i18n, locale, []));
        await showButtonsMenu(ctx, state);
        return;
      }
    }

    await showButtonsMenu(ctx, state);
  }
);

async function showButtonsMenu(ctx: BotContext, state: State) {
  const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
  const i18n = ctx.services.i18n;
  const list = formatButtonsList(state.buttons);
  const msg = [
    "🔗 Кнопки к письму",
    "",
    "Добавленные кнопки появятся под сообщением, когда пользователь получит письмо.",
    "",
    "Текущие кнопки:",
    list,
    "",
    "Можно ввести «Текст | URL» одной строкой (например: Стать партнёром | https://example.com)"
  ].join("\n");

  const rows: { text: string; data: string }[][] = [
    [{ text: "➕ Добавить кнопку", data: makeCallbackData(PREFIX, "add") }],
    [{ text: "✅ Готово", data: makeCallbackData(PREFIX, "done") }]
  ];
  if (state.buttons.length > 0) {
    rows.push([{ text: "🗑 Удалить последнюю", data: makeCallbackData(PREFIX, "remove") }]);
  }
  await ctx.reply(msg, kb(i18n, locale, rows));
}
