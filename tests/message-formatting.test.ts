import { MediaType } from "@prisma/client";
import { describe, it, expect } from "vitest";

import { sendRichMessage } from "../src/common/media";

describe("sendRichMessage formatting", () => {
  it("keeps reply_markup on a single text message", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendMessage: async (_chatId: any, _text: any, extra: any) => {
        calls.push(extra);
        return { message_id: 1 };
      },
    };

    await sendRichMessage(
      telegram,
      1,
      { text: "Hello" },
      { reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] } }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].reply_markup).toBeDefined();
  });

  it("sends HTML text with parse_mode=HTML and without entities", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendMessage: async (_chatId: any, _text: any, extra: any) => {
        calls.push({ extra });
        return { message_id: 1 };
      },
    };

    await sendRichMessage(
      telegram,
      1,
      { text: "Hello <b>world</b>" },
      {}
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].extra.parse_mode).toBe("HTML");
    expect("entities" in calls[0].extra).toBe(false);
  });

  it("sends blockquote with parse_mode=HTML", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendMessage: async (_chatId: any, _text: any, extra: any) => {
        calls.push({ extra });
        return { message_id: 1 };
      },
    };

    await sendRichMessage(
      telegram,
      1,
      { text: "<blockquote>Quote text</blockquote>" },
      {}
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].extra.parse_mode).toBe("HTML");
  });

  it("sends tg-emoji markup with parse_mode=HTML", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendMessage: async (_chatId: any, _text: any, extra: any) => {
        calls.push({ extra });
        return { message_id: 1 };
      },
    };

    await sendRichMessage(
      telegram,
      1,
      { text: '<tg-emoji emoji-id="5368324170671202286">🚀</tg-emoji> Старт' },
      {}
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].extra.parse_mode).toBe("HTML");
    expect("entities" in calls[0].extra).toBe(false);
  });

  it("keeps legacy media plus caption as a single Telegram message", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendVideo: async (_chatId: any, _fileId: any, extra: any) => {
        calls.push(extra);
        return { message_id: 1, extra };
      },
      sendMessage: async () => ({ message_id: 2 })
    };

    const sent = await sendRichMessage(
      telegram,
      1,
      { mediaType: MediaType.VIDEO, mediaFileId: "video-1", text: "Legacy caption" },
      { reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] } }
    );

    expect(sent.message_id).toBe(1);
    expect(calls[0].reply_markup).toBeDefined();
  });

  it("sends audio with caption as a single Telegram message", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendAudio: async (_chatId: any, _fileId: any, extra: any) => {
        calls.push(extra);
        return { message_id: 1, extra };
      },
      sendMessage: async () => ({ message_id: 2 })
    };

    const sent = await sendRichMessage(
      telegram,
      1,
      { mediaType: MediaType.AUDIO, mediaFileId: "audio-1", text: "Audio caption" },
      { reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] } }
    );

    expect(sent.message_id).toBe(1);
    expect(calls[0].reply_markup).toBeDefined();
    expect(calls[0].caption).toBe("Audio caption");
  });

  it("sends media first without reply_markup and follow-up text second with reply_markup", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendPhoto: async (chatId: any, fileId: any, extra: any) => {
        calls.push(["sendPhoto", chatId, fileId, extra]);
        return { message_id: 1 };
      },
      sendMessage: async (chatId: any, text: any, extra: any) => {
        calls.push(["sendMessage", chatId, text, extra]);
        return { message_id: 2 };
      }
    };

    await sendRichMessage(
      telegram,
      777,
      {
        mediaType: MediaType.PHOTO,
        mediaFileId: "photo-1",
        text: "",
        followUpText: "Follow-up text"
      },
      {
        disable_notification: true,
        reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }
      }
    );

    expect(calls).toEqual([
      ["sendPhoto", 777, "photo-1", { caption: undefined, disable_notification: true }],
      ["sendMessage", 777, "Follow-up text", { disable_notification: true, reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }, entities: [] }]
    ]);
  });

  it("sends audio first without reply_markup and follow-up text second with reply_markup", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendAudio: async (chatId: any, fileId: any, extra: any) => {
        calls.push(["sendAudio", chatId, fileId, extra]);
        return { message_id: 1 };
      },
      sendMessage: async (chatId: any, text: any, extra: any) => {
        calls.push(["sendMessage", chatId, text, extra]);
        return { message_id: 2 };
      }
    };

    await sendRichMessage(
      telegram,
      778,
      {
        mediaType: MediaType.AUDIO,
        mediaFileId: "audio-2",
        text: "",
        followUpText: "Follow-up after audio"
      },
      {
        disable_notification: true,
        reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }
      }
    );

    expect(calls).toEqual([
      ["sendAudio", 778, "audio-2", { caption: undefined, disable_notification: true }],
      ["sendMessage", 778, "Follow-up after audio", { disable_notification: true, reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }, entities: [] }]
    ]);
  });

  it("sends voice first without reply_markup and follow-up text second with reply_markup", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendVoice: async (chatId: any, fileId: any, extra: any) => {
        calls.push(["sendVoice", chatId, fileId, extra]);
        return { message_id: 1 };
      },
      sendMessage: async (chatId: any, text: any, extra: any) => {
        calls.push(["sendMessage", chatId, text, extra]);
        return { message_id: 2 };
      }
    };

    await sendRichMessage(
      telegram,
      779,
      {
        mediaType: MediaType.VOICE,
        mediaFileId: "voice-1",
        text: "",
        followUpText: "Follow-up after voice"
      },
      {
        disable_notification: true,
        reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }
      }
    );

    expect(calls).toEqual([
      ["sendVoice", 779, "voice-1", { caption: undefined, disable_notification: true }],
      ["sendMessage", 779, "Follow-up after voice", { disable_notification: true, reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }, entities: [] }]
    ]);
  });

  it("keeps buttons only under the lower text message when long media text is moved to follow-up", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendAudio: async (chatId: any, fileId: any, extra: any) => {
        calls.push(["sendAudio", chatId, fileId, extra]);
        return { message_id: 1 };
      },
      sendMessage: async (chatId: any, text: any, extra: any) => {
        calls.push(["sendMessage", chatId, text, extra]);
        return { message_id: 2 };
      }
    };

    const longText = "Очень длинный текст ".repeat(80).trim();

    await sendRichMessage(
      telegram,
      780,
      {
        mediaType: MediaType.AUDIO,
        mediaFileId: "audio-overflow",
        text: longText
      },
      {
        reply_markup: { inline_keyboard: [[{ text: "CTA", callback_data: "cta" }]] }
      }
    );

    expect(calls[0]).toEqual(["sendAudio", 780, "audio-overflow", { caption: undefined }]);
    expect(calls[1][0]).toBe("sendMessage");
    expect(calls[1][2]).toBe(longText);
    expect(calls[1][3].reply_markup).toEqual({ inline_keyboard: [[{ text: "CTA", callback_data: "cta" }]] });
  });

  it("preserves legacy hidden video note behavior and keeps reply_markup only on the second message", async () => {
    const calls: any[] = [];
    const telegram: any = {
      sendVideoNote: async (chatId: any, fileId: any, extra: any) => {
        calls.push(["sendVideoNote", chatId, fileId, extra]);
        return { message_id: 1 };
      },
      sendMessage: async (chatId: any, text: any, extra: any) => {
        calls.push(["sendMessage", chatId, text, extra]);
        return { message_id: 2 };
      }
    };

    await sendRichMessage(
      telegram,
      888,
      {
        mediaType: MediaType.VIDEO_NOTE,
        mediaFileId: "note-1",
        text: "Legacy note follow-up"
      },
      { reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] } }
    );

    expect(calls).toEqual([
      ["sendVideoNote", 888, "note-1", {}],
      ["sendMessage", 888, "Legacy note follow-up", { reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] }, entities: [] }]
    ]);
  });

  it("throws a clear error when the follow-up text fails after primary media succeeds", async () => {
    const telegram: any = {
      sendVideoNote: async () => ({ message_id: 1 }),
      sendMessage: async () => {
        throw new Error("chat is blocked");
      }
    };

    await expect(
      sendRichMessage(
        telegram,
        999,
        {
          mediaType: MediaType.VIDEO_NOTE,
          mediaFileId: "note-2",
          followUpText: "After the note"
        },
        {}
      )
    ).rejects.toThrow("Primary media sent, but follow-up text failed: chat is blocked");
  });
});
