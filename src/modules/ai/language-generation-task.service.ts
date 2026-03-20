import type { LanguageGenerationTask, PrismaClient } from "@prisma/client";

import type { I18nService } from "../i18n/i18n.service";

export class LanguageGenerationTaskService {
  public constructor(private readonly prisma: PrismaClient, private readonly _i18n: I18nService) {}

  public async createTask(params: {
    templateId: string;
    startedByUserId: string;
    sourceLanguageCode: string;
    targetLanguageCode: string;
  }): Promise<LanguageGenerationTask> {
    return this.prisma.languageGenerationTask.create({
      data: {
        templateId: params.templateId,
        startedByUserId: params.startedByUserId,
        sourceLanguageCode: params.sourceLanguageCode,
        targetLanguageCode: params.targetLanguageCode,
        totalItems: 0,
        completedItems: 0,
        progressPercent: 0
      }
    });
  }

  public async getTask(taskId: string): Promise<LanguageGenerationTask | null> {
    return this.prisma.languageGenerationTask.findUnique({ where: { id: taskId } });
  }
}

