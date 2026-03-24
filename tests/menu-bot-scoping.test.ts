import { describe, expect, it, vi } from "vitest";

import { MenuService } from "../src/modules/menu/menu.service";

describe("MenuService bot scoping", () => {
  it("uses botInstanceId when resolving active template", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          localizations: [{ languageCode: "ru", welcomeText: "Тест", welcomeMediaType: "NONE" }]
        })
      }
    };

    const i18n: any = {
      pickLocalized: vi.fn().mockReturnValue({ welcomeText: "Тест", welcomeMediaType: "NONE", welcomeMediaFileId: null }),
      t: vi.fn().mockReturnValue("welcome_default")
    };

    const svc = new MenuService(
      prisma,
      i18n,
      {} as any,
      {} as any,
      { resolveVariant: vi.fn().mockResolvedValue(null) } as any,
      { log: vi.fn() } as any,
      "bot-123"
    );

    const user = { id: "u1", selectedLanguage: "ru", firstName: "Ivan", lastName: "", fullName: "" } as any;
    await svc.getWelcome(user);

    expect(prisma.presentationTemplate.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.presentationTemplate.findFirst.mock.calls[0][0];
    expect(args.where).toMatchObject({ isActive: true, botInstanceId: "bot-123" });
  });

  it("falls back to base language welcome when selected language has no content", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          baseLanguageCode: "ru",
          localizations: [
            { languageCode: "ru", welcomeText: "", welcomeMediaType: "NONE", welcomeMediaFileId: null },
            { languageCode: "uk", welcomeText: "", welcomeMediaType: "NONE", welcomeMediaFileId: null }
          ]
        })
      }
    };
    const i18n: any = {
      pickLocalized: vi.fn().mockImplementation((locs: any[], code: string) => locs.find((l) => l.languageCode === code) ?? null),
      t: vi.fn((code: string, key: string) => `${code}:${key}`)
    };
    const svc = new MenuService(
      prisma,
      i18n,
      {} as any,
      {} as any,
      { resolveVariant: vi.fn().mockResolvedValue(null) } as any,
      { log: vi.fn() } as any,
      "bot-123"
    );

    const user = { id: "u1", selectedLanguage: "uk", firstName: "Alina", lastName: "", fullName: "" } as any;
    const welcome = await svc.getWelcome(user);

    expect(welcome.text).toContain("ru:welcome_default");
  });
});

