import { describe, it, expect } from "vitest";

import { sendRichMessage } from "../src/common/media";

describe("sendRichMessage formatting", () => {
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
});

