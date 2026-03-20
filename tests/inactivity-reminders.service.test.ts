import { describe, expect, it, vi } from "vitest";

import { InactivityReminderService } from "../src/modules/inactivity-reminders/inactivity-reminder.service";
import { env } from "../src/config/env";

describe("InactivityReminderService", () => {
  it("scheduleForPageOpen schedules a job when no pending state exists", async () => {
    const prisma = {
      inactivityReminderRule: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          isActive: true,
          delayMinutes: 45,
          targetMenuItemId: "m1",
          template: { id: "t1", isActive: true }
        })
      },
      userInactivityReminderState: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "s1",
          userId: "u1",
          ruleId: "r1",
          triggerPageId: "p1",
          targetMenuItemId: "m1",
          status: "PENDING"
        }),
        update: vi.fn().mockResolvedValue({})
      }
    } as any;

    const scheduler = {
      schedule: vi.fn().mockResolvedValue({ id: "job1" }),
      cancelScheduledJobById: vi.fn()
    } as any;

    const service = new InactivityReminderService(prisma, scheduler);

    await service.scheduleForPageOpen(
      { id: "u1", telegramUserId: 1, selectedLanguage: "ru" } as any,
      "p1",
      { shouldSchedule: true }
    );

    expect(prisma.inactivityReminderRule.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.userInactivityReminderState.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.userInactivityReminderState.create).toHaveBeenCalledTimes(1);

    expect(scheduler.schedule).toHaveBeenCalledWith(
      "SEND_INACTIVITY_REMINDER",
      { reminderStateId: "s1" },
      expect.any(Date),
      "inact:s1"
    );

    expect(prisma.userInactivityReminderState.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { schedulerJobId: "job1" }
    });
  });

  it("scheduleForPageOpen is idempotent when a pending state exists", async () => {
    const prisma = {
      inactivityReminderRule: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          isActive: true,
          delayMinutes: 45,
          targetMenuItemId: "m1",
          template: { id: "t1", isActive: true }
        })
      },
      userInactivityReminderState: {
        findUnique: vi.fn().mockResolvedValue({ id: "existing" }),
        create: vi.fn(),
        update: vi.fn()
      }
    } as any;

    const scheduler = {
      schedule: vi.fn().mockResolvedValue({ id: "job1" }),
      cancelScheduledJobById: vi.fn()
    } as any;

    const service = new InactivityReminderService(prisma, scheduler);

    await service.scheduleForPageOpen(
      { id: "u1", telegramUserId: 1, selectedLanguage: "ru" } as any,
      "p1",
      { shouldSchedule: true }
    );

    expect(prisma.userInactivityReminderState.create).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it("cancelPendingForUserExcept cancels pending states except keep triggerPageId", async () => {
    const prisma = {
      userInactivityReminderState: {
        // Prisma should already apply `triggerPageId: { not: keep-me }`
        findMany: vi.fn().mockResolvedValue([{ id: "s2", schedulerJobId: "job2", triggerPageId: "cancel-me" }]),
        update: vi.fn().mockResolvedValue({})
      }
    } as any;

    const scheduler = {
      cancelScheduledJobById: vi.fn().mockResolvedValue(true),
      schedule: vi.fn()
    } as any;

    const service = new InactivityReminderService(prisma, scheduler);

    const cancelled = await service.cancelPendingForUserExcept("u1", "keep-me");

    expect(cancelled).toBe(1);
    expect(scheduler.cancelScheduledJobById).toHaveBeenCalledTimes(1);
    expect(scheduler.cancelScheduledJobById).toHaveBeenCalledWith("job2");
    expect(prisma.userInactivityReminderState.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s2" } })
    );
  });

  it("processScheduledReminderState sends message and marks SENT (ctaTargetType ROOT)", async () => {
    const telegram = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    } as any;

    const prisma = {
      userInactivityReminderState: {
        findUnique: vi.fn().mockResolvedValue({
          id: "s1",
          status: "PENDING",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          userId: "u1",
          triggerPageId: "p1",
          targetMenuItemId: "m1",
          user: { telegramUserId: 123, selectedLanguage: "ru", first_name: "Ivan" },
          rule: {
            id: "r1",
            isActive: true,
            delayMinutes: 45,
            targetMenuItemId: "m1",
            triggerPageId: "p1",
            ctaLabel: "Далее",
            ctaTargetType: "ROOT",
            template: { text: "TEST TEMPLATE TEXT" }
          }
        }),
        update: vi.fn().mockResolvedValue({})
      },
      buttonClickEvent: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    } as any;

    const scheduler = { schedule: vi.fn(), cancelScheduledJobById: vi.fn() } as any;
    const service = new InactivityReminderService(prisma, scheduler);
    service.setTelegram(telegram);

    await service.processScheduledReminderState("s1");

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(123, "TEST TEMPLATE TEXT", expect.any(Object));
    expect(prisma.userInactivityReminderState.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { status: "SENT", sentAt: expect.any(Date) }
    });
  });

  it("processScheduledReminderState cancels (does not send) when clickedTarget exists", async () => {
    const telegram = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    } as any;

    const prisma = {
      userInactivityReminderState: {
        findUnique: vi.fn().mockResolvedValue({
          id: "s1",
          status: "PENDING",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          userId: "u1",
          triggerPageId: "p1",
          targetMenuItemId: "m1",
          user: { telegramUserId: 123, selectedLanguage: "ru", first_name: "Ivan" },
          rule: {
            id: "r1",
            isActive: true,
            delayMinutes: 45,
            targetMenuItemId: "m1",
            triggerPageId: "p1",
            ctaLabel: "Далее",
            ctaTargetType: "ROOT",
            template: { text: "TEST TEMPLATE TEXT" }
          }
        }),
        update: vi.fn().mockResolvedValue({})
      },
      buttonClickEvent: {
        findFirst: vi.fn().mockResolvedValue({ id: "clicked" })
      }
    } as any;

    const scheduler = { schedule: vi.fn(), cancelScheduledJobById: vi.fn() } as any;
    const service = new InactivityReminderService(prisma, scheduler);
    service.setTelegram(telegram);

    await service.processScheduledReminderState("s1");

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(prisma.userInactivityReminderState.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) }
    });
  });

  it("getTemplatesByCategory falls back to DEFAULT_LANGUAGE when primary is empty", async () => {
    const fallbackLang = String(env.DEFAULT_LANGUAGE ?? "ru").toLowerCase();
    const primaryLang = fallbackLang === "ru" ? "en" : "ru";

    const fallbackTemplate = {
      id: "t_fallback",
      key: "k_fallback",
      category: "SOFT",
      title: "Fallback title",
      text: "Fallback text",
      defaultCtaLabel: "Next",
      isActive: true,
      sortOrder: 1,
      languageCode: fallbackLang,
      createdAt: new Date(),
      updatedAt: new Date()
    } as any;

    const prisma = {
      reminderTemplate: {
        findMany: vi.fn().mockImplementation(async (args: any) => {
          const lang = String(args?.where?.languageCode ?? "").toLowerCase();
          if (lang === primaryLang) return [];
          if (lang === fallbackLang) return [fallbackTemplate];
          return [];
        })
      }
    } as any;

    const scheduler = {} as any;
    const service = new InactivityReminderService(prisma, scheduler);

    const res = await service.getTemplatesByCategory({ languageCode: primaryLang, category: "SOFT" });
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("t_fallback");

    // Ensure 2 queries: primary + fallback.
    expect(prisma.reminderTemplate.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.reminderTemplate.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ languageCode: primaryLang, category: "SOFT" })
      })
    );
    expect(prisma.reminderTemplate.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ languageCode: fallbackLang, category: "SOFT" })
      })
    );
  });
});

