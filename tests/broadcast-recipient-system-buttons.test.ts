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
});

