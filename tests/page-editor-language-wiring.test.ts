import { describe, expect, it } from "vitest";

import { splitCallbackData } from "../src/common/callback-data";
import { buildPageEditorKeyboard } from "../src/bot/keyboards";

describe("page editor language wiring", () => {
  it("encodes editing content language in edit callback extra part", () => {
    const i18n: any = {
      t: (_lang: string, key: string) => key
    };

    const kb: any = buildPageEditorKeyboard("root", [], "ru", i18n, {
      editingContentLanguageCode: "en"
    });

    const firstButton = kb.reply_markup.inline_keyboard[0][0];
    const parts = splitCallbackData(firstButton.callback_data);

    // Expected callback format: page_edit:cnt:<pageId>:<editingContentLanguageCode> (cnt=content menu, shortened for 64-char limit)
    expect(parts[0]).toBe("page_edit");
    expect(parts[1]).toBe("cnt");
    expect(parts[2]).toBe("root");
    expect(parts[3]).toBe("en");
  });
});

