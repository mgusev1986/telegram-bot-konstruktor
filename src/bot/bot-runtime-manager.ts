import type { PrismaClient } from "@prisma/client";
import type { ConnectionOptions } from "bullmq";
import type { Telegraf } from "telegraf";
import { Telegraf as TelegrafCtor } from "telegraf";

import { env } from "../config/env";
import { logger } from "../common/logger";
import type { AppServices } from "../app/services";
import { buildServices, type OnDepositCreditedFn } from "../app/services";
import { decryptTelegramBotToken } from "../common/telegram-token-encryption";
import { makeCallbackData } from "../common/callback-data";
import { registerBot } from "./register-bot";
import type { BotContext } from "./context";

export interface BotRuntime {
  botInstanceId: string;
  bot: Telegraf<BotContext>;
  services: AppServices;
}

export class BotRuntimeManager {
  private readonly bots = new Map<string, BotRuntime>();

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: import("ioredis").default,
    private readonly bullConnection: ConnectionOptions
  ) {}

  public async startBotInstance(botInstanceId: string, opts?: { launch?: boolean }): Promise<BotRuntime> {
    const existing = this.bots.get(botInstanceId);
    if (existing) return existing;

    const botInstance = await this.prisma.botInstance.findUniqueOrThrow({
      where: { id: botInstanceId }
    });

    const canBeLaunched = botInstance.status === "ACTIVE" && !botInstance.isArchived;

    const botToken = decryptTelegramBotToken(botInstance.telegramBotTokenEncrypted, env.BOT_TOKEN_ENCRYPTION_KEY);

    const onDepositCredited: OnDepositCreditedFn = (params) =>
      this.sendDepositConfirmedNotification(params);

    const services = buildServices(this.prisma, this.redis, this.bullConnection, {
      botInstanceId: botInstance.id,
      botUsername: botInstance.telegramBotUsername ?? env.BOT_USERNAME,
      paidAccessEnabled: botInstance.paidAccessEnabled,
      onDepositCredited
    });

    const bot = registerBot(services, { botToken });

    // Telegram-specific integrations (e.g. notifications / drips / broadcasts).
    services.notifications.setTelegram(bot.telegram);
    services.broadcasts.setTelegram(bot.telegram);
    services.drips.setTelegram(bot.telegram);
    services.inactivityReminders.setTelegram(bot.telegram);
    services.subscriptionChannel.setTelegram(bot.telegram);

    const runtime: BotRuntime = { botInstanceId, bot, services };
    this.bots.set(botInstanceId, runtime);

    const shouldLaunch = opts?.launch ?? true;
    if (shouldLaunch && canBeLaunched) {
      logger.info({ botInstanceId, username: botInstance.telegramBotUsername }, "Connecting to Telegram...");
      try {
        bot.botInfo = await bot.telegram.getMe();
      } catch (error) {
        this.bots.delete(botInstanceId);
        throw error;
      }

      void bot
        .launch(() => {
          logger.info({ botInstanceId, username: botInstance.telegramBotUsername }, "Telegram polling started");
        })
        .catch((error) => {
          logger.error(
            {
              botInstanceId,
              username: botInstance.telegramBotUsername,
              err: error
            },
            "Telegram polling crashed"
          );
        });
    }
    return runtime;
  }

  /** Returns runtime by bot instance id, or undefined if not running. */
  public getRuntime(botInstanceId: string): BotRuntime | undefined {
    return this.bots.get(botInstanceId);
  }

  /**
   * Send deposit confirmed notification via the bot that created the deposit (deposit.botInstanceId).
   * Critical for multi-bot: same Telegram user can be in multiple bots; notification must go to the
   * bot where the invoice was created, not to primary/last-active bot.
   */
  public async sendDepositConfirmedNotification(params: {
    depositId: string;
    userId: string;
    botInstanceId: string | null;
    telegramUserId: string;
    selectedLanguage: string;
    creditedAmount: number;
    currency: string;
    productId?: string;
  }): Promise<void> {
    const { depositId, botInstanceId, telegramUserId, selectedLanguage, creditedAmount, currency, productId } = params;

    const runtime = botInstanceId
      ? this.bots.get(botInstanceId)
      : this.getFirstRuntime();

    if (!runtime) {
      logger.warn(
        { depositId, botInstanceId, resolvedBotInstanceId: null },
        "Deposit notification skipped: no runtime for deposit.botInstanceId"
      );
      return;
    }

    const text =
      selectedLanguage === "en"
        ? `Deposit confirmed. ${creditedAmount} ${currency} credited to your balance.`
        : `Пополнение подтверждено. ${creditedAmount} ${currency} зачислено на баланс.`;
    const payButtonText = selectedLanguage === "en" ? "Pay" : "Оплатить";
    const replyMarkup =
      productId && productId.trim()
        ? {
            inline_keyboard: [
              [{ text: payButtonText, callback_data: makeCallbackData("pay", "balance", productId.trim()) }]
            ]
          }
        : undefined;

    try {
      await runtime.bot.telegram.sendMessage(telegramUserId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
      logger.info(
        {
          depositId,
          userId: params.userId,
          depositBotInstanceId: botInstanceId,
          resolvedBotInstanceId: runtime.botInstanceId,
          productId: productId ?? null
        },
        "Deposit notification sent to correct bot"
      );
    } catch (err) {
      logger.warn(
        { depositId, botInstanceId, resolvedBotInstanceId: runtime.botInstanceId, err },
        "Deposit notification send failed"
      );
      throw err;
    }
  }

  /** Returns all currently running bot runtimes. */
  public getAllRuntimes(): BotRuntime[] {
    return Array.from(this.bots.values());
  }

  /** Returns count of successfully started bots. */
  public getRunningCount(): number {
    return this.bots.size;
  }

  public async startAllActiveBots(): Promise<BotRuntime[]> {
    const active = await this.prisma.botInstance.findMany({
      where: { status: "ACTIVE", isArchived: false },
      orderBy: { createdAt: "asc" }
    });

    const runtimes: BotRuntime[] = [];
    for (const b of active) {
      const rt = await this.startBotInstance(b.id);
      runtimes.push(rt);
    }
    return runtimes;
  }

  public async stopAll(signal: string): Promise<void> {
    for (const [, runtime] of this.bots) {
      try {
        runtime.bot.stop(signal as any);
      } catch {
        // ignore
      }
    }
  }

  public async stopBotInstance(botInstanceId: string, signal: string = "SIGTERM"): Promise<void> {
    const runtime = this.bots.get(botInstanceId);
    if (!runtime) return;
    try {
      runtime.bot.stop(signal as any);
    } catch {
      // ignore
    }
    this.bots.delete(botInstanceId);
  }

  public async restartBotInstance(botInstanceId: string): Promise<void> {
    await this.stopBotInstance(botInstanceId);
    // Will re-check status/isArchived in startBotInstance.
    await this.startBotInstance(botInstanceId, { launch: true });
  }

  public getFirstRuntime(): BotRuntime | undefined {
    return this.bots.values().next().value;
  }

  /**
   * Creates a lightweight Telegram client for a bot token.
   * Used for future job routing / API calls without launching polling.
   */
  public createTelegramClientForBotToken(botToken: string): TelegrafCtor<BotContext> {
    return new TelegrafCtor<BotContext>(botToken);
  }
}
