import { describe, expect, it, vi } from "vitest";

import { MenuService } from "../src/modules/menu/menu.service";

describe("MenuService locale structure isolation", () => {
  it("does not return EN-only nodes for RU content language", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "tpl-1",
          baseLanguageCode: "ru",
          localizations: [{ languageCode: "ru", welcomeText: "Привет", welcomeMediaFileId: null }]
        })
      },
      menuItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "shared",
            parentId: null,
            isActive: true,
            visibilityMode: "SHOW",
            accessRuleId: null,
            productId: null,
            localizations: [
              { languageCode: "ru", title: "Общий" },
              { languageCode: "en", title: "Shared" }
            ]
          },
          {
            id: "en-only",
            parentId: null,
            isActive: true,
            visibilityMode: "SHOW",
            accessRuleId: null,
            productId: null,
            localizations: [{ languageCode: "en", title: "Only EN" }]
          }
        ])
      }
    };

    const service = new MenuService(
      prisma,
      {
        normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase(),
        pickLocalized: (items: any[], lang: string) => items.find((i) => i.languageCode === lang) ?? items[0]
      } as any,
      {
        evaluate: vi.fn().mockResolvedValue(true),
        evaluateProduct: vi.fn().mockResolvedValue(true)
      } as any,
      {} as any,
      { resolveVariant: vi.fn().mockResolvedValue(null) } as any,
      { log: vi.fn() } as any
    );

    const items = await service.getMenuItemsForParent(
      { id: "u1", selectedLanguage: "ru" } as any,
      null
    );

    expect(items.map((i) => i.id)).toContain("shared");
    expect(items.map((i) => i.id)).not.toContain("en-only");
  });
});
