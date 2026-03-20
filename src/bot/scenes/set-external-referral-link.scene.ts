import { Markup, Scenes } from "telegraf";

import { logger } from "../../common/logger";
import { readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import { buildCancelKeyboard, buildNavigationRow, NAV_BACK_DATA, NAV_ROOT_DATA, SCENE_CANCEL_DATA } from "../keyboards";

export const SET_EXTERNAL_REFERRAL_LINK_SCENE = "set-external-referral-link-scene";

function normalizeExternalReferralUrl(raw: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null;
  try {
    const u = new URL(trimmed);
    if (!u.hostname) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export const setExternalReferralLinkScene = new Scenes.WizardScene<any>(
  SET_EXTERNAL_REFERRAL_LINK_SCENE,
  async (ctx) => {
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    await ctx.reply(
      ctx.services.i18n.t(locale, "external_ref_link_prompt"),
      buildCancelKeyboard(ctx.services.i18n, locale)
    );
    return ctx.wizard.next();
  },
  async (ctx, next) => {
    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === SCENE_CANCEL_DATA) {
        if (ctx.scene?.current) await ctx.scene.leave();
        return next();
      }
      return;
    }

    const input = readTextMessage(ctx).trim();
    const normalized = normalizeExternalReferralUrl(input);
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);

    if (!ctx.currentUser || !normalized) {
      await ctx.reply(ctx.services.i18n.t(locale, "error_invalid_url"));
      return;
    }

    try {
      const saved = await ctx.services.cabinet.upsertExternalReferralLink(ctx.currentUser.id, normalized);
      const refreshed = await ctx.services.users.findById(ctx.currentUser.id);
      if (refreshed) ctx.currentUser = refreshed;

      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
      const navBtns = buildNavigationRow(ctx.services.i18n, locale, { back: true, toMain: true });
      const kb = Markup.inlineKeyboard(navBtns.map((btn) => [btn]));

      await ctx.reply(
        ctx.services.i18n.t(locale, "external_ref_link_saved", { url: saved }),
        kb
      );
    } catch (err) {
      logger.error({ userId: ctx.currentUser?.id, err }, "upsertExternalReferralLink failed");
      await ctx.reply(ctx.services.i18n.t(locale, "error_invalid_url"));
      return;
    }

    return ctx.scene.leave();
  }
);

