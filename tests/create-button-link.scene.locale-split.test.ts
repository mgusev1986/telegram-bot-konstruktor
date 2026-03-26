import { describe, expect, it, vi } from "vitest";

import { createButtonLinkScene } from "../src/bot/scenes/create-button-link.scene";

describe("create-button-link.scene locale split", () => {
  it.each(["en", "de"])("uses %s for section picker and keeps RU UI texts", async (editingLang) => {
    const getContentSectionsForPicker = vi.fn().mockResolvedValue([
      { id: "s1", title: "Section 1" }
    ]);
    const i18nT = vi.fn().mockImplementation((lang: string, key: string) => `${lang}:${key}`);
    const replyWithHTML = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      currentUser: { id: "u1", selectedLanguage: "ru" },
      scene: {
        state: {
          parentId: "root",
          fromPageId: "root",
          languageCode: editingLang,
          uiLanguageCode: "ru"
        }
      },
      wizard: { state: {}, next: vi.fn() },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: i18nT
        },
        menu: {
          getBaseLanguage: vi.fn().mockResolvedValue("ru"),
          getContentSectionsForPicker
        }
      },
      replyWithHTML,
      reply: vi.fn().mockResolvedValue(undefined),
      answerCbQuery: vi.fn().mockResolvedValue(undefined)
    } as any;

    // step0: show button title prompt
    const step0 = (createButtonLinkScene as any).steps[0];
    await step0(ctx, vi.fn());

    // step1: consume title, then load action choice
    ctx.message = { text: "My button" };
    const step1 = (createButtonLinkScene as any).steps[1];
    await step1(ctx);

    // step2: choose internal section flow and load picker
    ctx.callbackQuery = { data: "create_btn:mode:section" };
    const step2 = (createButtonLinkScene as any).steps[2];
    await step2(ctx);

    expect(getContentSectionsForPicker).toHaveBeenCalledTimes(1);
    expect(getContentSectionsForPicker).toHaveBeenCalledWith(editingLang);

    // UI text should stay in ru.
    expect(i18nT).toHaveBeenCalledWith("ru", "choose_target_section");
    expect(i18nT).not.toHaveBeenCalledWith(editingLang, "choose_target_section");
  });
});
