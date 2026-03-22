import { Markup, Scenes } from "telegraf";
import type { InactivityReminderCtaTargetType, InactivityReminderTemplateCategory } from "@prisma/client";

import { makeCallbackData, splitCallbackData } from "../../common/callback-data";
import { NAV_ROOT_DATA } from "../keyboards";
import { buildMenuKeyboard } from "../keyboards";

import type { BotContext } from "../context";

export const INACTIVITY_REMINDER_ADMIN_SCENE = "inactivity-reminder-admin-scene";

const INREM_PREFIX = "inrem";

function normalizeReminderTemplateCategory(raw: string | undefined | null): InactivityReminderTemplateCategory {
  const v = String(raw ?? "SOFT")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  if (v === "SOFT") return "SOFT";
  if (v === "MOTIVATING") return "MOTIVATING";
  if (v === "BUSINESS") return "BUSINESS";
  if (v === "LIGHT_HUMOR") return "LIGHT_HUMOR";
  if (v === "HOOKING") return "HOOKING";
  if (v === "CALL_TO_ACTION") return "CALL_TO_ACTION";
  return "SOFT";
}

type WizardMode = "create" | "edit" | "browse_templates";

type WizardPhase =
  | "step1_page_confirm"
  | "step2_choose_target"
  | "step3_choose_delay"
  | "step3_custom_delay"
  | "step4_template_list"
  | "step4_template_details"
  | "step5_choose_cta"
  | "step6_confirm";

const DELAY_MIN = 1;
const DELAY_MAX = 1440; // 24 hours

type CtaOptionKey = "GO" | "NEXT" | "OPEN_SECTION" | "MAIN" | "REGISTER" | "MENTOR";

const CTA_OPTIONS: Array<{
  key: CtaOptionKey;
  labelKey: string;
  targetType: InactivityReminderCtaTargetType;
}> = [
  { key: "GO", labelKey: "reminders_cta_go", targetType: "NEXT_PAGE" },
  { key: "NEXT", labelKey: "reminders_cta_next", targetType: "NEXT_PAGE" },
  { key: "OPEN_SECTION", labelKey: "reminders_cta_open_section", targetType: "NEXT_PAGE" },
  { key: "REGISTER", labelKey: "reminders_cta_register", targetType: "NEXT_PAGE" },
  { key: "MENTOR", labelKey: "reminders_cta_mentor", targetType: "NEXT_PAGE" },
  { key: "MAIN", labelKey: "reminders_cta_main", targetType: "ROOT" }
];

const TEMPLATE_CATEGORIES: Array<{
  key: "SOFT" | "MOTIVATING" | "BUSINESS" | "LIGHT_HUMOR" | "HOOKING" | "CALL_TO_ACTION";
  labelKey: string;
}> = [
  { key: "SOFT", labelKey: "reminders_template_cat_soft" },
  { key: "MOTIVATING", labelKey: "reminders_template_cat_motivating" },
  { key: "BUSINESS", labelKey: "reminders_template_cat_business" },
  { key: "LIGHT_HUMOR", labelKey: "reminders_template_cat_light_humor" },
  { key: "HOOKING", labelKey: "reminders_template_cat_hooking" },
  { key: "CALL_TO_ACTION", labelKey: "reminders_template_cat_call_to_action" }
];

function findCtaOptionKeyByLabel(
  i18n: BotContext["services"]["i18n"],
  locale: string,
  label: string
): CtaOptionKey | null {
  if (!label) return null;
  for (const opt of CTA_OPTIONS) {
    // Template might store either RU label or already-localized label.
    const ruLabel = i18n.t("ru", opt.labelKey as any);
    const localeLabel = i18n.t(locale, opt.labelKey as any);
    if (label === ruLabel || label === localeLabel) return opt.key;
  }
  return null;
}

type TemplateDetails = {
  id: string;
  title: string;
  category: string;
  text: string;
  defaultCtaLabel: string;
};

type TargetOption = {
  id: string;
  title: string;
  type: string;
  destinationTitle: string;
  destinationPageId: string;
};

type WizardState = {
  mode: WizardMode;
  triggerPageId: string;
  ruleId?: string;
  uiLanguageCode?: string;
  contentLanguageCode?: string;

  phase: WizardPhase;
  templateCategory?: TemplateDetails["category"];
  templateDetailsId?: string;

  draft: {
    templateId?: string;
    templateDetails?: TemplateDetails;
    targetMenuItemId?: string;
    targetOption?: TargetOption;
    delayMinutes?: number;
    ctaOption?: CtaOptionKey;
    ctaLabel?: string;
    ctaTargetType?: InactivityReminderCtaTargetType;
    pageTitle?: string;
  };
  backToHub?: string; // callback_data for hub back
};

function resolveUiLocale(ctx: Scenes.WizardContext & BotContext, state?: WizardState): string {
  return ctx.services.i18n.resolveLanguage(state?.uiLanguageCode ?? ctx.currentUser?.selectedLanguage);
}

function resolveContentLanguageCode(ctx: Scenes.WizardContext & BotContext, state?: WizardState): string {
  return ctx.services.i18n.normalizeLocalizationLanguageCode(state?.contentLanguageCode ?? ctx.currentUser?.selectedLanguage);
}

function verticalKeyboard(buttons: Array<{ text: string; cb: string }>) {
  return Markup.inlineKeyboard(buttons.map((b) => [Markup.button.callback(b.text, b.cb)]));
}

function textPreview(s: string, maxLen = 70) {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

async function openRootMenu(ctx: Scenes.WizardContext & BotContext) {
  // Minimal equivalent of sendRootWithWelcome: enough to satisfy navigation integrity for admins.
  const user = ctx.currentUser!;
  const effectiveRole = user.role ?? "USER";
  const shouldSchedule = effectiveRole === "USER";

  await ctx.services.inactivityReminders.cancelPendingForUserExcept(user.id, "root");

  const mentorUsername =
    user.mentorUserId ? (await ctx.services.users.findById(user.mentorUserId))?.username ?? null : null;

  const welcome = await ctx.services.menu.getWelcome(user, ctx.from ?? undefined);
  const items = await ctx.services.menu.getMenuItemsForParent(user, null);
  const rootSlotOrder = await ctx.services.menu.getEffectiveSlotOrder("root", items.map((i) => i.id));
  const externalPartnerUrl = await ctx.services.cabinet.getPartnerRegisterLinkForUser(user);
  const [partnerRegisterTargetId, mentorContactTargetId] = await Promise.all([
    ctx.services.menu.getSystemTargetMenuItemId("partner_register"),
    ctx.services.menu.getSystemTargetMenuItemId("mentor_contact")
  ]);

  await ctx.services.navigation.replaceScreen(
    user,
    ctx.telegram,
    ctx.chat?.id ?? user.telegramUserId,
    welcome,
    buildMenuKeyboard(
      items,
      user.selectedLanguage,
      ctx.services.i18n,
      undefined,
      effectiveRole,
      undefined,
      rootSlotOrder,
      mentorUsername,
      externalPartnerUrl,
      partnerRegisterTargetId,
      mentorContactTargetId
    )
  );

  await ctx.services.inactivityReminders.scheduleForPageOpen(user, "root", { shouldSchedule });
}

async function renderRemindersHub(ctx: Scenes.WizardContext & BotContext, triggerPageId: string) {
  const user = ctx.currentUser!;
  const state = ctx.wizard.state as WizardState;
  const locale = resolveUiLocale(ctx, state);
  const backLabel = ctx.services.i18n.t(locale, "back");

  const kb = verticalKeyboard([
    { text: ctx.services.i18n.t(locale, "reminders_btn_add"), cb: makeCallbackData("page_edit", "rem_add", triggerPageId) },
    { text: ctx.services.i18n.t(locale, "reminders_btn_templates"), cb: makeCallbackData("page_edit", "rem_tpl", triggerPageId) },
    { text: ctx.services.i18n.t(locale, "reminders_btn_timer"), cb: makeCallbackData("page_edit", "rem_timer", triggerPageId) },
    { text: ctx.services.i18n.t(locale, "reminders_btn_active"), cb: makeCallbackData("page_edit", "rem_list", triggerPageId) },
    { text: backLabel, cb: makeCallbackData("page_edit", "open", triggerPageId) },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);

  await ctx.services.navigation.replaceScreen(
    user,
    ctx.telegram,
    ctx.chat?.id ?? user.telegramUserId,
    { text: ctx.services.i18n.t(locale, "reminders_hub_description") },
    kb
  );
}

export const inactivityReminderAdminScene = new Scenes.WizardScene<any>(INACTIVITY_REMINDER_ADMIN_SCENE, async (ctx, next) => {
  const user = ctx.currentUser!;
  const state = ctx.wizard.state as WizardState & { __inremAdminInit?: boolean };
  const locale = resolveUiLocale(ctx, state);

  const cbData: string | undefined = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  const isInremCallback = typeof cbData === "string" && cbData.startsWith(`${INREM_PREFIX}:`);

  // Initialize only once when entering the scene, otherwise callbacks will be overwritten.
  if (!state.__inremAdminInit) {
    state.__inremAdminInit = true;

    state.mode = (ctx.scene.state as any)?.mode ?? "create";
    state.triggerPageId = (ctx.scene.state as any)?.triggerPageId;
    state.ruleId = (ctx.scene.state as any)?.ruleId;
    state.uiLanguageCode = (ctx.scene.state as any)?.uiLanguageCode ?? state.uiLanguageCode;
    state.contentLanguageCode = (ctx.scene.state as any)?.contentLanguageCode ?? state.contentLanguageCode;
    state.backToHub = makeCallbackData("page_edit", "open_reminders", state.triggerPageId);

    const initialPhase = (ctx.scene.state as any)?.initialPhase as WizardPhase | undefined;
    state.phase = initialPhase ?? (state.mode === "browse_templates" ? "step4_template_list" : "step1_page_confirm");

    // Don't clobber an already-selected category if scene was re-entered from inside flow.
    state.templateCategory = state.templateCategory ?? "SOFT";
    state.templateDetailsId = undefined;
    state.draft = state.draft ?? {};
    const rawDelayMinutes = (ctx.scene.state as any)?.delayMinutes;
    const raw = Number(rawDelayMinutes);
    state.draft.delayMinutes =
      !Number.isNaN(raw) && raw >= DELAY_MIN && raw <= DELAY_MAX ? raw : 45;

    // preload page title
    if (!state.draft.pageTitle) {
      const contentLanguageCode = resolveContentLanguageCode(ctx, state);
      state.draft.pageTitle =
        state.triggerPageId === "root"
          ? ctx.services.i18n.t(locale, "page_root_title")
          : await ctx.services.menu.findMenuItemById(state.triggerPageId).then((item: any) => {
              if (!item) return state.triggerPageId;
              return ctx.services.i18n.pickLocalized(item.localizations, contentLanguageCode)?.title ?? item.key;
            });
    }

    // If editing an existing rule, preload draft values.
    if (state.mode === "edit" && state.triggerPageId) {
      const rule = state.ruleId
        ? await ctx.services.inactivityReminders.getRuleById(state.ruleId)
        : await ctx.services.inactivityReminders.getRuleByTriggerPageId(state.triggerPageId);
      if (rule) {
        state.ruleId = rule.id;
        state.draft.templateId = rule.templateId ?? undefined;
        state.draft.targetMenuItemId = rule.targetMenuItemId ?? undefined;
        state.draft.delayMinutes = rule.delayMinutes ?? state.draft.delayMinutes;
        state.draft.ctaLabel = rule.ctaLabel ?? undefined;
        state.draft.ctaTargetType = rule.ctaTargetType ?? undefined;

        if (rule.template) {
          state.draft.templateDetails = {
            id: rule.template.id,
            title: rule.template.title,
            category: rule.template.category as any,
            text: rule.template.text,
            defaultCtaLabel: rule.template.defaultCtaLabel
          };
          state.templateCategory = normalizeReminderTemplateCategory(rule.template.category as any);
        }
      } else {
        // If rule doesn't exist (yet), fall back to create mode.
        state.mode = "create";
        state.ruleId = undefined;
      }
    }
  }

  // For in-scene callbacks we must delegate to callback middleware, not render static screens.
  if (isInremCallback) {
    return next();
  }

  if (state.phase === "step1_page_confirm") {
    await ctx.reply(
      ctx.services.i18n.t(locale, "reminders_wizard_step1_page").replace("{{title}}", state.draft.pageTitle ?? ""),
      verticalKeyboard([
        { text: ctx.services.i18n.t(locale, "reminders_wizard_next_btn"), cb: makeCallbackData(INREM_PREFIX, "step1_next") },
        { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData("page_edit", "open_reminders", state.triggerPageId) },
        { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
      ])
    );
    return;
  }

  if (state.phase === "step4_template_list") {
    const { text, keyboard } = await renderTemplateList(ctx, state);
    await ctx.reply(text, keyboard);
    return;
  }

  // Other phases are reached through callback transitions.
  return;
});

async function renderTemplateList(ctx: Scenes.WizardContext & BotContext, state: WizardState) {
  const locale = resolveUiLocale(ctx, state);
  const catKey = normalizeReminderTemplateCategory(state.templateCategory ?? "SOFT") as any;
  const templates = await ctx.services.inactivityReminders.getTemplatesByCategory({
    languageCode: locale,
    category: catKey
  });

  const categoryButtons = TEMPLATE_CATEGORIES.map((c) => ({
    text: `📌 ${ctx.services.i18n.t(locale, c.labelKey as any)}${c.key === catKey ? " ✅" : ""}`,
    cb: makeCallbackData(INREM_PREFIX, "tpl_cat", c.key)
  }));

  const templateButtons = templates.map((t) => ({
    text: `📝 ${t.title}`,
    cb: makeCallbackData(INREM_PREFIX, "tpl_open", t.id)
  }));

  // Back depends on mode.
  const backCb =
    state.mode === "browse_templates"
      ? makeCallbackData("page_edit", "open_reminders", state.triggerPageId)
      : makeCallbackData(INREM_PREFIX, "back_to_delay");

  const keyboard = verticalKeyboard([
    ...categoryButtons,
    ...templateButtons,
    { text: ctx.services.i18n.t(locale, "back"), cb: backCb },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);

  const catDef = TEMPLATE_CATEGORIES.find((c) => c.key === catKey);
  const catLabel = catDef ? ctx.services.i18n.t(locale, catDef.labelKey as any) : catKey;
  const lines: string[] = [];
  lines.push(ctx.services.i18n.t(locale, "reminders_wizard_templates_title"));
  lines.push(ctx.services.i18n.t(locale, "reminders_wizard_category_line").replace("{{category}}", catLabel));
  lines.push("");
  if (templates.length === 0) {
    lines.push(ctx.services.i18n.t(locale, "reminders_wizard_templates_empty"));
  } else {
    lines.push(ctx.services.i18n.t(locale, "reminders_wizard_templates_select"));
    for (const t of templates) {
      lines.push(`• ${t.title} — ${textPreview(t.text, 60)}`);
    }
  }

  return { text: lines.join("\n"), keyboard };
}

function renderTemplateDetailsKeyboard(ctx: Scenes.WizardContext & BotContext, state: WizardState) {
  const locale = resolveUiLocale(ctx, state);
  const backCb = makeCallbackData(INREM_PREFIX, "back_to_tpl_list");

  return verticalKeyboard([
    { text: ctx.services.i18n.t(locale, "reminders_wizard_use_template_btn"), cb: makeCallbackData(INREM_PREFIX, "tpl_use") },
    { text: ctx.services.i18n.t(locale, "back"), cb: backCb },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);
}

async function renderTemplateDetailsText(ctx: Scenes.WizardContext & BotContext, state: WizardState, tpl: TemplateDetails) {
  const locale = resolveUiLocale(ctx, state);
  const catDef = TEMPLATE_CATEGORIES.find((c) => c.key === tpl.category);
  const catLabel = catDef ? ctx.services.i18n.t(locale, catDef.labelKey as any) : tpl.category;

  return [
    `${ctx.services.i18n.t(locale, "reminders_wizard_template_label")}: ${tpl.title}`,
    `${ctx.services.i18n.t(locale, "reminders_wizard_category_label")}: ${catLabel}`,
    `${ctx.services.i18n.t(locale, "reminders_wizard_default_cta_label")}: ${tpl.defaultCtaLabel}`,
    "",
    tpl.text
  ].join("\n");
}

function renderDelayKeyboard(ctx: Scenes.WizardContext & BotContext, state: WizardState) {
  const locale = resolveUiLocale(ctx, state);
  return verticalKeyboard([
    { text: ctx.services.i18n.t(locale, "reminders_delay_15"), cb: makeCallbackData(INREM_PREFIX, "delay", "15") },
    { text: ctx.services.i18n.t(locale, "reminders_delay_30"), cb: makeCallbackData(INREM_PREFIX, "delay", "30") },
    { text: ctx.services.i18n.t(locale, "reminders_delay_45"), cb: makeCallbackData(INREM_PREFIX, "delay", "45") },
    { text: ctx.services.i18n.t(locale, "reminders_delay_60"), cb: makeCallbackData(INREM_PREFIX, "delay", "60") },
    { text: ctx.services.i18n.t(locale, "reminders_delay_custom"), cb: makeCallbackData(INREM_PREFIX, "delay", "custom") },
    { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_target") },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);
}

function renderTargetKeyboard(ctx: Scenes.WizardContext & BotContext, state: WizardState, options: TargetOption[]) {
  const locale = resolveUiLocale(ctx, state);
  return verticalKeyboard([
    ...options.map((o) => ({
      text: `➜ ${o.title}${o.id !== o.destinationPageId ? ` → ${o.destinationTitle}` : ""}`,
      cb: makeCallbackData(INREM_PREFIX, "target", o.id)
    })),
    { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_page") },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);
}

function renderCtaKeyboard(ctx: Scenes.WizardContext & BotContext, state: WizardState) {
  const locale = resolveUiLocale(ctx, state);
  const rows: Array<{ text: string; cb: string }> = [];
  for (const opt of CTA_OPTIONS) {
    rows.push({
      text: ctx.services.i18n.t(locale, opt.labelKey as any),
      cb: makeCallbackData(INREM_PREFIX, "cta", opt.key)
    });
  }
  return verticalKeyboard([
    ...rows,
    { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_templates") },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);
}

function renderConfirmKeyboard(ctx: Scenes.WizardContext & BotContext, state: WizardState) {
  const locale = resolveUiLocale(ctx, state);
  return verticalKeyboard([
    { text: ctx.services.i18n.t(locale, "reminders_wizard_save_btn"), cb: makeCallbackData(INREM_PREFIX, "save") },
    { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_cta") },
    { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
  ]);
}

inactivityReminderAdminScene.use(async (ctx, next) => {
  const state = ctx.wizard.state as WizardState;
  const text = ctx.message && "text" in ctx.message ? ctx.message.text?.trim() : undefined;
  if (state.phase === "step3_custom_delay" && text) {
    const num = parseInt(text, 10);
    if (!Number.isNaN(num) && num >= DELAY_MIN && num <= DELAY_MAX) {
      state.draft.delayMinutes = num;
      state.phase = state.draft.templateId ? "step4_template_details" : "step4_template_list";
      const locale = resolveUiLocale(ctx as any, state);
      if (state.draft.templateId) {
        const tpl = await ctx.services.inactivityReminders.getTemplateById(state.draft.templateId);
        if (tpl) {
          state.draft.templateDetails = {
            id: tpl.id,
            title: tpl.title,
            category: tpl.category as any,
            text: tpl.text,
            defaultCtaLabel: tpl.defaultCtaLabel
          };
          state.phase = "step4_template_details";
          await ctx.reply(
            await renderTemplateDetailsText(ctx as any, state, state.draft.templateDetails),
            renderTemplateDetailsKeyboard(ctx as any, state)
          );
          return;
        }
      }
      const { text: t, keyboard } = await renderTemplateList(ctx as any, state);
      await ctx.reply(t, keyboard);
      return;
    }
    const locale = resolveUiLocale(ctx as any, state);
    await ctx.reply(
      ctx.services.i18n.t(locale, "reminders_delay_custom_invalid"),
      verticalKeyboard([
        { text: ctx.services.i18n.t(locale, "reminders_delay_cancel"), cb: makeCallbackData(INREM_PREFIX, "delay_cancel") },
        { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_target") },
        { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
      ])
    );
    return;
  }
  return next();
});

inactivityReminderAdminScene.use(async (ctx, next) => {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return next();
  const data = ctx.callbackQuery.data;
  if (!data) return next();

  const state = ctx.wizard.state as WizardState;

  await ctx.answerCbQuery().catch(() => undefined);

  // Main menu.
  if (data === NAV_ROOT_DATA) {
    await ctx.scene.leave();
    await openRootMenu(ctx as any);
    return;
  }

  // "Scene-level" back to reminder hub.
  if (data === makeCallbackData("page_edit", "open_reminders", state.triggerPageId)) {
    await ctx.scene.leave();
    await renderRemindersHub(ctx as any, state.triggerPageId);
    return;
  }

  if (!data.startsWith(`${INREM_PREFIX}:`)) {
    return next();
  }

  const parts = splitCallbackData(data);
  const [, action, a2, a3] = parts;

  const locale = resolveUiLocale(ctx as any, state);
  const contentLanguageCode = resolveContentLanguageCode(ctx as any, state);

  // Helpers to re-render current phase.
  const showTemplatesList = async () => {
    state.phase = "step4_template_list";
    const { text, keyboard } = await renderTemplateList(ctx as any, state);
    await ctx.reply(text, keyboard);
  };

  if (state.phase === "step1_page_confirm" && action === "step1_next") {
    state.phase = "step2_choose_target";
    const triggerParentId = state.triggerPageId === "root" ? null : state.triggerPageId;
    const actor = ctx.currentUser!;
    const items = await ctx.services.menu.getMenuItemsForParent(actor, triggerParentId);
    const available = items.filter((it: any) => !it.locked);

    if (available.length === 0) {
      await ctx.reply(
        ctx.services.i18n.t(locale, "reminders_wizard_no_options"),
        verticalKeyboard([
          { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_page") },
          { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
        ])
      );
      return;
    }

    const options: TargetOption[] = [];
    const seenTargets = new Set<string>();
    for (const item of available) {
      const destPageId =
        item.type === "SECTION_LINK" && item.targetMenuItemId ? item.targetMenuItemId : item.id;

      let destTitle = item.localizations?.[0]?.title ?? item.id;
      if (destPageId && destPageId !== item.id) {
        const destItem = await ctx.services.menu.findMenuItemById(destPageId);
        if (destItem) destTitle = ctx.services.i18n.pickLocalized(destItem.localizations, contentLanguageCode)?.title ?? destItem.key;
      } else {
        destTitle = ctx.services.i18n.pickLocalized(item.localizations, contentLanguageCode)?.title ?? item.key;
      }

      const option: TargetOption = {
        id: item.id,
        title: ctx.services.i18n.pickLocalized(item.localizations, contentLanguageCode)?.title ?? item.key,
        type: item.type,
        destinationPageId: destPageId,
        destinationTitle: destTitle
      };

      // Hide duplicates in wizard UI when several buttons point to the same destination
      // with the same visible title.
      const dedupeKey = `${option.destinationPageId ?? "none"}::${option.destinationTitle ?? ""}`;
      if (seenTargets.has(dedupeKey)) continue;
      seenTargets.add(dedupeKey);
      options.push(option);
    }

    // Preselect current rule target when editing.
    const existingTargetMenuItemId = state.draft.targetMenuItemId;
    const selectedOption =
      (existingTargetMenuItemId ? options.find((o) => o.id === existingTargetMenuItemId) : undefined) ?? options[0];

    if (!selectedOption) return;

    state.draft.targetOption = selectedOption;
    state.draft.targetMenuItemId = selectedOption.id;
    // Store options for later confirmation lookup.
    (state as any)._targetOptions = options;

    await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step2_prompt"), renderTargetKeyboard(ctx as any, state, options));
    return;
  }

  if (state.phase === "step2_choose_target" && action === "target" && a2) {
    const options: TargetOption[] = (state as any)._targetOptions ?? [];
    const selected = options.find((o) => o.id === a2) ?? null;
    if (selected) {
      state.draft.targetOption = selected;
      state.draft.targetMenuItemId = selected.id;
    }
    state.phase = "step3_choose_delay";
    await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step3_prompt"), renderDelayKeyboard(ctx as any, state));
    return;
  }

  if (state.phase === "step2_choose_target" && action === "back_to_page") {
    state.phase = "step1_page_confirm";
    await ctx.reply(
      ctx.services.i18n.t(locale, "reminders_wizard_step1_page").replace("{{title}}", state.draft.pageTitle ?? ""),
      verticalKeyboard([
        { text: ctx.services.i18n.t(locale, "reminders_wizard_next_btn"), cb: makeCallbackData(INREM_PREFIX, "step1_next") },
        { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData("page_edit", "open_reminders", state.triggerPageId) },
        { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
      ])
    );
    return;
  }

  if (state.phase === "step3_choose_delay" && action === "delay" && a2 === "custom") {
    state.phase = "step3_custom_delay";
    await ctx.reply(
      ctx.services.i18n.t(locale, "reminders_delay_custom_prompt"),
      verticalKeyboard([
        { text: ctx.services.i18n.t(locale, "reminders_delay_cancel"), cb: makeCallbackData(INREM_PREFIX, "delay_cancel") },
        { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData(INREM_PREFIX, "back_to_target") },
        { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
      ])
    );
    return;
  }

  if (state.phase === "step3_custom_delay" && action === "delay_cancel") {
    state.phase = "step3_choose_delay";
    await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step3_prompt"), renderDelayKeyboard(ctx as any, state));
    return;
  }

  if (state.phase === "step3_choose_delay" && action === "delay" && a2) {
    const v = Number(a2);
    if (![15, 30, 45, 60].includes(v)) return;
    state.draft.delayMinutes = v;
    state.phase = state.draft.templateId ? "step4_template_details" : "step4_template_list";

    if (state.draft.templateId) {
      const tpl = await ctx.services.inactivityReminders.getTemplateById(state.draft.templateId);
      if (tpl) {
        state.draft.templateDetails = {
          id: tpl.id,
          title: tpl.title,
          category: tpl.category as any,
          text: tpl.text,
          defaultCtaLabel: tpl.defaultCtaLabel
        };
        state.phase = "step4_template_details";
        await ctx.reply(
          await renderTemplateDetailsText(ctx as any, state, state.draft.templateDetails),
          renderTemplateDetailsKeyboard(ctx as any, state)
        );
        return;
      }
    }

    await showTemplatesList();
    return;
  }

  if (state.phase === "step3_choose_delay" && action === "back_to_target") {
    state.phase = "step2_choose_target";
    const options: TargetOption[] = (state as any)._targetOptions ?? [];
    await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step2_prompt"), renderTargetKeyboard(ctx as any, state, options));
    return;
  }

  if (state.phase === "step4_template_list") {
    if (action === "tpl_cat" && a2) {
      state.templateCategory = a2 as any;
      await showTemplatesList();
      return;
    }

    if (action === "tpl_open" && a2) {
      const tpl = await ctx.services.inactivityReminders.getTemplateById(a2);
      if (!tpl) return;
      state.draft.templateId = tpl.id;
      state.draft.templateDetails = {
        id: tpl.id,
        title: tpl.title,
        category: tpl.category as any,
        text: tpl.text,
        defaultCtaLabel: tpl.defaultCtaLabel
      };
      state.phase = "step4_template_details";

      await ctx.reply(
        await renderTemplateDetailsText(ctx as any, state, state.draft.templateDetails),
        renderTemplateDetailsKeyboard(ctx as any, state)
      );
      return;
    }

    if (action === "back_to_delay") {
      state.phase = "step3_choose_delay";
      await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step3_prompt"), renderDelayKeyboard(ctx as any, state));
      return;
    }
  }

  if (state.phase === "step4_template_details") {
    if (action === "back_to_tpl_list") {
      state.phase = "step4_template_list";
      await showTemplatesList();
      return;
    }

    if (action === "tpl_use") {
      if (state.mode === "browse_templates") {
        // Use from browse mode: go back to creation step 1.
        state.phase = "step1_page_confirm";
        state.mode = "create";
        await ctx.reply(
          ctx.services.i18n.t(locale, "reminders_wizard_step1_page").replace("{{title}}", state.draft.pageTitle ?? ""),
          verticalKeyboard([
            { text: ctx.services.i18n.t(locale, "reminders_wizard_next_btn"), cb: makeCallbackData(INREM_PREFIX, "step1_next") },
            { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData("page_edit", "open_reminders", state.triggerPageId) },
            { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
          ])
        );
        return;
      }

      // In creation/edit mode: go to CTA step.
      const tpl = state.draft.templateDetails;
      // In "edit" mode preserve existing CTA label if it was already loaded.
      if (state.mode !== "edit" || !state.draft.ctaLabel) {
        const defaultLabel = tpl?.defaultCtaLabel ?? "";
        const defaultKey = findCtaOptionKeyByLabel(ctx.services.i18n, locale, defaultLabel) ?? "NEXT";
        const defaultOpt = CTA_OPTIONS.find((o) => o.key === defaultKey) ?? CTA_OPTIONS.find((o) => o.key === "NEXT")!;
        state.draft.ctaOption = defaultOpt.key;
        state.draft.ctaLabel = ctx.services.i18n.t(locale, defaultOpt.labelKey as any);
        state.draft.ctaTargetType = defaultOpt.targetType;
      }
      state.phase = "step5_choose_cta";
      await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step5_prompt"), renderCtaKeyboard(ctx as any, state));
      return;
    }
  }

  if (state.phase === "step5_choose_cta") {
    if (action === "cta" && a2) {
      const opt = CTA_OPTIONS.find((o) => o.key === a2);
      if (!opt) return;
      state.draft.ctaOption = opt.key;
      state.draft.ctaLabel = ctx.services.i18n.t(locale, opt.labelKey as any);
      state.draft.ctaTargetType = opt.targetType;
      state.phase = "step6_confirm";

      const pageTitle = state.draft.pageTitle ?? "";
      const targetText = state.draft.targetOption
        ? `${state.draft.targetOption.title} → ${state.draft.targetOption.destinationTitle}`
        : "—";
      const delayMinutes = state.draft.delayMinutes ?? 45;
      const templateTitle = state.draft.templateDetails?.title ?? "—";
      const ctaLabel = state.draft.ctaLabel ?? "—";

      await ctx.reply(
        [
          ctx.services.i18n.t(locale, "reminders_wizard_step6_confirm"),
          "",
          ctx.services.i18n.t(locale, "reminders_wizard_page_line").replace("{{title}}", pageTitle),
          ctx.services.i18n.t(locale, "reminders_wizard_target_line").replace("{{target}}", targetText),
          ctx.services.i18n.t(locale, "reminders_wizard_delay_line").replace("{{minutes}}", String(delayMinutes)),
          ctx.services.i18n.t(locale, "reminders_wizard_template_line").replace("{{title}}", templateTitle),
          ctx.services.i18n.t(locale, "reminders_wizard_cta_line").replace("{{cta}}", ctaLabel)
        ].join("\n"),
        renderConfirmKeyboard(ctx as any, state)
      );
      return;
    }

    if (action === "back_to_templates") {
      state.phase = "step4_template_list";
      await showTemplatesList();
      return;
    }
  }

  if (state.phase === "step6_confirm" && action === "back_to_cta") {
    state.phase = "step5_choose_cta";
    await ctx.reply(ctx.services.i18n.t(locale, "reminders_wizard_step5_prompt"), renderCtaKeyboard(ctx as any, state));
    return;
  }

  if (state.phase === "step6_confirm" && action === "save") {
    const triggerPageId = state.triggerPageId;
    const templateId = state.draft.templateId;
    const targetMenuItemId = state.draft.targetMenuItemId;
    const delayMinutes = state.draft.delayMinutes;
    const ctaLabel = state.draft.ctaLabel;
    const ctaTargetType = state.draft.ctaTargetType;

    if (!templateId || !targetMenuItemId || !delayMinutes || !ctaLabel || !ctaTargetType) return;

    const rule = await ctx.services.inactivityReminders.upsertRuleForTriggerPage({
      triggerPageId,
      templateId,
      targetMenuItemId,
      delayMinutes,
      ctaLabel,
      ctaTargetType,
      ruleId: state.mode === "edit" ? state.ruleId : undefined
    });

    // Leave scene first so external callbacks work.
    const ruleId = rule.id;
    await ctx.scene.leave();

    await ctx.reply(
      [
        ctx.services.i18n.t(locale, "reminders_wizard_save_success"),
        "",
        ctx.services.i18n.t(locale, "reminders_wizard_page_line").replace("{{title}}", state.draft.pageTitle ?? ""),
        ctx.services.i18n.t(locale, "reminders_wizard_target_line").replace(
          "{{target}}",
          state.draft.targetOption
            ? `${state.draft.targetOption.title} → ${state.draft.targetOption.destinationTitle}`
            : "—"
        ),
        ctx.services.i18n.t(locale, "reminders_wizard_delay_line").replace("{{minutes}}", String(delayMinutes)),
        ctx.services.i18n.t(locale, "reminders_wizard_template_line").replace("{{title}}", state.draft.templateDetails?.title ?? "—"),
        ctx.services.i18n.t(locale, "reminders_wizard_cta_line").replace("{{cta}}", ctaLabel)
      ].join("\n"),
      verticalKeyboard([
        { text: ctx.services.i18n.t(locale, "reminders_wizard_edit_btn"), cb: makeCallbackData("page_edit", "rem_edit", ruleId) },
        { text: ctx.services.i18n.t(locale, "reminders_wizard_delete_btn"), cb: makeCallbackData("page_edit", "rem_del_confirm", ruleId) },
        { text: ctx.services.i18n.t(locale, "reminders_wizard_back_to_list_btn"), cb: makeCallbackData("page_edit", "rem_list", triggerPageId) },
        { text: ctx.services.i18n.t(locale, "back"), cb: makeCallbackData("page_edit", "open_reminders", triggerPageId) },
        { text: ctx.services.i18n.t(locale, "to_main_menu"), cb: NAV_ROOT_DATA }
      ])
    );
    return;
  }
});

