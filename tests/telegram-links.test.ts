import { describe, expect, it } from "vitest";

import { parseTelegramMessageLink } from "../src/modules/media-library/telegram-links";

describe("parseTelegramMessageLink", () => {
  it("parses private channel link t.me/c/<id>/<msg>", () => {
    const ref = parseTelegramMessageLink("https://t.me/c/123456/77");
    expect(ref).toEqual({ kind: "private", channelId: BigInt("-100123456"), messageId: 77 });
  });

  it("parses public channel link t.me/<username>/<msg>", () => {
    const ref = parseTelegramMessageLink("t.me/my_channel/12");
    expect(ref).toEqual({ kind: "public", username: "my_channel", messageId: 12 });
  });

  it("returns null on invalid links", () => {
    expect(parseTelegramMessageLink("not a link")).toBeNull();
    expect(parseTelegramMessageLink("https://example.com/a/b")).toBeNull();
    expect(parseTelegramMessageLink("https://t.me/c/abc/1")).toBeNull();
  });
});

