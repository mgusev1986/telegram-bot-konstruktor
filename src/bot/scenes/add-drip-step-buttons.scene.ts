import { Markup, Scenes } from "telegraf";

import type { BotContext } from "../context";
import { buildNavigationRow, SCENE_CANCEL_DATA } from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";
import type { DripStepButton, DripSystemKind } from "../../modules/drip/drip.service";

export const ADD_DRIP_STEP_BUTTONS_SCENE = "add-drip-step-buttons-scene";
const PREFIX = "drip_btns";

type Phase = "menu" | "choose_type" | "choose_section" | "add_label" | "add_url" | "add_system_label" | "add_section_label";

const SYSTEM_TARGETS: { kind: DripSystemKind; labelRu: string }[] = [
  { kind: "partner_register", labelRu: "Зарегистрироваться / Стать партнёром" },
  { kind: "mentor_contact", labelRu: "Связаться с наставником" },
  { kind: "main_menu", labelRu: "В главное меню" }
];

type State = {
  stepId: string;
  campaignId: string;
  languageCode: string;
  buttons: DripStepButton[];
  phase: Phase;
  pendingLabel?: string;
  pendingSystemKind?: DripSystemKind;
  pendingTargetMenuItemId?: string;
  pendingSectionTitle?: string;
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

function formatButtonDest(b: DripStepButton): string {
  if (b.type === "url") return b.url;
  if (b.type === "system") {
    const t = SYSTEM_TARGETS.find((x) => x.kind === b.systemKind);
    return t ? `[${t.labelRu}]` : `[${b.systemKind}]`;
  }
  if (b.type === "section") return "[Раздел]";
  return "?";
}

function formatButtonsList(buttons: DripStepButton[]): string {
  if (buttons.length === 0) return "—";
  return buttons.map((b, i) => `${i + 1}. ${b.label} → ${formatButtonDest(b)}`).join("\n");
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
    if (state.buttons.length === 0) {
      state.phase = "choose_type";
      await ctx.reply(
        "Выберите куда ведёт кнопка (системные кнопки сохраняют сетевую логику — каждый пользователь попадает к своему партнёру/наставнику):",
        kb(ctx.services.i18n, locale, [
          ...SYSTEM_TARGETS.map((t) => [{ text: `🔗 ${t.labelRu}`, data: makeCallbackData(PREFIX, "sys", t.kind) }]),
          [{ text: "📂 Переход в раздел", data: makeCallbackData(PREFIX, "section") }],
          [{ text: "📎 Своя ссылка (URL)", data: makeCallbackData(PREFIX, "url") }]
        ])
      );
    } else {
      await showButtonsMenu(ctx, state);
    }
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
          state.phase = "choose_type";
          await ctx.reply(
            "Выберите куда ведёт кнопка (системные кнопки сохраняют сетевую логику — каждый пользователь попадает к своему партнёру/наставнику):",
            kb(i18n, locale, [
              ...SYSTEM_TARGETS.map((t) => [{ text: `🔗 ${t.labelRu}`, data: makeCallbackData(PREFIX, "sys", t.kind) }]),
              [{ text: "📂 Переход в раздел", data: makeCallbackData(PREFIX, "section") }],
              [{ text: "📎 Своя ссылка (URL)", data: makeCallbackData(PREFIX, "url") }]
            ])
          );
          return;
        }
        if (parts[1] === "sys" && parts[2] && ["partner_register", "mentor_contact", "main_menu"].includes(parts[2])) {
          state.pendingSystemKind = parts[2] as DripSystemKind;
          state.phase = "add_system_label";
          const defLabel = SYSTEM_TARGETS.find((t) => t.kind === parts[2])?.labelRu ?? parts[2];
          await ctx.reply(
            `Введите текст кнопки (или отправьте «.» чтобы использовать «${defLabel}»):`,
            kb(i18n, locale, [])
          );
          return;
        }
        if (parts[1] === "section") {
          const sections = await ctx.services.menu.getContentSectionsForPicker(state.languageCode);
          if (sections.length === 0) {
            await ctx.reply("Нет доступных разделов. Сначала создайте разделы в меню.", kb(i18n, locale, []));
            state.phase = "menu";
            await showButtonsMenu(ctx, state);
            return;
          }
          state.phase = "choose_section";
          const rows = sections.map((s: { id: string; title: string }) => [{ text: `📂 ${s.title}`, data: makeCallbackData(PREFIX, "sec_pick", s.id) }]);
          await ctx.reply("Выберите раздел, в который ведёт кнопка:", kb(i18n, locale, rows));
          return;
        }
        if (parts[1] === "sec_pick" && parts[2]) {
          const sections = await ctx.services.menu.getContentSectionsForPicker(state.languageCode);
          const sec = sections.find((s: { id: string; title: string }) => s.id === parts[2]);
          if (!sec) return;
          state.pendingTargetMenuItemId = sec.id;
          state.pendingSectionTitle = sec.title;
          state.phase = "add_section_label";
          await ctx.reply(
            `Введите текст кнопки (или отправьте «.» чтобы использовать «${sec.title}»):`,
            kb(i18n, locale, [])
          );
          return;
        }
        if (parts[1] === "url") {
          state.phase = "add_label";
          await ctx.reply(
            "Введите текст кнопки и URL через | (например: Стать партнёром | https://example.com):",
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
      if (state.phase === "add_system_label" && state.pendingSystemKind) {
        const defLabel = SYSTEM_TARGETS.find((t) => t.kind === state.pendingSystemKind)?.labelRu ?? state.pendingSystemKind;
        const label = text === "." || !text ? defLabel : text;
        if (label.length > 64) {
          await ctx.reply("Текст кнопки: до 64 символов.");
          return;
        }
        state.buttons.push({ type: "system", label, systemKind: state.pendingSystemKind });
        state.pendingSystemKind = undefined;
        state.phase = "menu";
        await ctx.reply("✅ Системная кнопка добавлена.", kb(i18n, locale, []));
        await showButtonsMenu(ctx, state);
        return;
      }
      if (state.phase === "add_section_label" && state.pendingTargetMenuItemId) {
        const defLabel = state.pendingSectionTitle ?? "Раздел";
        const label = text === "." || !text ? defLabel : text;
        if (label.length > 64) {
          await ctx.reply("Текст кнопки: до 64 символов.");
          return;
        }
        state.buttons.push({ type: "section", label, targetMenuItemId: state.pendingTargetMenuItemId });
        state.pendingTargetMenuItemId = undefined;
        state.pendingSectionTitle = undefined;
        state.phase = "menu";
        await ctx.reply("✅ Кнопка «Переход в раздел» добавлена.", kb(i18n, locale, []));
        await showButtonsMenu(ctx, state);
        return;
      }
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
    "Системные кнопки (Стать партнёром, Связь с наставником) ведут каждого пользователя к своему партнёру/наставнику — реферальная логика сохраняется.",
    "",
    "Текущие кнопки:",
    list
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
