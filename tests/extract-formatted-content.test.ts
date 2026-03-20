import { describe, it, expect } from "vitest";

import { extractFormattedContentText } from "../src/bot/helpers/message-content";
import type { MessageContent } from "../src/bot/helpers/message-content";

describe("extractFormattedContentText", () => {
  it("returns plain text when no entities", () => {
    const content: MessageContent = { text: "Hello world" };
    expect(extractFormattedContentText(content)).toBe("Hello world");
  });

  it("converts Telegram entities to HTML when present", () => {
    const content: MessageContent & { entities?: { type: string; offset: number; length: number }[] } = {
      text: "Bold text",
      entities: [{ type: "bold", offset: 0, length: 9 }]
    };
    expect(extractFormattedContentText(content)).toBe("<b>Bold text</b>");
  });

  it("preserves blockquote from entities", () => {
    const content: MessageContent & { entities?: { type: string; offset: number; length: number }[] } = {
      text: "Quote line",
      entities: [{ type: "blockquote", offset: 0, length: 10 }]
    };
    expect(extractFormattedContentText(content)).toBe("<blockquote>Quote line</blockquote>");
  });

  it("handles empty text", () => {
    expect(extractFormattedContentText({ text: "" })).toBe("");
    expect(extractFormattedContentText({})).toBe("");
  });
});
