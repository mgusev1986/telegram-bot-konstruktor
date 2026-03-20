import { describe, expect, it, vi } from "vitest";

import { DripService } from "../src/modules/drip/drip.service";

describe("DripService", () => {
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
});

