import { Markup, Scenes } from "telegraf";

import { logger } from "../../common/logger";
import { readTextMessage } from "../helpers/message-content";
import { makeCallbackData } from "../../common/callback-data";
import {
  buildCancelKeyboard,
  buildNavigationRow,
  NAV_BACK_DATA,
  NAV_ROOT_DATA,
  SCENE_CANCEL_DATA
} from "../keyboards";

export const PARTNER_WITHDRAW_SCENE = "partner-withdraw-scene";

const CONFIRM_DATA = "partner:wd:confirm";
const CANCEL_DATA = "partner:wd:cancel";

interface WizardState {
  address?: string;
  amount?: number;
  currency?: string;
  balance?: number;
  minWithdrawal?: number;
}

function getState(ctx: any): WizardState {
  ctx.wizard.state = ctx.wizard.state || {};
  return ctx.wizard.state as WizardState;
}

export const partnerWithdrawScene = new Scenes.WizardScene<any>(
  PARTNER_WITHDRAW_SCENE,
  // Step 0: ensure program active, load config, ask for address
  async (ctx) => {
    const user = ctx.currentUser;
    const services = ctx.services;
    const locale = services.i18n.resolveLanguage(user?.selectedLanguage);

    if (!user || !user.botInstanceId) {
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_program_disabled"));
      return ctx.scene.leave();
    }

    const cfg = await services.referralCommissions.getConfigForBot(user.botInstanceId);
    if (!cfg || !cfg.enabled) {
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_program_disabled"));
      return ctx.scene.leave();
    }

    const programRow = await services.prisma?.referralProgramConfig.findUnique?.({
      where: { botInstanceId: user.botInstanceId }
    });
    const minWithdrawal = Number(programRow?.minWithdrawalAmount ?? 5);
    const payoutCurrency = String(programRow?.payoutCurrency ?? "usdtbsc").toLowerCase();
    const balance = await services.balance.getBalance(user.id);

    const state = getState(ctx);
    state.currency = payoutCurrency;
    state.minWithdrawal = minWithdrawal;
    state.balance = balance;

    await ctx.reply(
      services.i18n.t(locale, "partner_withdraw_ask_address", { currency: payoutCurrency.toUpperCase() }),
      buildCancelKeyboard(services.i18n, locale)
    );
    return ctx.wizard.next();
  },

  // Step 1: receive address, ask for amount
  async (ctx, next) => {
    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === SCENE_CANCEL_DATA) {
        if (ctx.scene?.current) await ctx.scene.leave();
        return next();
      }
      return;
    }

    const services = ctx.services;
    const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const state = getState(ctx);
    const address = readTextMessage(ctx).trim();

    if (!address || address.length < 10) {
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_invalid_address"));
      return;
    }
    state.address = address;

    const balance = state.balance ?? 0;
    const min = state.minWithdrawal ?? 0;

    await ctx.reply(
      services.i18n.t(locale, "partner_withdraw_ask_amount", {
        balance: balance.toFixed(2),
        min: min.toFixed(2)
      }),
      buildCancelKeyboard(services.i18n, locale)
    );
    return ctx.wizard.next();
  },

  // Step 2: receive amount, show confirm
  async (ctx, next) => {
    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === NAV_ROOT_DATA || data === NAV_BACK_DATA || data === SCENE_CANCEL_DATA) {
        if (ctx.scene?.current) await ctx.scene.leave();
        return next();
      }
      return;
    }

    const services = ctx.services;
    const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const state = getState(ctx);
    const raw = readTextMessage(ctx).trim().replace(",", ".");
    const amount = Number(raw);

    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_invalid_amount"));
      return;
    }

    const min = state.minWithdrawal ?? 0;
    if (amount < min) {
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_below_min", { min: min.toFixed(2) }));
      return;
    }

    state.amount = amount;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(services.i18n.t(locale, "partner_withdraw_confirm_btn"), CONFIRM_DATA)],
      [Markup.button.callback(services.i18n.t(locale, "partner_withdraw_cancel_btn"), CANCEL_DATA)]
    ]);
    await ctx.reply(
      services.i18n.t(locale, "partner_withdraw_confirm", {
        amount: amount.toFixed(2),
        address: state.address ?? "",
        currency: (state.currency ?? "usdtbsc").toUpperCase()
      }),
      kb
    );
    return ctx.wizard.next();
  },

  // Step 3: await confirmation callback
  async (ctx, next) => {
    if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
    const data = ctx.callbackQuery.data;
    const services = ctx.services;
    const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);

    if (data === CANCEL_DATA || data === SCENE_CANCEL_DATA || data === NAV_BACK_DATA || data === NAV_ROOT_DATA) {
      try {
        await ctx.answerCbQuery();
      } catch {
        // ignore
      }
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_cancelled"));
      if (ctx.scene?.current) await ctx.scene.leave();
      return next();
    }

    if (data !== CONFIRM_DATA) return;

    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore
    }

    const state = getState(ctx);
    const user = ctx.currentUser;
    if (!user || !state.address || !state.amount) {
      await ctx.reply(services.i18n.t(locale, "partner_withdraw_error_generic"));
      return ctx.scene.leave();
    }

    const result = await services.userWithdrawals.requestWithdrawal({
      userId: user.id,
      botInstanceId: user.botInstanceId,
      amount: state.amount,
      payoutAddress: state.address,
      payoutCurrency: state.currency
    });

    if (!result.ok) {
      const keyMap: Record<string, string> = {
        invalid_address: "partner_withdraw_invalid_address",
        invalid_amount: "partner_withdraw_invalid_amount",
        below_minimum: "partner_withdraw_below_min",
        insufficient_balance: "partner_withdraw_insufficient",
        pending_exists: "partner_withdraw_pending_exists",
        program_disabled: "partner_withdraw_program_disabled",
        unknown_bot: "partner_withdraw_program_disabled"
      };
      const msgKey = keyMap[result.error] ?? "partner_withdraw_error_generic";
      const args = result.error === "below_minimum" && result.message
        ? { min: Number(result.message).toFixed(2) }
        : {};
      await ctx.reply(services.i18n.t(locale, msgKey, args as any));
      return ctx.scene.leave();
    }

    const statusKey =
      result.status === "SENT" ? "partner_withdraw_submitted_sent" : "partner_withdraw_submitted_pending";
    const navBtns = buildNavigationRow(services.i18n, locale, { back: true, toMain: true });
    const kb = Markup.inlineKeyboard(navBtns.map((btn) => [btn]));
    await ctx.reply(services.i18n.t(locale, statusKey), kb);

    logger.info(
      { userId: user.id, withdrawalId: result.withdrawalId, status: result.status },
      "Partner withdrawal created from scene"
    );

    return ctx.scene.leave();
  }
);
