import { describe, expect, it, vi } from "vitest";

import { editPageContentScene } from "../src/bot/scenes/edit-page-content.scene";

describe("edit-page-content.scene locale safety", () => {
  it("uses uiLanguageCode for UI texts, not editing content language", async () => {
    const replyWithHTML = vi.fn().mockResolvedValue(undefined);
    const i18nT = vi.fn().mockImplementation((lang: string, key: string) => `${lang}:${key}`);

    const ctx = {
      currentUser: { id: "u1", selectedLanguage: "ru" },
      scene: {
        state: { menuItemId: "root", isRoot: true, languageCode: "en", uiLanguageCode: "ru" }
      },
      wizard: { state: {}, next: vi.fn() },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: i18nT
        }
      },
      replyWithHTML
    } as any;

    const step1 = (editPageContentScene as any).steps[0];
    await step1(ctx);

    expect(replyWithHTML).toHaveBeenCalledTimes(1);
    // UI dictionary calls should be in ru even when edited content layer is en.
    expect(i18nT).toHaveBeenCalledWith("ru", "screen_header_page_editor");
    expect(i18nT).toHaveBeenCalledWith("ru", "page_edit_content");
    expect(i18nT).toHaveBeenCalledWith("ru", "send_content_root");
    expect(i18nT).not.toHaveBeenCalledWith("en", "screen_header_page_editor");
  });

  it("root save writes PresentationLocalization for editing language (not base/current user)", async () => {
    const setWelcome = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      message: { text: "Hello {name}!" },
      currentUser: { id: "u1", selectedLanguage: "ru" },
      wizard: {
        state: { menuItemId: "root", isRoot: true, languageCode: "en" }
      },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: (_lang: string, key: string) => key
        },
        menu: {
          setWelcome,
          updateMenuItemContent: vi.fn()
        }
      },
      reply: vi.fn().mockResolvedValue(undefined),
      scene: { leave: vi.fn().mockResolvedValue(undefined) }
    } as any;

    const step2 = (editPageContentScene as any).steps[1];
    await step2(ctx);

    expect(setWelcome).toHaveBeenCalledTimes(1);
    expect(setWelcome).toHaveBeenCalledWith("u1", "en", "Hello {name}!", "NONE", null);
    expect(ctx.services.menu.updateMenuItemContent).not.toHaveBeenCalled();
  });

  it("non-root save writes MenuItemLocalization for editing language", async () => {
    const updateMenuItemContent = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      message: { text: "Hi {name}!" },
      currentUser: { id: "u1", selectedLanguage: "ru" },
      wizard: {
        state: { menuItemId: "page1", isRoot: false, languageCode: "en" }
      },
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: (_lang: string, key: string) => key
        },
        menu: {
          setWelcome: vi.fn(),
          updateMenuItemContent
        }
      },
      reply: vi.fn().mockResolvedValue(undefined),
      scene: { leave: vi.fn().mockResolvedValue(undefined) }
    } as any;

    const step2 = (editPageContentScene as any).steps[1];
    await step2(ctx);

    expect(updateMenuItemContent).toHaveBeenCalledTimes(1);
    const call = updateMenuItemContent.mock.calls[0];
    expect(call[0]).toBe("page1");
    expect(call[1]).toBe("u1");
    expect(call[2]).toBe("en");
    expect(call[3]).toEqual(
      expect.objectContaining({
        contentText: "Hi {name}!",
        mediaType: undefined,
        mediaFileId: undefined,
        externalUrl: undefined
      })
    );
    expect(ctx.services.menu.setWelcome).not.toHaveBeenCalled();
  });
});

