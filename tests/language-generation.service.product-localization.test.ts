import { describe, expect, it, vi } from "vitest";

import { LanguageGenerationService } from "../src/modules/ai/language-generation.service";

describe("LanguageGenerationService.ensureTargetLanguageLayer", () => {
  it("creates missing target ProductLocalization rows for linked products", async () => {
    const productFindMany = vi.fn(async (args: any) => {
      const lang = args?.where?.languageCode;
      if (lang === "ru") {
        return [
          {
            productId: "prod-1",
            title: "Тариф",
            description: "Описание",
            payButtonText: "Оплатить"
          }
        ];
      }
      if (lang === "en") {
        return [];
      }
      return [];
    });
    const productCreateMany = vi.fn().mockResolvedValue({ count: 1 });

    const prisma: any = {
      presentationLocalization: {
        findUnique: vi.fn().mockResolvedValue({
          templateId: "tpl-1",
          languageCode: "ru",
          welcomeText: "Привет"
        })
      },
      presentationLocalizationDraft: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(undefined)
      },
      menuItemLocalization: {
        findMany: vi.fn().mockResolvedValue([])
      },
      menuItemLocalizationDraft: {
        createMany: vi.fn().mockResolvedValue({ count: 0 })
      },
      productLocalization: {
        findMany: productFindMany,
        createMany: productCreateMany
      }
    };

    const service = new LanguageGenerationService(prisma, {
      i18n: {} as any,
      navigation: {} as any,
      telegram: {} as any
    });

    await service.ensureTargetLanguageLayer({
      templateId: "tpl-1",
      sourceLanguageCode: "ru",
      targetLanguageCode: "en",
      menuItems: [
        {
          id: "m1",
          key: "k1",
          type: "TEXT",
          parentId: null,
          sortOrder: 0,
          productId: "prod-1"
        }
      ]
    });

    expect(productCreateMany).toHaveBeenCalledTimes(1);
    expect(productCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            productId: "prod-1",
            languageCode: "en",
            payButtonText: "Оплатить"
          })
        ],
        skipDuplicates: true
      })
    );
  });
});
