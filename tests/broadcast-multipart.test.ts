import { MediaType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { BroadcastService } from "../src/modules/broadcasts/broadcast.service";
import { createMockI18n } from "./helpers/mock-i18n";

const buildRecipient = () => ({
  id: "u1",
  telegramUserId: 101,
  selectedLanguage: "ru",
  firstName: "Ivan",
  lastName: null,
  username: "user1",
  fullName: null,
  timeZone: null,
  mentorUserId: null
});

const buildPrisma = (localization: any, status: any = "DRAFT") =>
  ({
    broadcast: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "b1",
        audienceType: "ALL_USERS",
        segmentQuery: {},
        createdByUserId: "admin1",
        status,
        localizations: [localization],
        createdByUser: {
          id: "admin1",
          role: "ADMIN"
        }
      }),
      update: vi.fn().mockResolvedValue({})
    },
    broadcastRecipient: {
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({})
    },
    user: {
      findMany: vi.fn().mockResolvedValue([])
    }
  }) as any;

describe("Broadcast multipart delivery", () => {
  it("stores follow-up text when creating a broadcast", async () => {
    const prisma: any = {
      broadcast: {
        create: vi.fn().mockResolvedValue({ id: "b-new" })
      }
    };

    const service = new BroadcastService(prisma, {} as any, {} as any, createMockI18n(), { log: vi.fn() } as any);

    await service.createBroadcast({
      actorUserId: "admin1",
      audienceType: "ALL_USERS",
      languageCode: "ru",
      text: "",
      followUpText: "Отдельный текст",
      mediaType: MediaType.VIDEO,
      mediaFileId: "video-1"
    });

    expect(prisma.broadcast.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        localizations: {
          create: [
            expect.objectContaining({
              text: "",
              followUpText: "Отдельный текст",
              mediaType: MediaType.VIDEO,
              mediaFileId: "video-1"
            })
          ]
        }
      })
    });
  });

  it("sends media first and follow-up text second for a regular broadcast", async () => {
    const prisma = buildPrisma({
      languageCode: "ru",
      text: "",
      followUpText: "Второй текст",
      mediaType: MediaType.VIDEO,
      mediaFileId: "video-1",
      externalUrl: null
    });
    const segments = {
      resolveAudience: vi.fn().mockResolvedValue([buildRecipient()])
    } as any;
    const calls: any[] = [];
    const telegram: any = {
      sendVideo: vi.fn().mockImplementation(async (...args: any[]) => {
        calls.push(["sendVideo", ...args]);
        return { message_id: 1 };
      }),
      sendMessage: vi.fn().mockImplementation(async (...args: any[]) => {
        calls.push(["sendMessage", ...args]);
        return { message_id: 2 };
      }),
      sendPhoto: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideoNote: vi.fn()
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b1");

    expect(stats.successCount).toBe(1);
    expect(calls[0][0]).toBe("sendVideo");
    expect(calls[1][0]).toBe("sendMessage");
    expect(calls[1][2]).toBe("Второй текст");
    expect(calls[0][3].reply_markup).toBeUndefined();
    expect(calls[1][3].reply_markup).toBeDefined();
  });

  it("sends the same two-message sequence for a scheduled broadcast record", async () => {
    const prisma = buildPrisma(
      {
        languageCode: "ru",
        text: "",
        followUpText: "Текст после медиа",
        mediaType: MediaType.PHOTO,
        mediaFileId: "photo-1",
        externalUrl: null
      },
      "SCHEDULED"
    );
    const segments = {
      resolveAudience: vi.fn().mockResolvedValue([buildRecipient()])
    } as any;
    const calls: any[] = [];
    const telegram: any = {
      sendPhoto: vi.fn().mockImplementation(async (_chatId: any, _fileId: any, extra: any) => {
        calls.push(["sendPhoto", extra]);
        return { message_id: 1 };
      }),
      sendMessage: vi.fn().mockImplementation(async (_chatId: any, _text: any, extra: any) => {
        calls.push(["sendMessage", extra]);
        return { message_id: 2 };
      }),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideoNote: vi.fn()
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    await service.dispatchBroadcast("b1");

    expect(calls[0][0]).toBe("sendPhoto");
    expect(calls[0][1].reply_markup).toBeUndefined();
    expect(calls[1][0]).toBe("sendMessage");
    expect(calls[1][1].reply_markup).toBeDefined();
  });

  it("sends audio first and follow-up text second for a regular broadcast", async () => {
    const prisma = buildPrisma({
      languageCode: "ru",
      text: "",
      followUpText: "Текст после аудио",
      mediaType: MediaType.AUDIO,
      mediaFileId: "audio-1",
      externalUrl: null
    });
    const segments = {
      resolveAudience: vi.fn().mockResolvedValue([buildRecipient()])
    } as any;
    const calls: any[] = [];
    const telegram: any = {
      sendAudio: vi.fn().mockImplementation(async (...args: any[]) => {
        calls.push(["sendAudio", ...args]);
        return { message_id: 1 };
      }),
      sendMessage: vi.fn().mockImplementation(async (...args: any[]) => {
        calls.push(["sendMessage", ...args]);
        return { message_id: 2 };
      }),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideoNote: vi.fn()
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b1");

    expect(stats.successCount).toBe(1);
    expect(calls[0][0]).toBe("sendAudio");
    expect(calls[1][0]).toBe("sendMessage");
    expect(calls[1][2]).toBe("Текст после аудио");
    expect(calls[0][3].reply_markup).toBeUndefined();
    expect(calls[1][3].reply_markup).toBeDefined();
  });

  it("marks the recipient as failed when follow-up text fails after media succeeds", async () => {
    const prisma = buildPrisma({
      languageCode: "ru",
      text: "",
      followUpText: "Второй текст",
      mediaType: MediaType.VIDEO_NOTE,
      mediaFileId: "note-1",
      externalUrl: null
    });
    const segments = {
      resolveAudience: vi.fn().mockResolvedValue([buildRecipient()])
    } as any;
    const telegram: any = {
      sendVideoNote: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendMessage: vi.fn().mockRejectedValue(new Error("chat is blocked")),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn()
    };

    const service = new BroadcastService(prisma, segments, {} as any, createMockI18n(), {} as any);
    service.setTelegram(telegram);

    const stats = await service.dispatchBroadcast("b1");

    expect(stats.failedCount).toBe(1);
    expect(prisma.broadcastRecipient.update).toHaveBeenCalledWith({
      where: {
        broadcastId_userId: {
          broadcastId: "b1",
          userId: "u1"
        }
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: expect.stringContaining("follow-up text failed")
      })
    });
  });
});
