import { describe, expect, it } from "vitest";

import { extractMessageContent } from "../src/bot/helpers/message-content";

describe("extractMessageContent", () => {
  it("extracts audio file id and caption text", () => {
    const content = extractMessageContent({
      message: {
        message_id: 1,
        date: 1710000000,
        chat: { id: 1, type: "private" },
        audio: {
          file_id: "audio-file-id",
          file_unique_id: "audio-unique-id",
          duration: 82
        },
        caption: "Аудио с подписью"
      }
    } as any);

    expect(content).toMatchObject({
      mediaType: "AUDIO",
      mediaFileId: "audio-file-id",
      text: "Аудио с подписью"
    });
  });
});
