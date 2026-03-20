import { describe, expect, it, vi } from "vitest";

import { renameButtonScene } from "../src/bot/scenes/rename-button.scene";

describe("rename-button.scene locale split", () => {
  it("keeps UI in uiLanguageCode and writes title into content language layer", async () => {
    const updateMenuItemTitle = vi.fn().mockResolvedValue(undefined);
    const i18nT = vi.fn().mockImplementation((lang: string, key: string) => `${lang}:${key}`);
    const reply = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      message: { text: "New title" },
      currentUser: { id: "u1", selectedLanguage: "ru" },
      wizard: {
        state: {
          itemId: "btn1",
          fromPageId: "root",
          languageCode: "en",
          uiLanguageCode: "ru"
        }
      },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: i18nT
        },
        menu: {
          updateMenuItemTitle
        }
      },
      reply,
      scene: { leave: vi.fn().mockResolvedValue(undefined) }
    } as any;

    const step2 = (renameButtonScene as any).steps[1];
    await step2(ctx);

    expect(updateMenuItemTitle).toHaveBeenCalledTimes(1);
    expect(updateMenuItemTitle).toHaveBeenCalledWith("btn1", "en", "New title", "u1");

    // Success UI message should still use ru locale.
    expect(i18nT).toHaveBeenCalledWith("ru", "button_renamed");
    expect(i18nT).not.toHaveBeenCalledWith("en", "button_renamed");
  });
});

