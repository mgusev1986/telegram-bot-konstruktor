import { describe, it, expect, vi } from "vitest";

import { MediaType } from "@prisma/client";
import { BroadcastService } from "../src/modules/broadcasts/broadcast.service";
import { createMockI18n } from "./helpers/mock-i18n";

describe("Broadcast: OWNER verification recipient injection", () => {
  it("injects OWNER into recipients when OWNER is not in audience", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b1",
          audienceType: "OWN_FIRST_LINE",
          segmentQuery: {},
          createdByUserId: "owner1",
          status: "DRAFT",
          localizations: [
            {
              languageCode: "ru",
              text: "<b>Hello</b>",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            }
          ],
          createdByUser: {
            id: "owner1",
            role: "OWNER",
            telegramUserId: 999,
            selectedLanguage: "ru",
            timeZone: null
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
        {
          id: "u1",
          telegramUserId: 1,
          selectedLanguage: "ru",
          timeZone: null
        }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b1", {
      progressEmitEvery: 1,
      progressEmitMinIntervalMs: 200,
      onProgress: vi.fn()
    });

    expect(stats.totalRecipients).toBe(2); // u1 + injected owner1
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage.mock.calls.some((c: any[]) => c[0] === 999)).toBe(true); // chatId == owner telegram id
  });

  it("does not duplicate OWNER if already present in audience", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b2",
          audienceType: "ALL_USERS",
          segmentQuery: {},
          createdByUserId: "owner1",
          status: "DRAFT",
          localizations: [
            {
              languageCode: "ru",
              text: "Hi",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            }
          ],
          createdByUser: {
            id: "owner1",
            role: "OWNER",
            telegramUserId: 999,
            selectedLanguage: "ru",
            timeZone: null
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
        {
          id: "owner1",
          telegramUserId: 999,
          selectedLanguage: "ru",
          timeZone: null
        }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 })
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b2", {
      progressEmitEvery: 1,
      progressEmitMinIntervalMs: 200
    });

    expect(stats.totalRecipients).toBe(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });
});

