import { describe, expect, it } from "vitest";

import { readStructuredLinkedChatsFromBody } from "../src/common/backoffice-linked-chat-form";

describe("readStructuredLinkedChatsFromBody", () => {
  it("keeps real invite when post link is also filled (regression: do not wipe invite)", () => {
    const rows = readStructuredLinkedChatsFromBody({
      linkedChatLabel1: "Приватный чат",
      linkedChatLink1: "https://t.me/+AbCdEfGhIjKlMnOp",
      linkedChatPostLink1: "https://t.me/c/3632239460/1",
      linkedChatIdentifier1: "-1003632239460"
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      label: "Приватный чат",
      link: "https://t.me/+AbCdEfGhIjKlMnOp",
      identifier: "-1003632239460"
    });
  });

  it("uses post link as stored URL when invite is empty or placeholder", () => {
    const rows = readStructuredLinkedChatsFromBody({
      linkedChatLabel1: "Чат",
      linkedChatLink1: "https://t.me/+inviteHashChat",
      linkedChatPostLink1: "https://t.me/c/3632239460/2",
      linkedChatIdentifier1: ""
    });
    expect(rows[0]?.link).toBe("https://t.me/c/3632239460/2");
    expect(rows[0]?.identifier).toBe("-1003632239460");
  });

  it("skips empty rows", () => {
    expect(readStructuredLinkedChatsFromBody({})).toEqual([]);
  });
});
