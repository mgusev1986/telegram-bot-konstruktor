import { describe, expect, it, vi } from "vitest";

import { LanguageGenerationTaskService } from "../src/modules/ai/language-generation-task.service";

describe("LanguageGenerationTaskService", () => {
  it("creates translation task with initial progress", async () => {
    const prisma = {
      languageGenerationTask: {
        create: vi.fn().mockResolvedValue({
          id: "task-1",
          status: "PENDING",
          totalItems: 0,
          completedItems: 0,
          progressPercent: 0
        })
      }
    } as any;

    const i18n = {} as any;
    const service = new LanguageGenerationTaskService(prisma, i18n);
    const task = await service.createTask({
      templateId: "tpl-1",
      startedByUserId: "user-1",
      sourceLanguageCode: "ru",
      targetLanguageCode: "en"
    });

    expect(task.id).toBe("task-1");
    expect(prisma.languageGenerationTask.create).toHaveBeenCalledOnce();
    expect(prisma.languageGenerationTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateId: "tpl-1",
          startedByUserId: "user-1",
          sourceLanguageCode: "ru",
          targetLanguageCode: "en",
          progressPercent: 0
        })
      })
    );
  });
});
