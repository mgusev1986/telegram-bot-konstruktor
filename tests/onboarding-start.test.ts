import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ONBOARDING_BASE_LANGUAGE, startOnboardingWithBaseLanguage } from "../src/bot/helpers/onboarding-start";

describe("Onboarding start helper", () => {
  it("starts the wizard immediately with ru and skips the language picker screen", async () => {
    const services: any = {
      i18n: {
        resolveLanguage: vi.fn().mockReturnValue("ru"),
        normalizeLocalizationLanguageCode: vi.fn((code: string) => code.toLowerCase()),
        t: vi.fn((lang: string, key: string) => `${lang}:${key}`)
      },
      menu: {
        ensureActiveTemplate: vi.fn().mockResolvedValue(undefined)
      },
      users: {
        setOnboardingStep: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue({
          id: "u1",
          telegramUserId: BigInt("123"),
          selectedLanguage: "ru"
        })
      },
      navigation: {
        replaceScreen: vi.fn().mockResolvedValue(undefined)
      }
    };

    const ctx: any = {
      currentUser: {
        id: "u1",
        telegramUserId: BigInt("123"),
        selectedLanguage: "ru"
      },
      telegram: {},
      chat: { id: 123 }
    };

    await startOnboardingWithBaseLanguage(ctx, services, ctx.currentUser);

    expect(services.menu.ensureActiveTemplate).toHaveBeenCalledWith("u1", DEFAULT_ONBOARDING_BASE_LANGUAGE);
    expect(services.users.setOnboardingStep).toHaveBeenCalledWith("u1", 1);
    expect(services.navigation.replaceScreen).toHaveBeenCalledWith(
      expect.anything(),
      ctx.telegram,
      123,
      expect.objectContaining({
        text: expect.stringContaining("ru:onboarding_step1_intro")
      }),
      expect.anything()
    );
    expect(services.navigation.replaceScreen.mock.calls[0][3].text).not.toContain("onboarding_step0_title");
  });

  it("keeps admin UI locale separate from base content language and still supports future languages", async () => {
    const services: any = {
      i18n: {
        resolveLanguage: vi.fn().mockReturnValue("en"),
        normalizeLocalizationLanguageCode: vi.fn((code: string) => code.toLowerCase()),
        t: vi.fn((lang: string, key: string) => `${lang}:${key}`)
      },
      menu: {
        ensureActiveTemplate: vi.fn().mockResolvedValue(undefined)
      },
      users: {
        setOnboardingStep: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue({
          id: "u2",
          telegramUserId: BigInt("456"),
          selectedLanguage: "en"
        })
      },
      navigation: {
        replaceScreen: vi.fn().mockResolvedValue(undefined)
      }
    };

    const ctx: any = {
      currentUser: {
        id: "u2",
        telegramUserId: BigInt("456"),
        selectedLanguage: "en"
      },
      telegram: {},
      chat: { id: 456 }
    };

    await startOnboardingWithBaseLanguage(ctx, services, ctx.currentUser, "en");

    expect(services.menu.ensureActiveTemplate).toHaveBeenCalledWith("u2", "en");
    expect(services.navigation.replaceScreen.mock.calls[0][3].text).toContain("en:onboarding_step1_intro");
  });
});
