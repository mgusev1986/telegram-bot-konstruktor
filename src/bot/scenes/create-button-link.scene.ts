import { Markup, Scenes } from "telegraf";

import { makeCallbackData, toShortId } from "../../common/callback-data";
import { logger } from "../../common/logger";
import { readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import { renderScreen } from "../helpers/screen-template";
import {
  buildSceneCancelBackKeyboard,
  NAV_BACK_DATA,
  NAV_ROOT_DATA,
  buildReturnToAdminOrPageKeyboard,
  buildNavigationRow,
  buildOnboardingChoiceAfterSectionKeyboard,
  SCENE_CANCEL_DATA
} from "../keyboards";

export const CREATE_BUTTON_LINK_SCENE = "create-button-link-scene";

const PREFIX = "create_btn";

type SceneState = BotContext["wizard"]["state"] & {
  parentId?: string | null;
  fromPageId?: string;
  fromOnboardingStep?: number;
  languageCode?: string;
  uiLanguageCode?: string;
  title?: string;
};

function normalizeExternalUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.hostname ? url.toString() : null;
    }
    if (url.protocol === "tg:") {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

const SYSTEM_TARGETS = [
  "my_cabinet",
  "partner_register",
  "mentor_contact",
  "change_language"
] as const;
type SystemTargetKind = (typeof SYSTEM_TARGETS)[number];

function getLocale(ctx: BotContext, state?: SceneState): string {
  return ctx.services.i18n.resolveLanguage(state?.uiLanguageCode ?? ctx.currentUser?.selectedLanguage);
}

function buildVerticalSceneKeyboard(
  ctx: BotContext,
  locale: string,
  state: SceneState,
  opts?: { backCallbackData?: string }
) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (opts?.backCallbackData) {
    rows.push([Markup.button.callback(ctx.services.i18n.t(locale, "back"), opts.backCallbackData)]);
  }
  rows.push([Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)]);
  if (state.fromOnboardingStep === 3) {
    for (const btn of buildNavigationRow(ctx.services.i18n, locale, { toMain: true })) {
      rows.push([btn]);
    }
  }
  return Markup.inlineKeyboard(rows);
}

function buildTargetTypeKeyboard(ctx: BotContext, locale: string, state: SceneState) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback(ctx.services.i18n.t(locale, "button_target_existing_section"), makeCallbackData(PREFIX, "mode", "section"))],
    [Markup.button.callback(ctx.services.i18n.t(locale, "button_target_external_link"), makeCallbackData(PREFIX, "mode", "external"))],
    [Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)]
  ];
  if (state.fromOnboardingStep === 3) {
    for (const btn of buildNavigationRow(ctx.services.i18n, locale, { toMain: true })) {
      rows.push([btn]);
    }
  }
  return Markup.inlineKeyboard(rows);
}

async function replyWithTargetTypeChoice(ctx: BotContext, state: SceneState, locale: string) {
  await ctx.replyWithHTML(
    renderScreen({
      header:
        state.fromOnboardingStep === 3
          ? ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "3")
          : "🔗 " + ctx.services.i18n.t(locale, "wizard_creating_button"),
      explain: [ctx.services.i18n.t(locale, "button_create_intro")],
      action: ctx.services.i18n.t(locale, "button_choose_target_type")
    }),
    buildTargetTypeKeyboard(ctx, locale, state)
  );
}

export const createButtonLinkScene = new Scenes.WizardScene<any>(
  CREATE_BUTTON_LINK_SCENE,
  async (ctx, next) => {
    const sceneState = ctx.scene.state as {
      parentId?: string | null;
      fromPageId?: string;
      fromOnboardingStep?: number;
      languageCode?: string;
      uiLanguageCode?: string;
    };
    const state = ctx.wizard.state as SceneState;
    state.parentId = sceneState.parentId ?? null;
    state.fromPageId = sceneState.fromPageId ?? (sceneState.parentId != null ? String(sceneState.parentId) : "root");
    state.fromOnboardingStep = sceneState.fromOnboardingStep;
    state.uiLanguageCode = sceneState.uiLanguageCode ?? state.uiLanguageCode;
    if (sceneState.languageCode) {
      state.languageCode = ctx.services.i18n.normalizeLocalizationLanguageCode(sceneState.languageCode);
    }
    const locale = getLocale(ctx, state);
    logger.info(
      { userId: ctx.currentUser?.id, fromOnboardingStep: state.fromOnboardingStep },
      "Onboarding step 3 scene entered"
    );

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      // When a global navigation button is pressed inside an active wizard,
      // let the global handler process it instead of silently ignoring it in scene steps.
      const data = ctx.callbackQuery.data;
      if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === "admin:open") {
        if (ctx.scene?.current) await ctx.scene.leave();
        return next();
      }
    }

    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === SCENE_CANCEL_DATA) {
      // Передаём управление общему обработчику отмены, чтобы он показал единообразный экран.
      return next();
    }

    await ctx.replyWithHTML(
      renderScreen({
        header:
          state.fromOnboardingStep === 3
            ? ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "3")
            : "🔗 " + ctx.services.i18n.t(locale, "wizard_creating_button"),
        explain: [ctx.services.i18n.t(locale, "button_create_intro")],
        action: ctx.services.i18n.t(locale, "enter_button_title")
      }),
      state.fromOnboardingStep === 3
        ? Markup.inlineKeyboard([
            [Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
            buildNavigationRow(ctx.services.i18n, locale, { toMain: true })
          ])
        : buildSceneCancelBackKeyboard(ctx.services.i18n, locale)
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);

    const title = readTextMessage(ctx).trim();
    if (!title) {
      logger.info({ userId: ctx.currentUser?.id }, "Onboarding step 3 validation failed: empty button title");
      await ctx.reply(
        ctx.services.i18n.t(locale, "error_empty_title"),
        state.fromOnboardingStep === 3
          ? Markup.inlineKeyboard([
              [Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
              buildNavigationRow(ctx.services.i18n, locale, { toMain: true })
            ])
          : buildSceneCancelBackKeyboard(ctx.services.i18n, locale)
      );
      return;
    }
    if (title.startsWith("/")) {
      logger.info({ userId: ctx.currentUser?.id }, "Onboarding step 3 validation failed: title starts with slash");
      await ctx.reply(
        ctx.services.i18n.t(locale, "error_title_cannot_start_with_slash"),
        state.fromOnboardingStep === 3
          ? Markup.inlineKeyboard([
              [Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
              buildNavigationRow(ctx.services.i18n, locale, { toMain: true })
            ])
          : buildSceneCancelBackKeyboard(ctx.services.i18n, locale)
      );
      return;
    }
    state.title = title;

    await replyWithTargetTypeChoice(ctx, state, locale);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);

    if (!(ctx.callbackQuery && "data" in ctx.callbackQuery)) {
      logger.info({ userId: ctx.currentUser?.id }, "Onboarding step 3 validation failed: no callback selection");
      await ctx.reply(ctx.services.i18n.t(locale, "choose_button_target_type_above"));
      return;
    }

    const data = ctx.callbackQuery.data;
    if (data === SCENE_CANCEL_DATA) return;

    // Global navigation can be clicked even while wizard step expects its own callback prefix.
    // In that case, exit the wizard and let the global action handler handle the callback.
    if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === "admin:open") {
      await ctx.scene.leave();
      return;
    }

    const parts = data.split(":");
    if (parts[0] !== PREFIX) {
      return;
    }
    if (parts[1] === "mode" && parts[2] === "section") {
      await ctx.answerCbQuery();
      const contentLanguageCode = ctx.services.i18n.normalizeLocalizationLanguageCode(
        state.languageCode ?? (await ctx.services.menu.getBaseLanguage(ctx.currentUser!.id))
      );
      const sections = await ctx.services.menu.getContentSectionsForPicker(contentLanguageCode);
      if (sections.length === 0) {
        logger.info({ userId: ctx.currentUser?.id }, "Onboarding step 3 aborted: no sections to link");
        await ctx.reply(
          ctx.services.i18n.t(locale, "no_sections_for_link"),
          buildReturnToAdminOrPageKeyboard(state.fromPageId ?? "root", ctx.services.i18n, locale)
        );
        return ctx.scene.leave();
      }

      const rows = sections.map((s: { id: string; title: string }) => [
        Markup.button.callback(s.title, makeCallbackData(PREFIX, "section", toShortId(s.id)))
      ]);
      rows.push([
        Markup.button.callback(
          "— " + ctx.services.i18n.t(locale, "target_system_buttons") + " —",
          makeCallbackData(PREFIX, "noop", "sys")
        )
      ]);
      const sysRows: Array<{ kind: SystemTargetKind; labelKey: string }> = [
        { kind: "my_cabinet", labelKey: "sys_btn_my_cabinet" },
        { kind: "partner_register", labelKey: "sys_btn_partner_register" },
        { kind: "mentor_contact", labelKey: "sys_btn_mentor_contact" },
        { kind: "change_language", labelKey: "sys_btn_change_language" }
      ];
      for (const row of sysRows) {
        rows.push([
          Markup.button.callback(ctx.services.i18n.t(locale, row.labelKey), makeCallbackData(PREFIX, "sys", row.kind))
        ]);
      }
      rows.push([Markup.button.callback(ctx.services.i18n.t(locale, "back"), makeCallbackData(PREFIX, "back", "mode"))]);
      rows.push([Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)]);
      if (state.fromOnboardingStep === 3) {
        for (const btn of buildNavigationRow(ctx.services.i18n, locale, { toMain: true })) {
          rows.push([btn]);
        }
      }

      await ctx.replyWithHTML(
        renderScreen({
          header:
            state.fromOnboardingStep === 3
              ? ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "3")
              : "🔗 " + ctx.services.i18n.t(locale, "wizard_creating_button"),
          explain: [ctx.services.i18n.t(locale, "button_create_intro")],
          action: ctx.services.i18n.t(locale, "choose_target_section")
        }),
        Markup.inlineKeyboard(rows)
      );
      return ctx.wizard.next();
    }
    if (parts[1] === "mode" && parts[2] === "external") {
      await ctx.answerCbQuery();
      await ctx.replyWithHTML(
        renderScreen({
          header:
            state.fromOnboardingStep === 3
              ? ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "3")
              : "🔗 " + ctx.services.i18n.t(locale, "wizard_creating_button"),
          explain: [ctx.services.i18n.t(locale, "button_create_intro")],
          action: ctx.services.i18n.t(locale, "enter_external_url")
        }),
        buildVerticalSceneKeyboard(ctx, locale, state, {
          backCallbackData: makeCallbackData(PREFIX, "back", "mode")
        })
      );
      return ctx.wizard.selectStep(4);
    }
    if (parts[1] === "back" && parts[2] === "mode") {
      await ctx.answerCbQuery();
      await replyWithTargetTypeChoice(ctx, state, locale);
      return;
    }
    await ctx.reply(ctx.services.i18n.t(locale, "choose_button_target_type_above"));
    return;
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);

    if (!(ctx.callbackQuery && "data" in ctx.callbackQuery)) {
      await ctx.reply(ctx.services.i18n.t(locale, "choose_section_above"));
      return;
    }
    const data = ctx.callbackQuery.data;
    if (data === SCENE_CANCEL_DATA) return;
    if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === "admin:open") {
      await ctx.scene.leave();
      return;
    }

    const parts = data.split(":");
    if (parts[0] !== PREFIX) return;
    if (parts[1] === "back" && parts[2] === "mode") {
      await ctx.answerCbQuery();
      await replyWithTargetTypeChoice(ctx, state, locale);
      return ctx.wizard.selectStep(2);
    }
    if (parts[1] === "noop") {
      return;
    }
    if (parts[1] !== "section" && parts[1] !== "sys") {
      await ctx.reply(ctx.services.i18n.t(locale, "choose_section_above"));
      return;
    }
    if (!parts[2]) return;

    await ctx.answerCbQuery();
    const targetKind = parts[1];
    const targetValue = parts[2];

    try {
      const baseLanguage = ctx.services.i18n.normalizeLocalizationLanguageCode(
        state.languageCode ?? (await ctx.services.menu.getBaseLanguage(ctx.currentUser!.id))
      );
      let targetMenuItemId: string;
      if (targetKind === "sys") {
        const kind = targetValue as SystemTargetKind;
        logger.info({ userId: ctx.currentUser?.id, kind }, "Onboarding step 3 system target selected");
        targetMenuItemId = await ctx.services.menu.ensureSystemTargetMenuItem(ctx.currentUser!.id, baseLanguage, kind);
      } else {
        const targetSection = await ctx.services.menu.findMenuItemByIdOrShort(targetValue);
        if (!targetSection) {
          await ctx.reply(ctx.services.i18n.t(locale, "choose_section_above"));
          return;
        }
        logger.info({ userId: ctx.currentUser?.id, targetSectionId: targetSection.id }, "Onboarding step 3 section selected");
        targetMenuItemId = targetSection.id;
      }
      await ctx.services.menu.createMenuItem({
        actorUserId: ctx.currentUser!.id,
        languageCode: baseLanguage,
        parentId: state.parentId ?? null,
        title: state.title ?? ctx.services.i18n.t(locale, "item_type_button"),
        type: "SECTION_LINK",
        targetMenuItemId
      });
      const fromPageId = state.fromPageId ?? "root";
      if (state.fromOnboardingStep === 3) {
        await ctx.services.users.setOnboardingStep(ctx.currentUser!.id, 3);
        const refreshed = await ctx.services.users.findById(ctx.currentUser!.id);
        if (refreshed) ctx.currentUser = refreshed;
        logger.info({ userId: ctx.currentUser?.id }, "Onboarding button link created, showing choice");
        const stepLabel = (s: number) =>
          ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", String(s));
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step3_success") +
            "\n\n" +
            stepLabel(3) +
            "\n\n" +
            ctx.services.i18n.t(locale, "onboarding_choice_after_section"),
          buildOnboardingChoiceAfterSectionKeyboard(locale, ctx.services.i18n)
        );
      } else {
        await ctx.reply(
          ctx.services.i18n.t(locale, "button_created_linked"),
          buildReturnToAdminOrPageKeyboard(fromPageId, ctx.services.i18n, locale)
        );
      }
    } catch (err) {
      logger.error({ userId: ctx.currentUser?.id, err }, "Onboarding step 3 save failed");
      await ctx.reply(ctx.services.i18n.t(locale, "error_save_step"));
      return;
    }
    return ctx.scene.leave();
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === SCENE_CANCEL_DATA) return;
      if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === "admin:open") {
        await ctx.scene.leave();
        return;
      }
      if (data === makeCallbackData(PREFIX, "back", "mode")) {
        await ctx.answerCbQuery();
        await replyWithTargetTypeChoice(ctx, state, locale);
        return ctx.wizard.selectStep(2);
      }
    }

    const urlRaw = readTextMessage(ctx)?.trim();
    if (!urlRaw) {
      await ctx.reply(
        ctx.services.i18n.t(locale, "error_empty_url"),
        buildVerticalSceneKeyboard(ctx, locale, state, {
          backCallbackData: makeCallbackData(PREFIX, "back", "mode")
        })
      );
      return;
    }
    const normalizedUrl = normalizeExternalUrl(urlRaw);
    if (!normalizedUrl) {
      await ctx.reply(
        ctx.services.i18n.t(locale, "error_invalid_url"),
        buildVerticalSceneKeyboard(ctx, locale, state, {
          backCallbackData: makeCallbackData(PREFIX, "back", "mode")
        })
      );
      return;
    }

    try {
      const baseLanguage = ctx.services.i18n.normalizeLocalizationLanguageCode(
        state.languageCode ?? (await ctx.services.menu.getBaseLanguage(ctx.currentUser!.id))
      );
      await ctx.services.menu.createMenuItem({
        actorUserId: ctx.currentUser!.id,
        languageCode: baseLanguage,
        parentId: state.parentId ?? null,
        title: state.title ?? ctx.services.i18n.t(locale, "item_type_button"),
        type: "EXTERNAL_LINK",
        externalUrl: normalizedUrl
      });
      const fromPageId = state.fromPageId ?? "root";
      if (state.fromOnboardingStep === 3) {
        await ctx.services.users.setOnboardingStep(ctx.currentUser!.id, 3);
        const refreshed = await ctx.services.users.findById(ctx.currentUser!.id);
        if (refreshed) ctx.currentUser = refreshed;
        const stepLabel = (s: number) =>
          ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", String(s));
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step3_success") +
            "\n\n" +
            stepLabel(3) +
            "\n\n" +
            ctx.services.i18n.t(locale, "onboarding_choice_after_section"),
          buildOnboardingChoiceAfterSectionKeyboard(locale, ctx.services.i18n)
        );
      } else {
        await ctx.reply(
          ctx.services.i18n.t(locale, "button_created_external"),
          buildReturnToAdminOrPageKeyboard(fromPageId, ctx.services.i18n, locale)
        );
      }
    } catch (err) {
      logger.error({ userId: ctx.currentUser?.id, err }, "Create external link button failed");
      await ctx.reply(ctx.services.i18n.t(locale, "error_save_step"));
      return;
    }
    return ctx.scene.leave();
  }
);
