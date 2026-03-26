import { describe, expect, it, vi } from "vitest";

import { createSectionScene } from "../src/bot/scenes/create-section.scene";

describe("create-section.scene locale split", () => {
  it.each(["en", "de"])("uses RU UI prompt and saves only %s content layer", async (editingLang) => {
    const createMenuItem = vi.fn().mockResolvedValue({ id: "new-sec" });
    const i18nT = vi.fn().mockImplementation((lang: string, key: string) => `${lang}:${key}`);

    const ctx = {
      currentUser: { id: "u1", selectedLanguage: "ru" },
      scene: {
        state: {
          parentId: null,
          fromPageId: "root",
          languageCode: editingLang,
          uiLanguageCode: "ru"
        },
        leave: vi.fn().mockResolvedValue(undefined)
      },
      wizard: { state: {}, next: vi.fn(), selectStep: vi.fn() },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: i18nT,
          availableLanguages: () => [{ code: "en", label: "English" }],
          pickLocalized: (items: any[], lang: string) => items.find((x) => x.languageCode === lang) ?? items[0]
        },
        users: { findByTelegramId: vi.fn() },
        menu: {
          getBaseLanguage: vi.fn().mockResolvedValue("ru"),
          findMenuItemById: vi.fn(),
          createMenuItem
        }
      },
      from: { id: 111 },
      replyWithHTML: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined)
    } as any;

    // Step 0: initial title prompt (UI text should be ru)
    const step0 = (createSectionScene as any).steps[0];
    await step0(ctx);
    expect(i18nT).toHaveBeenCalledWith("ru", "wizard_creating_section");

    // Step 1: content save should use languageCode=en
    ctx.wizard.state = {
      parentId: null,
      fromPageId: "root",
      languageCode: editingLang,
      uiLanguageCode: "ru",
      title: "My section"
    };
    ctx.message = { text: "Hello in EN layer" };
    const step1 = (createSectionScene as any).steps[1];
    await step1(ctx);

    expect(createMenuItem).toHaveBeenCalledTimes(1);
    expect(createMenuItem.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        languageCode: editingLang,
        title: "My section"
      })
    );
  });
});

