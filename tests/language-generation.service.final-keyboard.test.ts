import { describe, expect, it, vi } from "vitest";

import { LanguageGenerationService } from "../src/modules/ai/language-generation.service";

describe("LanguageGenerationService final keyboard labels", () => {
  it("does not duplicate emoji and renders translated counters", async () => {
    const replaceScreen = vi.fn().mockResolvedValue(undefined);

    const prisma: any = {
      languageGenerationTask: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "task-1",
          status: "RUNNING",
          templateId: "tpl-1",
          sourceLanguageCode: "ru",
          targetLanguageCode: "en",
          startedByUserId: "user-1",
          progressPercent: 0
        }),
        update: vi.fn().mockResolvedValue(undefined)
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "user-1",
          selectedLanguage: "ru",
          telegramUserId: BigInt(1)
        }),
        findUnique: vi.fn().mockResolvedValue({
          id: "user-1",
          selectedLanguage: "ru",
          telegramUserId: BigInt(1)
        })
      },
      presentationTemplate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "tpl-1" })
      },
      menuItem: {
        findMany: vi.fn().mockResolvedValue([])
      },
      presentationLocalization: {
        findUnique: vi.fn().mockResolvedValue({ welcomeText: "Привет", welcomeMediaType: "NONE", welcomeMediaFileId: null })
      },
      presentationLocalizationDraft: {
        findUnique: vi.fn().mockResolvedValue({ templateId: "tpl-1", languageCode: "en", welcomeText: "Hello" })
      },
      menuItemLocalization: {
        findMany: vi.fn().mockResolvedValue([])
      },
      menuItemLocalizationDraft: {
        createMany: vi.fn().mockResolvedValue({ count: 0 })
      },
      productLocalization: {
        findMany: vi.fn().mockResolvedValue([])
      },
      languageGenerationTaskItem: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: "i1", taskId: "task-1", entityType: "PRESENTATION", entityId: "root_welcome", status: "DONE" }
          ])
          .mockResolvedValueOnce([
            { id: "i1", taskId: "task-1", entityType: "PRESENTATION", entityId: "root_welcome", status: "DONE" }
          ])
      },
      localizationLayerState: {
        upsert: vi.fn().mockResolvedValue(undefined)
      }
    };

    const i18n: any = {
      resolveLanguage: () => "ru",
      availableLanguages: () => [{ code: "en", label: "English" }],
      t: (_lang: string, key: string) => {
        if (key === "language_version_open_btn") return "👁 Открыть версию";
        if (key === "language_version_edit_btn") return "🛠 Редактировать версию";
        if (key === "back") return "↩️ Назад";
        if (key === "to_main_menu") return "🗂 В главное меню";
        if (key === "language_generation_done_title") return "Языковая версия готова";
        if (key === "language_generation_done_translated") return "Переведено: {{done}} из {{total}}";
        if (key === "language_generation_done_draft") return "Статус: черновик";
        if (key === "language_generation_done_next") return "Следующий шаг:";
        return key;
      }
    };

    const service = new LanguageGenerationService(prisma, {
      i18n,
      navigation: { replaceScreen } as any,
      telegram: {} as any
    });

    await service.processTask("task-1");

    expect(replaceScreen).toHaveBeenCalled();
    const textArg = replaceScreen.mock.calls.at(-1)?.[3]?.text ?? "";
    const keyboardArg = replaceScreen.mock.calls.at(-1)?.[4];
    const rows = keyboardArg?.reply_markup?.inline_keyboard ?? [];
    const firstText = rows[0]?.[0]?.text ?? "";
    const secondText = rows[1]?.[0]?.text ?? "";

    expect(textArg).toContain("Переведено: 1 из 1");
    expect(firstText).toBe("👁 Открыть версию");
    expect(secondText).toBe("🛠 Редактировать версию");
    expect(firstText.includes("👁 👁")).toBe(false);
    expect(secondText.includes("🛠 🛠")).toBe(false);
  });
});
