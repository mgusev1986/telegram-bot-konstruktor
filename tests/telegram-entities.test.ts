import { describe, expect, it } from "vitest";
import type { MessageEntity } from "telegraf/types";

import { telegramEntitiesToHtml } from "../src/common/telegram-entities";

describe("telegramEntitiesToHtml", () => {
  it("converts bold entities to <b> tags", () => {
    const text = "Hello world";
    const entities: MessageEntity[] = [{ type: "bold", offset: 6, length: 5 }];
    expect(telegramEntitiesToHtml(text, entities)).toBe("Hello <b>world</b>");
  });

  it("converts blockquote entities to <blockquote> tags", () => {
    const text = "Quote line";
    const entities: MessageEntity[] = [{ type: "blockquote", offset: 0, length: 10 }];
    expect(telegramEntitiesToHtml(text, entities)).toBe("<blockquote>Quote line</blockquote>");
  });

  it("converts italic entities to <i> tags", () => {
    const text = "Emphasis";
    const entities: MessageEntity[] = [{ type: "italic", offset: 0, length: 8 }];
    expect(telegramEntitiesToHtml(text, entities)).toBe("<i>Emphasis</i>");
  });

  it("converts text_link entities with url", () => {
    const text = "Click here";
    const entities: MessageEntity[] = [
      { type: "text_link", offset: 0, length: 10, url: "https://example.com" } as MessageEntity
    ];
    const result = telegramEntitiesToHtml(text, entities);
    expect(result).toContain("<a href=");
    expect(result).toContain("https://example.com");
    expect(result).toContain("Click here");
    expect(result).toContain("</a>");
  });

  it("preserves Telegram custom emoji as tg-emoji HTML", () => {
    const html = telegramEntitiesToHtml("🚀 старт", [
      {
        type: "custom_emoji",
        offset: 0,
        length: 2,
        custom_emoji_id: "5368324170671202286"
      } as MessageEntity
    ]);

    expect(html).toBe('<tg-emoji emoji-id="5368324170671202286">🚀</tg-emoji> старт');
  });

  it("preserves plain text when no entities", () => {
    const text = "Plain text";
    expect(telegramEntitiesToHtml(text, [])).toBe("Plain text");
    expect(telegramEntitiesToHtml(text, null)).toBe("Plain text");
  });

  it("escapes HTML in plain segments", () => {
    const text = "x < 5 & y > 3";
    expect(telegramEntitiesToHtml(text, [])).toBe("x &lt; 5 &amp; y &gt; 3");
  });

  it("handles nested entities", () => {
    const text = "Bold and italic";
    const entities: MessageEntity[] = [
      { type: "bold", offset: 0, length: 15 },
      { type: "italic", offset: 9, length: 6 }
    ];
    const result = telegramEntitiesToHtml(text, entities);
    expect(result).toContain("<b>");
    expect(result).toContain("<i>");
    expect(result).toContain("</i>");
    expect(result).toContain("</b>");
  });

  it("preserves emoji in text", () => {
    const text = "Hello 😀 world";
    const entities: MessageEntity[] = [{ type: "bold", offset: 6, length: 6 }];
    const result = telegramEntitiesToHtml(text, entities);
    expect(result).toContain("😀");
    expect(result).toContain("<b>");
  });

  it("returns empty for empty text", () => {
    expect(telegramEntitiesToHtml("", [])).toBe("");
  });
});
