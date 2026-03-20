import { describe, it, expect, vi } from "vitest";

import { MediaType } from "@prisma/client";
import { BroadcastService } from "../src/modules/broadcasts/broadcast.service";
import { createMockI18n } from "./helpers/mock-i18n";

describe("Broadcast: live progress stats", () => {
  it("counts success/failed and emits progress updates", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b1",
          audienceType: "ALL_USERS",
          segmentQuery: {},
          createdByUserId: "admin1",
          localizations: [
            {
              languageCode: "ru",
              text: "Hello",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null
            }
          ]
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
          firstName: "Иван",
          lastName: null,
          username: "user1",
          fullName: null
        },
        {
          id: "u2",
          telegramUserId: 2,
          selectedLanguage: "ru",
          firstName: "Петр",
          lastName: null,
          username: "user2",
          fullName: null
        }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockImplementation((chatId: number) => {
        if (chatId === 2) {
          throw new Error("blocked");
        }
        return { message_id: 1 };
      }),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideoNote: vi.fn()
    };

    const progress: any[] = [];
    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const finalStats = await service.dispatchBroadcast("b1", {
      onProgress: (s: any) => progress.push(s),
      progressEmitEvery: 1,
      progressEmitMinIntervalMs: 0
    });

    expect(finalStats.totalRecipients).toBe(2);
    expect(finalStats.successCount).toBe(1);
    expect(finalStats.failedCount).toBe(1);
    expect(finalStats.pendingCount).toBe(0);

    // initial emit + after recipient #1 + after recipient #2
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0].totalRecipients).toBe(2);
  });
});

