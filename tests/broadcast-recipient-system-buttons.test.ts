import { describe, it, expect, vi } from "vitest";

import { MediaType } from "@prisma/client";
import { BroadcastService } from "../src/modules/broadcasts/broadcast.service";
import { NAV_ROOT_DATA } from "../src/bot/keyboards";
import { makeCallbackData } from "../src/common/callback-data";
import { createMockI18n } from "./helpers/mock-i18n";

describe("Broadcast: recipient system buttons", () => {
  it("attaches vertical mentor + main menu buttons under broadcast messages", async () => {
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
          telegramUserId: 123,
          selectedLanguage: "ru",
          firstName: "Иван",
          lastName: null,
          username: "user1",
          fullName: null
        }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideoNote: vi.fn()
    };

    const service = new BroadcastService(
      prisma,
      segments,
      {} as any,
      createMockI18n(),
      {} as any
    );
    service.setTelegram(telegram);

    await service.dispatchBroadcast("b1");

    expect(telegram.sendMessage).toHaveBeenCalled();
    const extra = telegram.sendMessage.mock.calls[0][2];
    expect(extra?.reply_markup?.inline_keyboard).toHaveLength(2);
    extra.reply_markup.inline_keyboard.forEach((row: any) => {
      expect(row).toHaveLength(1);
    });

    const [btnMentor] = extra.reply_markup.inline_keyboard[0];
    const [btnMain] = extra.reply_markup.inline_keyboard[1];

    expect(btnMentor.callback_data).toBe(makeCallbackData("mentor", "open"));
    expect(btnMain.callback_data).toBe(NAV_ROOT_DATA);
  });

  it("uses configured broadcast buttons with custom labels instead of the default fallback", async () => {
    const prisma: any = {
      broadcast: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "b2",
          audienceType: "ALL_USERS",
          segmentQuery: {},
          createdByUserId: "admin1",
          localizations: [
            {
              languageCode: "ru",
              text: "Hello",
              mediaType: MediaType.NONE,
              mediaFileId: null,
              externalUrl: null,
              buttonsJson: [
                { type: "system", label: "Моя регистрация", systemKind: "partner_register" },
                { type: "system", label: "Мой наставник", systemKind: "mentor_contact" },
                { type: "section", label: "Открыть раздел", targetMenuItemId: "section-42" }
              ]
            }
          ]
        }),
        update: vi.fn().mockResolvedValue({})
      },
      broadcastRecipient: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({})
      },
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "mentor-1", username: "mentor_user" }]),
        findUnique: vi.fn().mockResolvedValue({ username: "mentor_user" })
      }
    };

    const segments: any = {
      resolveAudience: vi.fn().mockResolvedValue([
        {
          id: "u2",
          telegramUserId: 321,
          selectedLanguage: "ru",
          firstName: "Пётр",
          lastName: null,
          username: "user2",
          fullName: null,
          mentorUserId: "mentor-1"
        }
      ])
    };

    const telegram: any = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendPhoto: vi.fn(),
      sendVideo: vi.fn(),
      sendDocument: vi.fn(),
      sendVoice: vi.fn(),
      sendVideoNote: vi.fn(),
      sendAudio: vi.fn()
    };

    const cabinet = {
      resolvePartnerRegisterActionUrlForUser: vi.fn().mockResolvedValue("https://example.com/register")
    } as any;

    const service = new BroadcastService(
      prisma,
      segments,
      {} as any,
      createMockI18n(),
      {} as any,
      undefined,
      cabinet
    );
    service.setTelegram(telegram);

    await service.dispatchBroadcast("b2");

    const extra = telegram.sendMessage.mock.calls[0][2];
    expect(extra?.reply_markup?.inline_keyboard).toEqual([
      [expect.objectContaining({ text: "Моя регистрация", url: "https://example.com/register" })],
      [expect.objectContaining({ text: "Мой наставник", url: "https://t.me/mentor_user" })],
      [expect.objectContaining({ text: "Открыть раздел", callback_data: makeCallbackData("menu", "open", "section-42") })]
    ]);
  });
});
