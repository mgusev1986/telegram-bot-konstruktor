import { Markup, Scenes } from "telegraf";

import { makeCallbackData } from "../../common/callback-data";
import { logger } from "../../common/logger";
import { readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import { renderScreen } from "../helpers/screen-template";
import {
  buildSceneCancelBackKeyboard,
  NAV_BACK_DATA,
  NAV_ROOT_DATA,
  buildReturnToAdminOrPageKeyboard,
  buildCancelKeyboard,
  buildNavigationRow,
  buildOnboardingStep4Keyboard,
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
      Markup.button.callback(s.title, makeCallbackData(PREFIX, "section", s.id))
    ]);
    rows.push([
      Markup.button.callback("— " + ctx.services.i18n.t(locale, "target_system_buttons") + " —", makeCallbackData(PREFIX, "noop", "sys"))
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
    rows.push([Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)]);
    if (state.fromOnboardingStep === 3) {
      rows.push(buildNavigationRow(ctx.services.i18n, locale, { toMain: true }));
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
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);

    if (!(ctx.callbackQuery && "data" in ctx.callbackQuery)) {
      logger.info({ userId: ctx.currentUser?.id }, "Onboarding step 3 validation failed: no callback selection");
      await ctx.reply(ctx.services.i18n.t(locale, "choose_section_above"));
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
    if (parts[1] === "noop") {
      return;
    }
    if (parts[1] !== "section" && parts[1] !== "sys") {
      return;
    }
    if (!parts[2]) {
      return;
    }

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
        logger.info({ userId: ctx.currentUser?.id, targetSectionId: targetValue }, "Onboarding step 3 section selected");
        targetMenuItemId = targetValue;
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
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step3_success") +
            "\n" +
            `${ctx.services.i18n.t(locale, "next_step")}: ${ctx.services.i18n.t(locale, "onboarding_step4_title")}`
        );
        await ctx.services.users.setOnboardingStep(ctx.currentUser!.id, 4);
        const refreshed = await ctx.services.users.findById(ctx.currentUser!.id);
        if (refreshed) ctx.currentUser = refreshed;
        logger.info({ userId: ctx.currentUser?.id }, "Onboarding advanced to step 4 (after step 3 success)");
        const stepLabel = (s: number) =>
          ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", String(s));
        const text = stepLabel(4) + "\n\n" + ctx.services.i18n.t(locale, "onboarding_step4_intro");
        await ctx.services.navigation.replaceScreen(
          ctx.currentUser!,
          ctx.telegram,
          ctx.chat?.id ?? ctx.currentUser!.telegramUserId,
          { text },
          buildOnboardingStep4Keyboard(locale, ctx.services.i18n)
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
  }
);
