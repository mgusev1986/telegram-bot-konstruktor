import { describe, expect, it, vi } from "vitest";

import { BotRuntimeManager } from "../src/bot/bot-runtime-manager";

describe("BotRuntimeManager deposit notification", () => {
  it("adds 'Оплатить' button for linked product", async () => {
    const manager = new BotRuntimeManager({} as any, {} as any, {} as any);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (manager as any).bots.set("bot-A", {
      botInstanceId: "bot-A",
      bot: { telegram: { sendMessage } },
      services: {}
    });

    await manager.sendDepositConfirmedNotification({
      depositId: "dep-1",
      userId: "user-1",
      botInstanceId: "bot-A",
      telegramUserId: "111",
      selectedLanguage: "ru",
      creditedAmount: 10,
      currency: "USDT",
      productId: "product-1"
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "111",
      expect.stringContaining("Пополнение подтверждено"),
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [[{ text: "Оплатить", callback_data: "pay:balance:product-1" }]]
        }
      })
    );
  });

  it("shows credited and missing amounts for partial top-up", async () => {
    const manager = new BotRuntimeManager(
      {
        depositTransaction: {
          findUnique: vi.fn().mockResolvedValue({
            requestedAmountUsd: 10,
            amount: 10,
            creditedBalanceAmount: 9.5,
            currency: "USDT"
          })
        }
      } as any,
      {} as any,
      {} as any
    );
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (manager as any).bots.set("bot-A", {
      botInstanceId: "bot-A",
      bot: { telegram: { sendMessage } },
      services: {}
    });

    await manager.sendDepositConfirmedNotification({
      depositId: "dep-1",
      userId: "user-1",
      botInstanceId: "bot-A",
      telegramUserId: "111",
      selectedLanguage: "ru",
      creditedAmount: 9.5,
      currency: "USDT",
      productId: "product-1"
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "111",
      expect.stringContaining("доплатите еще 0.50 USDT"),
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [[{ text: "Оплатить", callback_data: "pay:balance:product-1" }]]
        }
      })
    );
  });

  it("uses requestedProductId from deposit rawPayload when productId is missing", async () => {
    const manager = new BotRuntimeManager(
      {
        depositTransaction: {
          findUnique: vi.fn().mockResolvedValue({
            requestedAmountUsd: 10,
            amount: 10,
            creditedBalanceAmount: 10,
            currency: "USDT",
            rawPayload: { requestedProductId: "product-from-raw" }
          })
        }
      } as any,
      {} as any,
      {} as any
    );
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (manager as any).bots.set("bot-A", {
      botInstanceId: "bot-A",
      bot: { telegram: { sendMessage } },
      services: {}
    });

    await manager.sendDepositConfirmedNotification({
      depositId: "dep-2",
      userId: "user-2",
      botInstanceId: "bot-A",
      telegramUserId: "222",
      selectedLanguage: "ru",
      creditedAmount: 10,
      currency: "USDT"
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "222",
      expect.stringContaining("Пополнение подтверждено"),
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [[{ text: "Оплатить", callback_data: "pay:balance:product-from-raw" }]]
        }
      })
    );
  });
});

