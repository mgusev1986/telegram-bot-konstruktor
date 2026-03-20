import { Scenes } from "telegraf";

import { makeCallbackData } from "../../common/callback-data";
import { readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import { buildSceneCancelBackKeyboard, buildReturnToButtonManagementKeyboard } from "../keyboards";

const PAGE_EDIT_PREFIX = "page_edit";

export const RENAME_BUTTON_SCENE = "rename-button-scene";

type SceneState = {
  itemId?: string;
  fromPageId?: string;
  languageCode?: string;
  uiLanguageCode?: string;
};

function getLocale(ctx: BotContext, state?: SceneState): string {
  return ctx.services.i18n.resolveLanguage(state?.uiLanguageCode ?? ctx.currentUser?.selectedLanguage);
}

export const renameButtonScene = new Scenes.WizardScene<any>(
  RENAME_BUTTON_SCENE,
  async (ctx) => {
    const sceneState = ctx.scene.state as SceneState;
    (ctx.wizard.state as SceneState).itemId = sceneState.itemId;
    (ctx.wizard.state as SceneState).fromPageId = sceneState.fromPageId ?? "root";
    (ctx.wizard.state as SceneState).languageCode = sceneState.languageCode;
    (ctx.wizard.state as SceneState).uiLanguageCode = sceneState.uiLanguageCode;
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);
    const backData = makeCallbackData(PAGE_EDIT_PREFIX, "open_buttons", state.fromPageId ?? "root");

    await ctx.reply(
      ctx.services.i18n.t(locale, "send_new_title"),
      buildSceneCancelBackKeyboard(ctx.services.i18n, locale, backData)
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);
    const title = readTextMessage(ctx).trim();
    if (!title || !state.itemId || !ctx.currentUser) {
      await ctx.reply(
        ctx.services.i18n.t(locale, "send_new_title"),
        buildSceneCancelBackKeyboard(
          ctx.services.i18n,
          locale,
          makeCallbackData(PAGE_EDIT_PREFIX, "open_buttons", state.fromPageId ?? "root")
        )
      );
      return;
    }
    try {
      await ctx.services.menu.updateMenuItemTitle(
        state.itemId,
        ctx.services.i18n.normalizeLocalizationLanguageCode(state.languageCode ?? ctx.currentUser.selectedLanguage ?? locale),
        title,
        ctx.currentUser.id
      );
      const fromPageId = state.fromPageId ?? "root";
      await ctx.reply(
        ctx.services.i18n.t(locale, "button_renamed"),
        buildReturnToButtonManagementKeyboard(fromPageId, ctx.services.i18n, locale)
      );
    } catch (err) {
      await ctx.reply(
        ctx.services.i18n.t(locale, "error_save_step"),
        buildSceneCancelBackKeyboard(
          ctx.services.i18n,
          locale,
          makeCallbackData(PAGE_EDIT_PREFIX, "open_buttons", state.fromPageId ?? "root")
        )
      );
      return;
    }
    return ctx.scene.leave();
  }
);
