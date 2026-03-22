import { describe, it, expect } from "vitest";

import { MenuService } from "../src/modules/menu/menu.service";

describe("MenuService.createMenuItem", () => {
  it("stores SECTION_LINK localization mediaType as NONE", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: async () => ({ id: "tpl", baseLanguageCode: "ru" }),
        update: async () => ({}),
        create: async () => ({ id: "tpl" }),
      },
      presentationLocalization: {
        createMany: async () => ({}),
      },
      pageNavConfig: {
        findUnique: async () => null,
        upsert: async () => ({})
      },
      menuItem: {
        count: async () => 0,
        create: async ({ data }: any) => {
          expect(data.type).toBe("SECTION_LINK");
          expect(data.localizations.create.mediaType).toBe("NONE");
          expect(data.targetMenuItemId).toBe("target-page");
          expect(data.parentId).toBe("parent-page");
          return { id: "new-item" };
        },
      },
    };

    const i18n: any = {};
    const accessRules: any = {};
    const analytics: any = {};
    const abTests: any = {};
    const audit: any = { log: async () => {} };

    const svc = new MenuService(prisma, i18n, accessRules, analytics, abTests, audit);

    await svc.createMenuItem({
      actorUserId: "actor",
      languageCode: "ru",
      parentId: "parent-page",
      title: "My link button",
      type: "SECTION_LINK",
      targetMenuItemId: "target-page",
    });
  });

  it("stores EXTERNAL_LINK localization mediaType as NONE and externalUrl", async () => {
    const prisma: any = {
      presentationTemplate: {
        findFirst: async () => ({ id: "tpl", baseLanguageCode: "ru" }),
        update: async () => ({}),
        create: async () => ({ id: "tpl" }),
      },
      presentationLocalization: {
        createMany: async () => ({}),
      },
      pageNavConfig: {
        findUnique: async () => null,
        upsert: async () => ({})
      },
      menuItem: {
        count: async () => 0,
        create: async ({ data }: any) => {
          expect(data.type).toBe("EXTERNAL_LINK");
          expect(data.localizations.create.mediaType).toBe("NONE");
          expect(data.localizations.create.externalUrl).toBe("https://example.com/docs");
          expect(data.parentId).toBe("parent-page");
          return { id: "new-item" };
        },
      },
    };

    const i18n: any = {};
    const accessRules: any = {};
    const analytics: any = {};
    const abTests: any = {};
    const audit: any = { log: async () => {} };

    const svc = new MenuService(prisma, i18n, accessRules, analytics, abTests, audit);

    await svc.createMenuItem({
      actorUserId: "actor",
      languageCode: "ru",
      parentId: "parent-page",
      title: "Docs button",
      type: "EXTERNAL_LINK",
      externalUrl: "https://example.com/docs",
    });
  });
});
