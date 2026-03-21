import { Scenes } from "telegraf";
import { Markup } from "telegraf";
import type { DripTriggerType } from "@prisma/client";

import { extractFormattedContentText, extractMessageContent, readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import {
  buildLanguageSceneKeyboard,
  buildNavigationRow,
  buildReturnToAdminKeyboard,
  NAV_ROOT_DATA,
  SCENE_CANCEL_DATA
} from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";
import type { DripStepInput, DripStepButton, DripSystemKind } from "../../modules/drip/drip.service";
import type { DictionaryKey } from "../../modules/i18n/static-dictionaries";

export const CREATE_DRIP_SCENE = "create-drip-scene";

const DRIP_PREFIX = "drip";
const LANG_CODES = ["ru", "en"] as const;

type DripPhase =
  | "name"
  | "trigger"
  | "trigger_param"
  | "lang"
  | "steps_action"
  | "step_buttons"
  | "step_delay"
  | "step_delay_number"
  | "step_delay_unit"
  | "step_content"
  | "summary"
  | "confirm";

interface DripWizardState {
  draft: {
    title?: string;
    triggerType?: DripTriggerType;
    triggerParam?: string;
    languageCode?: string;
    steps: DripStepInput[];
  };
  phase: DripPhase;
  pendingDelay?: { value: number; unit: "MINUTES" | "HOURS" | "DAYS" };
  stepButtons?: DripStepButton[];
  stepButtonsPendingLabel?: string;
  stepButtonsPendingSystemKind?: DripSystemKind;
}

const DRIP_SYSTEM_TARGETS: { kind: DripSystemKind; labelRu: string }[] = [
  { kind: "partner_register", labelRu: "Стать партнёром" },
  { kind: "mentor_contact", labelRu: "Связаться с наставником" },
  { kind: "main_menu", labelRu: "В главное меню" }
];

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

const TRIGGER_TYPES: { type: DripTriggerType; key: string }[] = [
  { type: "ON_REGISTRATION", key: "drip_trigger_registration" },
  { type: "ON_PAYMENT", key: "drip_trigger_payment" },
  { type: "ON_TAG_ASSIGNED", key: "drip_trigger_tag" },
  { type: "ON_EVENT", key: "drip_trigger_event" }
];

function getTriggerLabel(locale: string, i18n: BotContext["services"]["i18n"], type: DripTriggerType): string {
  const entry = TRIGGER_TYPES.find((t) => t.type === type);
  return entry ? i18n.t(locale, entry.key as DictionaryKey) : type;
}

function formatDelayForSummary(
  locale: string,
  i18n: BotContext["services"]["i18n"],
  value: number,
  unit: "MINUTES" | "HOURS" | "DAYS"
): string {
  if (value === 0 && unit === "DAYS") return i18n.t(locale, "drip_summary_delay_now");
  const unitKey = unit === "MINUTES" ? "drip_unit_minutes" : unit === "HOURS" ? "drip_unit_hours" : "drip_unit_days";
  const template = i18n.t(locale, "drip_summary_delay");
  const unitLabel = i18n.t(locale, unitKey as DictionaryKey);
  return template.replace(/\{\{value\}\}/g, String(value)).replace(/\{\{unit\}\}/g, unitLabel);
}

function textPreview(text: string | undefined, maxLen: number = 40): string {
  if (!text || !text.trim()) return "—";
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= maxLen ? t : t.slice(0, maxLen) + "…";
}

/** Replace {{key}} in template with values from params (for non-personalization interpolation). */
function interpolate(template: string, params: Record<string, string>): string {
  let s = template;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
  }
  return s;
}

/** One button per row (vertical). */
function dripKeyboard(
  i18n: BotContext["services"]["i18n"],
  locale: string,
  rows: (string | { text: string; data: string })[][]
) {
  const built = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell === "string") {
        return Markup.button.callback(cell, cell);
      }
      return Markup.button.callback(cell.text, cell.data);
    })
  );
  built.push([Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)]);
  for (const btn of buildNavigationRow(i18n, locale, { toMain: true })) {
    built.push([btn]);
  }
  return Markup.inlineKeyboard(built);
}

export const createDripScene = new Scenes.WizardScene<any>(CREATE_DRIP_SCENE, async (ctx) => {
  const state = (ctx.wizard.state as DripWizardState) || {};
  state.draft = { steps: [] };
  state.phase = "name";
  state.pendingDelay = undefined;
  ctx.wizard.state = state;

  const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
  await ctx.reply(
    ctx.services.i18n.t(locale, "drip_wizard_step_name"),
    dripKeyboard(ctx.services.i18n, locale, [])
  );
  return ctx.wizard.next();
}, async (ctx) => {
  const state = ctx.wizard.state as DripWizardState;
  if (!state?.draft) return;
  const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
  const i18n = ctx.services.i18n;

  if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
    const data = ctx.callbackQuery.data;
    if (data === SCENE_CANCEL_DATA) {
      await ctx.answerCbQuery();
      await ctx.reply(i18n.t(locale, "action_cancelled"), buildReturnToAdminKeyboard(i18n, locale));
      return ctx.scene.leave();
    }
    if (data === "nav:root") {
      await ctx.answerCbQuery();
      await ctx.reply(i18n.t(locale, "to_main_menu"), buildReturnToAdminKeyboard(i18n, locale));
      return ctx.scene.leave();
    }
    const parts = data.split(":");
    const prefix = parts[0];

    if (state.phase === "trigger" && prefix === DRIP_PREFIX && parts[1] === "trigger") {
      const type = parts[2] as DripTriggerType;
      if (["ON_REGISTRATION", "ON_PAYMENT", "ON_TAG_ASSIGNED", "ON_EVENT"].includes(type)) {
        await ctx.answerCbQuery();
        state.draft.triggerType = type;
        if (type === "ON_TAG_ASSIGNED" || type === "ON_EVENT") {
          state.phase = "trigger_param";
          const key = type === "ON_TAG_ASSIGNED" ? "drip_wizard_step_trigger_tag" : "drip_wizard_step_trigger_event";
          await ctx.reply(i18n.t(locale, key), dripKeyboard(i18n, locale, []));
        } else {
          state.phase = "lang";
          await ctx.reply(i18n.t(locale, "drip_wizard_step_language"), buildLanguageSceneKeyboard(i18n, locale, DRIP_PREFIX));
        }
      }
      return;
    }

    if (state.phase === "lang" && prefix === DRIP_PREFIX && parts[1] === "lang" && LANG_CODES.includes(parts[2] as typeof LANG_CODES[number])) {
      await ctx.answerCbQuery();
      state.draft.languageCode = parts[2];
      state.phase = "steps_action";
      const msg = state.draft.steps.length === 0 ? i18n.t(locale, "drip_no_steps_yet") : interpolate(i18n.t(locale, "drip_wizard_after_steps"), { count: String(state.draft.steps.length) });
      const rows: { text: string; data: string }[][] = [
        [{ text: state.draft.steps.length === 0 ? i18n.t(locale, "drip_btn_add_first_step") : i18n.t(locale, "drip_btn_add_more"), data: makeCallbackData(DRIP_PREFIX, "add_step") }],
        ...(state.draft.steps.length > 0
          ? [[{ text: "🔗 Кнопки к последнему шагу", data: makeCallbackData(DRIP_PREFIX, "add_buttons") }] as { text: string; data: string }[]]
          : []),
        [{ text: i18n.t(locale, "drip_btn_finish"), data: makeCallbackData(DRIP_PREFIX, "finish") }]
      ];
      await ctx.reply(msg, dripKeyboard(i18n, locale, rows));
      return;
    }

    if (state.phase === "steps_action" && prefix === DRIP_PREFIX) {
      if (parts[1] === "add_step") {
        await ctx.answerCbQuery();
        state.phase = "step_delay";
        const n = state.draft.steps.length + 1;
        const rows = [
          [{ text: i18n.t(locale, "drip_delay_now"), data: makeCallbackData(DRIP_PREFIX, "delay", "0", "DAYS") }],
          [{ text: i18n.t(locale, "drip_delay_1d"), data: makeCallbackData(DRIP_PREFIX, "delay", "1", "DAYS") }],
          [{ text: i18n.t(locale, "drip_delay_2d"), data: makeCallbackData(DRIP_PREFIX, "delay", "2", "DAYS") }],
          [{ text: i18n.t(locale, "drip_delay_3d"), data: makeCallbackData(DRIP_PREFIX, "delay", "3", "DAYS") }],
          [{ text: i18n.t(locale, "drip_delay_7d"), data: makeCallbackData(DRIP_PREFIX, "delay", "7", "DAYS") }],
          [{ text: i18n.t(locale, "drip_delay_other"), data: makeCallbackData(DRIP_PREFIX, "delay_other") }]
        ];
        await ctx.reply(interpolate(i18n.t(locale, "drip_wizard_step_delay"), { n: String(n) }), dripKeyboard(i18n, locale, rows));
      } else if (parts[1] === "finish") {
        await ctx.answerCbQuery();
        if (state.draft.steps.length === 0) {
          await ctx.reply(i18n.t(locale, "drip_wizard_min_one_step"), dripKeyboard(i18n, locale, [[{ text: i18n.t(locale, "drip_btn_add_first_step"), data: makeCallbackData(DRIP_PREFIX, "add_step") }]]));
          return;
        }
        state.phase = "summary";
const stepsText = state.draft.steps.map((s, i) => interpolate(i18n.t(locale, "drip_summary_step"), { n: String(i + 1), delay: formatDelayForSummary(locale, i18n, s.delayValue, s.delayUnit), preview: textPreview(s.text) })).join("\n");
        const summary = interpolate(i18n.t(locale, "drip_wizard_summary"), { title: state.draft.title ?? "", trigger: getTriggerLabel(locale, i18n, state.draft.triggerType ?? "ON_REGISTRATION"), lang: state.draft.languageCode ?? "ru", count: String(state.draft.steps.length), steps: stepsText }).replace(/\[b\]/g, "<b>").replace(/\[\/b\]/g, "</b>");
        await ctx.reply(summary, { parse_mode: "HTML" });
        await ctx.reply(i18n.t(locale, "drip_confirm_save"), dripKeyboard(i18n, locale, [
          [{ text: i18n.t(locale, "drip_btn_save"), data: makeCallbackData(DRIP_PREFIX, "confirm_save") }],
          [{ text: i18n.t(locale, "drip_btn_edit_campaign"), data: makeCallbackData(DRIP_PREFIX, "confirm_edit") }]
        ]));
      } else if (parts[1] === "edit_last") {
        await ctx.answerCbQuery();
        if (state.draft.steps.length > 0) {
          state.draft.steps.pop();
          state.phase = "step_delay";
          const n = state.draft.steps.length + 1;
          const rows = [
            [{ text: i18n.t(locale, "drip_delay_now"), data: makeCallbackData(DRIP_PREFIX, "delay", "0", "DAYS") }],
            [{ text: i18n.t(locale, "drip_delay_1d"), data: makeCallbackData(DRIP_PREFIX, "delay", "1", "DAYS") }],
            [{ text: i18n.t(locale, "drip_delay_2d"), data: makeCallbackData(DRIP_PREFIX, "delay", "2", "DAYS") }],
            [{ text: i18n.t(locale, "drip_delay_3d"), data: makeCallbackData(DRIP_PREFIX, "delay", "3", "DAYS") }],
            [{ text: i18n.t(locale, "drip_delay_7d"), data: makeCallbackData(DRIP_PREFIX, "delay", "7", "DAYS") }],
            [{ text: i18n.t(locale, "drip_delay_other"), data: makeCallbackData(DRIP_PREFIX, "delay_other") }]
          ];
          await ctx.reply(interpolate(i18n.t(locale, "drip_wizard_step_delay"), { n: String(n) }), dripKeyboard(i18n, locale, rows));
        }
      } else if (parts[1] === "delete_last") {
        await ctx.answerCbQuery();
        if (state.draft.steps.length > 0) state.draft.steps.pop();
        const msg = state.draft.steps.length === 0 ? i18n.t(locale, "drip_no_steps_yet") : interpolate(i18n.t(locale, "drip_wizard_after_steps"), { count: String(state.draft.steps.length) });
        const rows: { text: string; data: string }[][] = [
          [{ text: state.draft.steps.length === 0 ? i18n.t(locale, "drip_btn_add_first_step") : i18n.t(locale, "drip_btn_add_more"), data: makeCallbackData(DRIP_PREFIX, "add_step") }],
          ...(state.draft.steps.length > 0 ? [[{ text: "🔗 Кнопки к последнему шагу", data: makeCallbackData(DRIP_PREFIX, "add_buttons") }] as { text: string; data: string }[]] : []),
          [{ text: i18n.t(locale, "drip_btn_finish"), data: makeCallbackData(DRIP_PREFIX, "finish") }]
        ];
        await ctx.reply(msg, dripKeyboard(i18n, locale, rows));
      } else if (parts[1] === "add_buttons" && state.draft.steps.length > 0) {
        await ctx.answerCbQuery();
        const lastStep = state.draft.steps[state.draft.steps.length - 1]!;
        state.stepButtons = lastStep.buttons ? [...lastStep.buttons] : [];
        state.stepButtonsPendingLabel = undefined;
        state.phase = "step_buttons";
        await ctx.reply(
          "🔗 Кнопки к письму. Добавьте URL-кнопки (например: Стать партнёром | https://...)\n\nТекущие: " +
            (state.stepButtons.length === 0 ? "—" : state.stepButtons.map((b, i) => `${i + 1}. ${b.label}`).join(", ")),
          dripKeyboard(i18n, locale, [
            [{ text: "➕ Добавить кнопку", data: makeCallbackData(DRIP_PREFIX, "btn_add") }],
            [{ text: "✅ Готово", data: makeCallbackData(DRIP_PREFIX, "btn_done") }],
            ...(state.stepButtons.length > 0 ? [[{ text: "🗑 Удалить последнюю", data: makeCallbackData(DRIP_PREFIX, "btn_remove") }] as { text: string; data: string }[]] : [])
          ])
        );
      }
      return;
    }

    if (state.phase === "step_buttons" && prefix === DRIP_PREFIX) {
      if (parts[1] === "btn_add") {
        await ctx.answerCbQuery();
        state.stepButtonsPendingLabel = undefined;
        state.stepButtonsPendingSystemKind = undefined;
        await ctx.reply(
          "Выберите куда ведёт кнопка (системные — каждый пользователь попадёт к своему партнёру/наставнику):",
          dripKeyboard(i18n, locale, [
            ...DRIP_SYSTEM_TARGETS.map((t) => [{ text: `🔗 ${t.labelRu}`, data: makeCallbackData(DRIP_PREFIX, "btn_sys", t.kind) }]),
            [{ text: "📎 Своя ссылка (URL)", data: makeCallbackData(DRIP_PREFIX, "btn_url") }]
          ])
        );
        return;
      }
      if (parts[1] === "btn_sys" && parts[2] && ["partner_register", "mentor_contact", "main_menu"].includes(parts[2])) {
        await ctx.answerCbQuery();
        state.stepButtonsPendingSystemKind = parts[2] as DripSystemKind;
        const defLabel = DRIP_SYSTEM_TARGETS.find((t) => t.kind === parts[2])?.labelRu ?? parts[2];
        await ctx.reply(
          `Введите текст кнопки или «.» для «${defLabel}»:`,
          dripKeyboard(i18n, locale, [])
        );
        return;
      }
      if (parts[1] === "btn_url") {
        await ctx.answerCbQuery();
        await ctx.reply("Введите текст кнопки и URL через | (например: Стать партнёром | https://example.com):", dripKeyboard(i18n, locale, []));
        return;
      }
      if (parts[1] === "btn_remove" && state.stepButtons && state.stepButtons.length > 0) {
        await ctx.answerCbQuery();
        state.stepButtons.pop();
        const formatBtn = (b: DripStepButton, i: number) => (b.type === "system" ? `${b.label} [${b.systemKind}]` : b.label);
        await ctx.reply(
          "Текущие кнопки: " + (state.stepButtons!.length === 0 ? "—" : state.stepButtons!.map((b, i) => `${i + 1}. ${formatBtn(b, i)}`).join(", ")),
          dripKeyboard(i18n, locale, [
            [{ text: "➕ Добавить кнопку", data: makeCallbackData(DRIP_PREFIX, "btn_add") }],
            [{ text: "✅ Готово", data: makeCallbackData(DRIP_PREFIX, "btn_done") }],
            ...(state.stepButtons!.length > 0 ? [[{ text: "🗑 Удалить последнюю", data: makeCallbackData(DRIP_PREFIX, "btn_remove") }] as { text: string; data: string }[]] : [])
          ])
        );
        return;
      }
      if (parts[1] === "btn_done") {
        await ctx.answerCbQuery();
        const lastStep = state.draft.steps[state.draft.steps.length - 1];
        if (lastStep != null) lastStep.buttons = state.stepButtons ?? [];
        state.stepButtons = undefined;
        state.phase = "steps_action";
        const msg = interpolate(i18n.t(locale, "drip_wizard_after_steps"), { count: String(state.draft.steps.length) });
        const rows: { text: string; data: string }[][] = [
          [{ text: i18n.t(locale, "drip_btn_add_more"), data: makeCallbackData(DRIP_PREFIX, "add_step") }],
          [{ text: "🔗 Кнопки к последнему шагу", data: makeCallbackData(DRIP_PREFIX, "add_buttons") }],
          [{ text: i18n.t(locale, "drip_btn_edit_last"), data: makeCallbackData(DRIP_PREFIX, "edit_last") }],
          [{ text: i18n.t(locale, "drip_btn_delete_last"), data: makeCallbackData(DRIP_PREFIX, "delete_last") }],
          [{ text: i18n.t(locale, "drip_btn_finish"), data: makeCallbackData(DRIP_PREFIX, "finish") }]
        ];
        await ctx.reply(msg, dripKeyboard(i18n, locale, rows));
        return;
      }
      return;
    }

    if (state.phase === "step_delay" && prefix === DRIP_PREFIX) {
      if (parts[1] === "delay" && parts[2] !== undefined && parts[3] !== undefined) {
        await ctx.answerCbQuery();
        const value = parseInt(parts[2], 10); const unit = parts[3] as "MINUTES" | "HOURS" | "DAYS";
        if ([0, 1, 2, 3, 7].includes(value) && ["MINUTES", "HOURS", "DAYS"].includes(unit)) { state.pendingDelay = { value, unit }; state.phase = "step_content"; await ctx.reply(i18n.t(locale, "drip_wizard_step_content"), dripKeyboard(i18n, locale, [])); }
      } else if (parts[1] === "delay_other") {
        await ctx.answerCbQuery();
        state.phase = "step_delay_number";
        await ctx.reply(i18n.t(locale, "drip_wizard_step_custom_value"), dripKeyboard(i18n, locale, []));
      }
      return;
    }

    if (state.phase === "step_delay_unit" && prefix === DRIP_PREFIX && parts[1] === "delay_unit") {
      const unit = parts[2] as "MINUTES" | "HOURS" | "DAYS";
      if (["MINUTES", "HOURS", "DAYS"].includes(unit) && state.pendingDelay) {
        await ctx.answerCbQuery();
        state.pendingDelay.unit = unit;
        state.phase = "step_content";
        await ctx.reply(i18n.t(locale, "drip_wizard_step_content"), dripKeyboard(i18n, locale, []));
      }
      return;
    }

    if (state.phase === "summary" && prefix === DRIP_PREFIX) {
      if (parts[1] === "confirm_save") {
        await ctx.answerCbQuery();
        try {
          const campaign = await ctx.services.drips.createCampaign({ actorUserId: ctx.currentUser!.id, title: state.draft.title ?? "New drip", triggerType: state.draft.triggerType ?? "ON_REGISTRATION", steps: state.draft.steps });
          await ctx.reply(ctx.services.i18n.t(locale, "drip_created") + ` (${campaign.id})`, buildReturnToAdminKeyboard(i18n, locale));
        } catch (e) {
          await ctx.reply(i18n.t(locale, "error_generic"), buildReturnToAdminKeyboard(i18n, locale));
        }
        state.draft = undefined!;
        return ctx.scene.leave();
      }
      if (parts[1] === "confirm_edit") {
        await ctx.answerCbQuery();
        state.phase = "steps_action";
        const msg = interpolate(i18n.t(locale, "drip_wizard_after_steps"), { count: String(state.draft.steps.length) });
        const rows: { text: string; data: string }[][] = [
          [{ text: i18n.t(locale, "drip_btn_add_more"), data: makeCallbackData(DRIP_PREFIX, "add_step") }],
          [{ text: "🔗 Кнопки к последнему шагу", data: makeCallbackData(DRIP_PREFIX, "add_buttons") }],
          [{ text: i18n.t(locale, "drip_btn_edit_last"), data: makeCallbackData(DRIP_PREFIX, "edit_last") }],
          [{ text: i18n.t(locale, "drip_btn_delete_last"), data: makeCallbackData(DRIP_PREFIX, "delete_last") }],
          [{ text: i18n.t(locale, "drip_btn_finish"), data: makeCallbackData(DRIP_PREFIX, "finish") }]
        ];
        await ctx.reply(msg, dripKeyboard(i18n, locale, rows));
      }
      return;
    }
    return;
  }

  if (ctx.message) {
    if (state.phase === "name") {
      const title = readTextMessage(ctx).trim();
      if (!title) {
        await ctx.reply(i18n.t(locale, "drip_error_title_empty"), dripKeyboard(i18n, locale, []));
        return;
      }
      if (title.length > 64) {
        await ctx.reply(i18n.t(locale, "error_title_too_long"), dripKeyboard(i18n, locale, []));
        return;
      }
      state.draft.title = title;
      state.phase = "trigger";
      const rows = TRIGGER_TYPES.map((t) => [{ text: i18n.t(locale, t.key), data: makeCallbackData(DRIP_PREFIX, "trigger", t.type) }]);
      await ctx.reply(i18n.t(locale, "drip_wizard_step_trigger"), dripKeyboard(i18n, locale, rows));
      return;
    }

    if (state.phase === "trigger_param") {
      const param = readTextMessage(ctx).trim();
      state.draft.triggerParam = param || undefined;
      state.phase = "lang";
      await ctx.reply(i18n.t(locale, "drip_wizard_step_language"), buildLanguageSceneKeyboard(i18n, locale, DRIP_PREFIX));
      return;
    }

    if (state.phase === "step_buttons") {
      const text = readTextMessage(ctx).trim();
      if (!state.stepButtons) state.stepButtons = [];
      if (state.stepButtonsPendingSystemKind) {
        const defLabel = DRIP_SYSTEM_TARGETS.find((t) => t.kind === state.stepButtonsPendingSystemKind)?.labelRu ?? state.stepButtonsPendingSystemKind;
        const label = text === "." || !text ? defLabel : (text.length > 64 ? text.slice(0, 64) : text);
        state.stepButtons.push({ type: "system", label, systemKind: state.stepButtonsPendingSystemKind });
        state.stepButtonsPendingSystemKind = undefined;
      } else if (state.stepButtonsPendingLabel) {
        if (!isValidUrl(text)) {
          await ctx.reply("Введите корректный URL (http:// или https://).", dripKeyboard(i18n, locale, []));
          return;
        }
        state.stepButtons.push({ type: "url", label: state.stepButtonsPendingLabel, url: text });
        state.stepButtonsPendingLabel = undefined;
      } else {
        const sep = text.indexOf("|");
        if (sep >= 0) {
          const label = text.slice(0, sep).trim();
          const urlPart = text.slice(sep + 1).trim();
          if (label && urlPart && isValidUrl(urlPart)) {
            state.stepButtons.push({ type: "url", label, url: urlPart });
          } else {
            await ctx.reply("Формат: Текст кнопки | URL (например: Стать партнёром | https://example.com)", dripKeyboard(i18n, locale, []));
            return;
          }
        } else {
          if (!text || text.length > 64) {
            await ctx.reply("Текст кнопки: 1–64 символа.", dripKeyboard(i18n, locale, []));
            return;
          }
          state.stepButtonsPendingLabel = text;
          await ctx.reply("Теперь введите URL ссылки:", dripKeyboard(i18n, locale, []));
          return;
        }
      }
      const formatBtn = (b: DripStepButton, i: number) => {
        const label = b.type === "system" ? `${b.label} [${b.systemKind}]` : b.label;
        return `${i + 1}. ${label}`;
      };
      await ctx.reply(
        "✅ Кнопка добавлена. Текущие: " + (state.stepButtons.length === 0 ? "—" : state.stepButtons.map(formatBtn).join(", ")),
        dripKeyboard(i18n, locale, [
          [{ text: "➕ Добавить кнопку", data: makeCallbackData(DRIP_PREFIX, "btn_add") }],
          [{ text: "✅ Готово", data: makeCallbackData(DRIP_PREFIX, "btn_done") }],
          ...(state.stepButtons.length > 0 ? [[{ text: "🗑 Удалить последнюю", data: makeCallbackData(DRIP_PREFIX, "btn_remove") }] as { text: string; data: string }[]] : [])
        ])
      );
      return;
    }

    if (state.phase === "step_delay_number") {
      const raw = readTextMessage(ctx).trim();
      const num = parseInt(raw, 10);
      if (Number.isNaN(num) || num < 1 || num > 999) {
        await ctx.reply(i18n.t(locale, "drip_error_delay_number"), dripKeyboard(i18n, locale, []));
        return;
      }
      state.pendingDelay = { value: num, unit: "DAYS" };
      state.phase = "step_delay_unit";
      const rows = [
        [{ text: i18n.t(locale, "drip_unit_minutes"), data: makeCallbackData(DRIP_PREFIX, "delay_unit", "MINUTES") }],
        [{ text: i18n.t(locale, "drip_unit_hours"), data: makeCallbackData(DRIP_PREFIX, "delay_unit", "HOURS") }],
        [{ text: i18n.t(locale, "drip_unit_days"), data: makeCallbackData(DRIP_PREFIX, "delay_unit", "DAYS") }]
      ];
      await ctx.reply(i18n.t(locale, "drip_wizard_step_custom_unit"), dripKeyboard(i18n, locale, rows));
      return;
    }

    if (state.phase === "step_content") {
      const content = extractMessageContent(ctx);
      const hasContent = (content.text && content.text.trim()) || content.mediaType;
      if (!hasContent) {
        await ctx.reply(i18n.t(locale, "drip_error_content"), dripKeyboard(i18n, locale, []));
        return;
      }
      const delay = state.pendingDelay ?? { value: 0, unit: "DAYS" as const };
      const textForStorage = extractFormattedContentText(content);
      const step: DripStepInput = {
        languageCode: state.draft.languageCode ?? "ru",
        delayValue: delay.value,
        delayUnit: delay.unit,
        text: textForStorage.trim() || "",
        mediaType: content.mediaType,
        mediaFileId: content.mediaFileId ?? null,
        externalUrl: content.externalUrl ?? null
      };
      state.draft.steps.push(step);
      state.pendingDelay = undefined;
      state.phase = "steps_action";

      const delayStr = formatDelayForSummary(locale, i18n, step.delayValue, step.delayUnit);
      const savedTemplate = i18n.t(locale, "drip_wizard_step_saved");
      const savedText = savedTemplate
        .replace(/\{\{n\}\}/g, String(state.draft.steps.length))
        .replace(/\{\{delay\}\}/g, delayStr);
      await ctx.reply(savedText, dripKeyboard(i18n, locale, []));

      const rows: { text: string; data: string }[][] = [
        [{ text: i18n.t(locale, "drip_btn_add_more"), data: makeCallbackData(DRIP_PREFIX, "add_step") }],
        [{ text: "🔗 Кнопки к последнему шагу", data: makeCallbackData(DRIP_PREFIX, "add_buttons") }],
        [{ text: i18n.t(locale, "drip_btn_edit_last"), data: makeCallbackData(DRIP_PREFIX, "edit_last") }],
        [{ text: i18n.t(locale, "drip_btn_delete_last"), data: makeCallbackData(DRIP_PREFIX, "delete_last") }],
        [{ text: i18n.t(locale, "drip_btn_finish"), data: makeCallbackData(DRIP_PREFIX, "finish") }]
      ];
      await ctx.reply(
        interpolate(i18n.t(locale, "drip_wizard_after_steps"), { count: String(state.draft.steps.length) }),
        dripKeyboard(i18n, locale, rows)
      );
    }
  }
});
