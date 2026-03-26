import { describe, expect, it, vi } from "vitest";

import { MenuService } from "../src/modules/menu/menu.service";

describe("MenuService.publishLanguageVersion locale isolation", () => {
  it("publishes only the selected language layer", async () => {
    const presentationLocalizationUpsert = vi.fn().mockResolvedValue(undefined);
    const menuItemLocalizationUpsert = vi.fn().mockResolvedValue(undefined);
    const layerStateUpsert = vi.fn().mockResolvedValue(undefined);

    const prisma: any = {
      presentationTemplate: {
        findFirst: vi.fn().mockResolvedValue({ id: "tpl-1", isActive: true, baseLanguageCode: "ru" })
      },
      presentationLocalizationDraft: {
        findUnique: vi.fn().mockResolvedValue({
          templateId: "tpl-1",
          languageCode: "de",
          welcomeText: "Hallo",
          welcomeMediaType: "NONE",
          welcomeMediaFileId: null
        })
      },
      menuItemLocalizationDraft: {
        findMany: vi.fn().mockResolvedValue([
          {
            menuItemId: "page-1",
            languageCode: "de",
            title: "Titel DE",
            contentText: "Inhalt DE",
            mediaType: "NONE",
            mediaFileId: null,
            externalUrl: null
          }
        ])
      },
      $transaction: vi.fn((arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        if (typeof arg === "function") {
          return arg({
            presentationLocalization: { upsert: presentationLocalizationUpsert },
            menuItemLocalization: { upsert: menuItemLocalizationUpsert },
            localizationLayerState: { upsert: layerStateUpsert }
          });
        }
        return Promise.resolve(undefined);
      })
    };

    const svc = new MenuService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      { resolveVariant: vi.fn().mockResolvedValue(null) } as any,
      { log: vi.fn() } as any
    );

    await svc.publishLanguageVersion("actor-1", "de");

    expect(prisma.presentationLocalizationDraft.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_languageCode: { templateId: "tpl-1", languageCode: "de" } }
      })
    );
    expect(prisma.menuItemLocalizationDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { languageCode: "de", menuItem: { templateId: "tpl-1" } }
      })
    );

    expect(presentationLocalizationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_languageCode: { templateId: "tpl-1", languageCode: "de" } }
      })
    );
    expect(menuItemLocalizationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { menuItemId_languageCode: { menuItemId: "page-1", languageCode: "de" } }
      })
    );
    expect(layerStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { templateId_languageCode: { templateId: "tpl-1", languageCode: "de" } }
      })
    );
  });
});
