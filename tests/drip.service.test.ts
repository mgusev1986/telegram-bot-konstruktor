import { MediaType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { DripService } from "../src/modules/drip/drip.service";

describe("DripService", () => {
  it("appendStep stores follow-up text for a two-message drip step", async () => {
    const prisma = {
      dripCampaign: {
        findFirst: vi.fn().mockResolvedValue({
          id: "c1",
          steps: []
        })
      },
      dripStep: {
        create: vi.fn().mockResolvedValue({ id: "s1", localizations: [] })
      }
    } as any;

    const scheduler = {} as any;
    const i18n = { pickLocalized: vi.fn() } as any;
    const audit = { log: vi.fn() } as any;

    const service = new DripService(prisma, scheduler, i18n, audit);

    await service.appendStep("admin1", "c1", {
      languageCode: "ru",
      delayValue: 1,
      delayUnit: "DAYS",
      text: "",
      followUpText: "Отдельный текст",
      mediaType: MediaType.VIDEO,
      mediaFileId: "video-1"
    });

    expect(prisma.dripStep.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        localizations: {
          create: expect.objectContaining({
            text: "",
            followUpText: "Отдельный текст",
            mediaType: MediaType.VIDEO,
            mediaFileId: "video-1"
          })
        }
      }),
      include: { localizations: true }
    });
  });

  it("enrollUser schedules first step idempotently per progress", async () => {
    const prisma = {
      dripCampaign: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "c1",
            isActive: true,
            triggerType: "ON_REGISTRATION",
            steps: [{ stepOrder: 1, delayValue: 1, delayUnit: "MINUTES" }]
          }
        ])
      },
      userDripProgress: {
        upsert: vi.fn().mockResolvedValue({
          id: "p1",
          currentStep: 1
        })
      }
    } as any;

    const scheduler = {
      schedule: vi.fn().mockResolvedValue({ id: "sj1" })
    } as any;

    const i18n = {
      pickLocalized: vi.fn()
    } as any;

    const audit = {
      log: vi.fn()
    } as any;

    const service = new DripService(prisma, scheduler, i18n, audit);

    await service.enrollUser("u1", "ON_REGISTRATION" as any);

    expect(prisma.userDripProgress.upsert).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule.mock.calls[0][0]).toBe("SEND_DRIP_STEP");
    expect(scheduler.schedule.mock.calls[0][1]).toEqual({ progressId: "p1" });
    expect(scheduler.schedule.mock.calls[0][3]).toBe("drip:p1:1");
    expect(scheduler.schedule.mock.calls[0][2]).toBeInstanceOf(Date);
  });

  it("processProgress sends step and schedules next, then completes", async () => {
    const prisma = {
      userDripProgress: {
        findUniqueOrThrow: vi.fn(),
        update: vi.fn()
      }
    } as any;

    const scheduler = {
      schedule: vi.fn().mockResolvedValue({ id: "sj2" })
    } as any;

    const i18n = {
      pickLocalized: vi.fn().mockImplementation((locs: any[]) => locs[0] ?? null)
    } as any;

    const audit = { log: vi.fn() } as any;

    const service = new DripService(prisma, scheduler, i18n, audit);

    const telegram = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    } as any;
    service.setTelegram(telegram);

    prisma.userDripProgress.findUniqueOrThrow.mockResolvedValueOnce({
      id: "p2",
      status: "ACTIVE",
      currentStep: 1,
      user: {
        telegramUserId: 123,
        selectedLanguage: "ru",
        first_name: "Ivan"
      },
      campaign: {
        steps: [
          {
            stepOrder: 1,
            delayValue: 1,
            delayUnit: "MINUTES",
            localizations: [{ languageCode: "ru", text: "TEST DRIP STEP 1", mediaType: "NONE", mediaFileId: null, externalUrl: null }]
          },
          {
            stepOrder: 2,
            delayValue: 1,
            delayUnit: "MINUTES",
            localizations: [{ languageCode: "ru", text: "TEST DRIP STEP 2", mediaType: "NONE", mediaFileId: null, externalUrl: null }]
          }
        ]
      }
    });

    await service.processProgress("p2");

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.userDripProgress.update).toHaveBeenCalledWith({
      where: { id: "p2" },
      data: expect.objectContaining({ currentStep: 2, nextRunAt: expect.any(Date) })
    });
    expect(scheduler.schedule).toHaveBeenCalledWith(
      "SEND_DRIP_STEP",
      { progressId: "p2" },
      expect.any(Date),
      "drip:p2:2"
    );

    // Now emulate that step 2 is last -> completion
    prisma.userDripProgress.findUniqueOrThrow.mockResolvedValueOnce({
      id: "p2",
      status: "ACTIVE",
      currentStep: 2,
      user: {
        telegramUserId: 123,
        selectedLanguage: "ru",
        first_name: "Ivan"
      },
      campaign: {
        steps: [
          {
            stepOrder: 2,
            delayValue: 1,
            delayUnit: "MINUTES",
            localizations: [{ languageCode: "ru", text: "TEST DRIP STEP 2", mediaType: "NONE", mediaFileId: null, externalUrl: null }]
          }
        ]
      }
    });

    await service.processProgress("p2");

    expect(prisma.userDripProgress.update).toHaveBeenCalledWith({
      where: { id: "p2" },
      data: expect.objectContaining({ status: "COMPLETED", completedAt: expect.any(Date), nextRunAt: null })
    });
  });

  it("processProgress sends media first and follow-up text second for a drip step", async () => {
    const prisma = {
      userDripProgress: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "p3",
          status: "ACTIVE",
          currentStep: 1,
          user: {
            telegramUserId: 321,
            selectedLanguage: "ru",
            first_name: "Ivan"
          },
          campaign: {
            steps: [
              {
                stepOrder: 1,
                delayValue: 1,
                delayUnit: "MINUTES",
                localizations: [{
                  languageCode: "ru",
                  text: "",
                  followUpText: "Текст после видео",
                  mediaType: MediaType.VIDEO,
                  mediaFileId: "video-1",
                  externalUrl: null
                }]
              },
              {
                stepOrder: 2,
                delayValue: 1,
                delayUnit: "MINUTES",
                localizations: [{ languageCode: "ru", text: "STEP 2", followUpText: "", mediaType: "NONE", mediaFileId: null, externalUrl: null }]
              }
            ]
          }
        }),
        update: vi.fn()
      }
    } as any;

    const scheduler = {
      schedule: vi.fn().mockResolvedValue({ id: "sj3" })
    } as any;

    const i18n = {
      pickLocalized: vi.fn().mockImplementation((locs: any[]) => locs[0] ?? null)
    } as any;

    const audit = { log: vi.fn() } as any;
    const service = new DripService(prisma, scheduler, i18n, audit);

    const calls: string[] = [];
    const telegram = {
      sendVideo: vi.fn().mockImplementation(async () => {
        calls.push("sendVideo");
        return { message_id: 1 };
      }),
      sendMessage: vi.fn().mockImplementation(async () => {
        calls.push("sendMessage");
        return { message_id: 2 };
      })
    } as any;
    service.setTelegram(telegram);

    await service.processProgress("p3");

    expect(calls).toEqual(["sendVideo", "sendMessage"]);
    expect(prisma.userDripProgress.update).toHaveBeenCalledWith({
      where: { id: "p3" },
      data: expect.objectContaining({ currentStep: 2, nextRunAt: expect.any(Date) })
    });
  });

  it("does not advance drip progress when follow-up text fails after media succeeds", async () => {
    const prisma = {
      userDripProgress: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "p4",
          status: "ACTIVE",
          currentStep: 1,
          user: {
            telegramUserId: 654,
            selectedLanguage: "ru",
            first_name: "Ivan"
          },
          campaign: {
            steps: [
              {
                stepOrder: 1,
                delayValue: 1,
                delayUnit: "MINUTES",
                localizations: [{
                  languageCode: "ru",
                  text: "",
                  followUpText: "Текст после кружка",
                  mediaType: MediaType.VIDEO_NOTE,
                  mediaFileId: "note-1",
                  externalUrl: null
                }]
              }
            ]
          }
        }),
        update: vi.fn()
      }
    } as any;

    const scheduler = {
      schedule: vi.fn()
    } as any;

    const i18n = {
      pickLocalized: vi.fn().mockImplementation((locs: any[]) => locs[0] ?? null)
    } as any;

    const audit = { log: vi.fn() } as any;
    const service = new DripService(prisma, scheduler, i18n, audit);

    const telegram = {
      sendVideoNote: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendMessage: vi.fn().mockRejectedValue(new Error("chat is blocked"))
    } as any;
    service.setTelegram(telegram);

    await expect(service.processProgress("p4")).rejects.toThrow("follow-up text failed");
    expect(prisma.userDripProgress.update).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});
