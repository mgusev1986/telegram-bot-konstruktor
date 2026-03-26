import { describe, expect, it, vi } from "vitest";

import { MenuService } from "../src/modules/menu/menu.service";

describe("MenuService nested locale isolation", () => {
  it("getPageEditorBlocks returns only exact-locale children", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: vi.fn().mockResolvedValue({ id: "tpl-1" })
      },
      menuItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "ru-child",
            parentId: "root-id",
            type: "TEXT",
            key: "ru_child",
            isActive: true,
            localizations: [{ languageCode: "ru", title: "Только RU" }]
          },
          {
            id: "en-child",
            parentId: "root-id",
            type: "TEXT",
            key: "en_child",
            isActive: true,
            localizations: [{ languageCode: "en", title: "Only EN" }]
          }
        ])
      }
    };

    const svc = new MenuService(
      prisma,
      {
        normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase()
      } as any,
      {} as any,
      {} as any,
      { resolveVariant: vi.fn().mockResolvedValue(null) } as any,
      { log: vi.fn() } as any
    );

    const blocksRu = await svc.getPageEditorBlocks("root-id", "ru");
    const blocksEn = await svc.getPageEditorBlocks("root-id", "en");

    expect(blocksRu.childSections.map((x) => x.id)).toEqual(["ru-child"]);
    expect(blocksEn.childSections.map((x) => x.id)).toEqual(["en-child"]);
  });

  it("getContentSectionsForPicker excludes sections without exact locale", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: vi.fn().mockResolvedValue({ id: "tpl-1" })
      },
      menuItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "shared",
            key: "shared",
            localizations: [
              { languageCode: "ru", title: "Общий" },
              { languageCode: "en", title: "Shared" }
            ]
          },
          {
            id: "en-only",
            key: "en_only",
            localizations: [{ languageCode: "en", title: "EN only" }]
          }
        ])
      }
    };

    const svc = new MenuService(
      prisma,
      {
        normalizeLocalizationLanguageCode: (l: string) => String(l).toLowerCase()
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { log: vi.fn() } as any
    );

    const ruSections = await svc.getContentSectionsForPicker("ru");
    const enSections = await svc.getContentSectionsForPicker("en");

    expect(ruSections.map((x) => x.id)).toEqual(["shared"]);
    expect(enSections.map((x) => x.id)).toEqual(["shared", "en-only"]);
  });
});
