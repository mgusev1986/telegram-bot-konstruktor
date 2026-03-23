import { describe, expect, it, vi } from "vitest";

import { SubscriptionChannelService } from "../src/modules/subscription-channel/subscription-channel.service";

describe("SubscriptionChannelService", () => {
  it("schedules live reminders in days and test reminders in minutes", async () => {
    const scheduler = {
      schedule: vi.fn().mockResolvedValue(undefined)
    };
    const service = new SubscriptionChannelService({} as any);

    const liveUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await service.scheduleRemindersAndExpiry(
      "access-live",
      liveUntil,
      "bot-1",
      scheduler as any,
      { billingType: "TEMPORARY", durationDays: 30 }
    );

    expect(scheduler.schedule).toHaveBeenCalledWith(
      "SEND_SUBSCRIPTION_REMINDER",
      expect.objectContaining({ accessRightId: "access-live", daysLeft: 3, botInstanceId: "bot-1" }),
      expect.any(Date),
      "sub-rem:access-live:3d"
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(
      "PROCESS_ACCESS_EXPIRY",
      expect.objectContaining({ accessRightId: "access-live", botInstanceId: "bot-1" }),
      liveUntil,
      "access-exp:access-live"
    );

    scheduler.schedule.mockClear();

    const testUntil = new Date(Date.now() + 10 * 60 * 1000);
    await service.scheduleRemindersAndExpiry(
      "access-test",
      testUntil,
      "bot-1",
      scheduler as any,
      { billingType: "TEMPORARY", durationMinutes: 5 }
    );

    expect(scheduler.schedule).toHaveBeenCalledWith(
      "SEND_SUBSCRIPTION_REMINDER",
      expect.objectContaining({ accessRightId: "access-test", minutesLeft: 3, botInstanceId: "bot-1" }),
      expect.any(Date),
      "sub-rem:access-test:3m"
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(
      "SEND_SUBSCRIPTION_REMINDER",
      expect.objectContaining({ accessRightId: "access-test", minutesLeft: 1, botInstanceId: "bot-1" }),
      expect.any(Date),
      "sub-rem:access-test:1m"
    );
  });

  it("fails expiry loudly when linked chats are invite-only and cannot be used for removal", async () => {
    const prisma = {
      userAccessRight: {
        findUnique: vi.fn().mockResolvedValue({
          id: "access-1",
          status: "ACTIVE",
          userId: "user-1",
          productId: "product-1",
          user: {
            id: "user-1",
            selectedLanguage: "ru",
            telegramUserId: 123456n
          },
          product: {
            id: "product-1",
            linkedChats: [{ link: "https://t.me/+secretInvite" }],
            localizations: [{ languageCode: "ru", title: "Тестовый доступ" }]
          }
        }),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const notifications = {
      sendText: vi.fn().mockResolvedValue(undefined)
    };

    const service = new SubscriptionChannelService(prisma as any, notifications as any);
    service.setTelegram({ sendMessage: vi.fn().mockResolvedValue(undefined) } as any);

    await expect(service.processExpiry("access-1")).rejects.toThrow(
      /linkedChats has no identifier entries/i
    );
    expect(prisma.userAccessRight.update).toHaveBeenCalledWith({
      where: { id: "access-1" },
      data: { status: "EXPIRED" }
    });
    expect(notifications.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      "SYSTEM_ALERT",
      expect.stringContaining("Ваш доступ к платному разделу системы истёк"),
      expect.objectContaining({ accessRightId: "access-1", event: "access_expired" })
    );
  });

  it("persists reminder notifications through NotificationService", async () => {
    const prisma = {
      userAccessRight: {
        findUnique: vi.fn().mockResolvedValue({
          id: "access-2",
          status: "ACTIVE",
          userId: "user-2",
          productId: "product-2",
          activeUntil: new Date(Date.now() + 5 * 60 * 1000),
          user: {
            id: "user-2",
            selectedLanguage: "ru",
            telegramUserId: 777n
          },
          product: {
            id: "product-2",
            code: "test-product",
            localizations: [{ languageCode: "ru", title: "Тестовый продукт" }]
          }
        })
      }
    };
    const notifications = {
      sendText: vi.fn().mockResolvedValue(undefined)
    };

    const service = new SubscriptionChannelService(prisma as any, notifications as any);
    await service.sendReminder("access-2", { minutesLeft: 3 });

    expect(notifications.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-2" }),
      "ACCESS_EXPIRING",
      expect.stringContaining("через 3 мин"),
      expect.objectContaining({ accessRightId: "access-2", minutesLeft: 3 })
    );
  });
});
