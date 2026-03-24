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
});

