import { describe, it, expect, vi } from "vitest";

import { MediaType } from "@prisma/client";
import { BroadcastService } from "../src/modules/broadcasts/broadcast.service";
import { createMockI18n } from "./helpers/mock-i18n";

describe("Broadcast: batch mode treats recipientTimeZone=null as no filtering", () => {
  it("sends to all recipients when recipientTimeZone is null", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b3",
          audienceType: "ALL_USERS",
          segmentQuery: {},
          createdByUserId: "owner1",
          status: "DRAFT",
          startedAt: null,
          localizations: [
            {
              languageCode: "ru",
              text: "RU",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            },
            {
              languageCode: "en",
              text: "EN",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            }
          ],
          createdByUser: {
            role: "ADMIN",
            id: "owner1",
            telegramUserId: 0,
            selectedLanguage: "ru"
          }
        }),
        update: vi.fn().mockResolvedValue({})
      },
      broadcastRecipient: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0)
      },
      user: {
        findMany: vi.fn().mockResolvedValue([])
      }
    };

    const segments: any = {
      resolveAudience: vi.fn().mockResolvedValue([
        { id: "u1", telegramUserId: 11, selectedLanguage: "ru", mentorUserId: null, timeZone: "UTC" },
        { id: "u2", telegramUserId: 22, selectedLanguage: "en", mentorUserId: null, timeZone: "Europe/Warsaw" }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b3", {
      recipientTimeZone: null,
      fallbackTimeZone: "UTC",
      batchMode: true
    });

    expect(stats.totalRecipients).toBe(2);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });
});

