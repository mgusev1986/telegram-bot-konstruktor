import { describe, it, expect, vi } from "vitest";

import { MediaType } from "@prisma/client";
import { BroadcastService } from "../src/modules/broadcasts/broadcast.service";
import { createMockI18n } from "./helpers/mock-i18n";

describe("Broadcast: content language filters recipients", () => {
  it("single localization language restricts recipients to that language", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b1",
          audienceType: "ALL_USERS",
          segmentQuery: {},
          createdByUserId: "admin1",
          status: "DRAFT",
          startedAt: null,
          localizations: [
            {
              languageCode: "ru",
              text: "Hello RU",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            }
          ],
          createdByUser: {
            role: "ADMIN",
            id: "admin1",
            telegramUserId: 1,
            selectedLanguage: "ru"
          }
        }),
        update: vi.fn().mockResolvedValue({})
      },
      broadcastRecipient: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({})
      }
    };

    const segments: any = {
      resolveAudience: vi.fn().mockResolvedValue([
        { id: "u1", telegramUserId: 11, selectedLanguage: "ru", mentorUserId: null, timeZone: null },
        { id: "u2", telegramUserId: 22, selectedLanguage: "en", mentorUserId: null, timeZone: null }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b1", {
      progressEmitEvery: 1,
      progressEmitMinIntervalMs: 0,
      onProgress: vi.fn()
    });

    expect(stats.totalRecipients).toBe(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage.mock.calls[0][0]).toBe(11);
  });

  it("multiple localization languages disable language restriction", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b2",
          audienceType: "ALL_USERS",
          segmentQuery: {},
          createdByUserId: "admin1",
          status: "DRAFT",
          startedAt: null,
          localizations: [
            {
              languageCode: "ru",
              text: "Hello RU",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            },
            {
              languageCode: "en",
              text: "Hello EN",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            }
          ],
          createdByUser: {
            role: "ADMIN",
            id: "admin1",
            telegramUserId: 1,
            selectedLanguage: "ru"
          }
        }),
        update: vi.fn().mockResolvedValue({})
      },
      broadcastRecipient: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({})
      }
    };

    const segments: any = {
      resolveAudience: vi.fn().mockResolvedValue([
        { id: "u1", telegramUserId: 11, selectedLanguage: "ru", mentorUserId: null, timeZone: null },
        { id: "u2", telegramUserId: 22, selectedLanguage: "en", mentorUserId: null, timeZone: null }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b2", {
      progressEmitEvery: 1,
      progressEmitMinIntervalMs: 0,
      onProgress: vi.fn()
    });

    expect(stats.totalRecipients).toBe(2);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });
});

