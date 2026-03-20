import { describe, expect, it, vi } from "vitest";

import { inactivityReminderAdminScene } from "../src/bot/scenes/inactivity-reminder-admin.scene";

describe("inactivity-reminder-admin.scene locale split", () => {
  it("uses contentLanguageCode for source page title preload and uiLanguageCode for UI labels", async () => {
    const i18nT = vi.fn().mockImplementation((lang: string, key: string) => `${lang}:${key}`);
    const pickLocalized = vi.fn((items: any[], lang: string) => items.find((x) => x.languageCode === lang) ?? items[0]);
    const reply = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      currentUser: { id: "u1", selectedLanguage: "ru", telegramUserId: BigInt(1) },
      scene: {
        state: {
          mode: "create",
          triggerPageId: "page-en-1",
          uiLanguageCode: "ru",
          contentLanguageCode: "en"
        }
      },
      wizard: { state: {} },
      callbackQuery: undefined,
      services: {
        i18n: {
          resolveLanguage: (l: string) => String(l).toLowerCase(),
          normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
          t: i18nT,
          pickLocalized
        },
        menu: {
          findMenuItemById: vi.fn().mockResolvedValue({
            id: "page-en-1",
            key: "page_key",
            localizations: [
              { languageCode: "ru", title: "Русский заголовок" },
              { languageCode: "en", title: "English title" }
            ]
          })
        },
        inactivityReminders: { getRuleByTriggerPageId: vi.fn() }
      },
      reply
    } as any;

    const step0 = (inactivityReminderAdminScene as any).steps[0];
    await step0(ctx, vi.fn());

    // Title should be resolved through content language layer.
    expect(pickLocalized).toHaveBeenCalledWith(expect.any(Array), "en");
    // UI label should stay on UI language.
    expect(i18nT).toHaveBeenCalledWith("ru", "reminders_wizard_step1_page");
  });
});

