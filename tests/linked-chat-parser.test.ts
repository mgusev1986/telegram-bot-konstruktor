import { describe, expect, it } from "vitest";

import { parseLinkedChatInput, parseLinkedChatsFromForm } from "../src/common/linked-chat-parser";

describe("linked chat parser", () => {
  it("keeps invite link as display link and numeric id as identifier in composite syntax", () => {
    expect(parseLinkedChatInput("https://t.me/+FurV2Jnm_eIxOTRk | -1003701464265")).toEqual({
      link: "https://t.me/+FurV2Jnm_eIxOTRk",
      identifier: "-1003701464265",
      label: "Чат/канал"
    });
  });

  it("accepts invite link paired with private message link", () => {
    expect(parseLinkedChatInput("https://t.me/+FurV2Jnm_eIxOTRk | https://t.me/c/3701464265/4")).toEqual({
      link: "https://t.me/+FurV2Jnm_eIxOTRk",
      identifier: "-1003701464265",
      label: "Чат/канал"
    });
  });

  it("parses multiline form values with composite entries", () => {
    expect(
      parseLinkedChatsFromForm("@public_channel\nhttps://t.me/+FurV2Jnm_eIxOTRk | -1003701464265")
    ).toEqual([
      {
        link: "https://t.me/public_channel",
        identifier: "@public_channel",
        label: "Канал"
      },
      {
        link: "https://t.me/+FurV2Jnm_eIxOTRk",
        identifier: "-1003701464265",
        label: "Чат/канал"
      }
    ]);
  });
});
