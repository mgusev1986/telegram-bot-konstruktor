import type { LanguageGenerationTask, LanguageGenerationTaskItem, PrismaClient } from "@prisma/client";
import { Markup } from "telegraf";
import type { Telegram } from "telegraf";
import type { User } from "@prisma/client";

import { makeCallbackData } from "../../common/callback-data";
import { NAV_ROOT_DATA } from "../../bot/keyboards";
import { NavigationService } from "../navigation/navigation.service";
import type { I18nService } from "../i18n/i18n.service";
import type { AuditService } from "../audit/audit.service";
import { AiTranslationService } from "./ai-translation.service";

import { logger } from "../../common/logger";
import { env } from "../../config/env";

type Stage = "root/welcome" | "pages" | "subsections" | "buttons";

const MILESTONES = new Set([0, 10, 25, 40, 65, 80, 100]);

type MenuItemShallow = {
  id: string;
  key: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
  productId?: string | null;
};

export class LanguageGenerationService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: {
      i18n: I18nService;
      navigation: NavigationService;
      telegram: Telegram;
      aiTranslation?: AiTranslationService;
      audit?: AuditService;
    }
  ) {}

  private async renderProgressScreen(params: {
    actor: User;
    task: LanguageGenerationTask;
    targetLanguageLabel: string;
    stage: Stage;
    milestonesOnly?: boolean;
    progressPercent: number;
    completedItems: number;
    totalItems: number;
  }): Promise<void> {
    const uiLocale = this.deps.i18n.resolveLanguage(params.actor.selectedLanguage);
    const text = [
      `⏳ Создаём языковую версию: ${params.targetLanguageLabel}`,
      `Этап: ${params.stage}`,
      `Прогресс: ${params.progressPercent}%`,
      `Переведено: ${params.completedItems} из ${params.totalItems}`
    ].join("\n");

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(this.deps.i18n.t(uiLocale, "back"), makeCallbackData("admin", "languages"))],
      [Markup.button.callback(this.deps.i18n.t(uiLocale, "structure_refresh"), makeCallbackData("admin", "lang_gen_refresh", params.task.id))],
      [Markup.button.callback(this.deps.i18n.t(uiLocale, "to_main_menu"), NAV_ROOT_DATA)]
    ]);

    await this.deps.navigation.replaceScreen(
      params.actor,
      this.deps.telegram,
      params.actor.telegramUserId,
      { text },
      kb
    );
  }

  private getMenuItemStage(depth: Map<string, number>, item: MenuItemShallow): Stage {
    if (item.type === "SECTION_LINK") return "buttons";
    const d = depth.get(item.id) ?? 1;
    if (d <= 1) return "pages";
    return "subsections";
  }

  private getMenuItemsDepthMap(menuItems: MenuItemShallow[]): Map<string, number> {
    const childrenByParent = new Map<string | null, MenuItemShallow[]>();
    const byId = new Map<string, MenuItemShallow>();
    for (const mi of menuItems) {
      byId.set(mi.id, mi);
      const pid = mi.parentId ?? null;
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid)!.push(mi);
    }

    const depth = new Map<string, number>();
    const visit = (id: string, d: number) => {
      depth.set(id, d);
      const item = byId.get(id);
      if (!item) return;
      for (const child of childrenByParent.get(id) ?? []) visit(child.id, d + 1);
    };

    // Root has parentId = null for first-level sections/pages.
    for (const firstLevel of childrenByParent.get(null) ?? []) {
      visit(firstLevel.id, 1);
    }

    // Orphan-safe: items not reachable from root get depth=1.
    for (const mi of menuItems) {
      if (!depth.has(mi.id)) depth.set(mi.id, 1);
    }

    return depth;
  }

  public async ensureTargetLanguageLayer(params: {
    templateId: string;
    sourceLanguageCode: string;
    targetLanguageCode: string;
    menuItems: MenuItemShallow[];
  }): Promise<{
    sourcePresentationWelcomeText: string;
    sourceMenuItemLocalizationsById: Map<string, { title: string; contentText: string }>;
    sourceProductLocalizationsByProductId: Map<string, { title: string; description: string; payButtonText: string }>;
  }> {
    const { templateId, sourceLanguageCode, targetLanguageCode, menuItems } = params;

    const sourcePresentation = await this.prisma.presentationLocalization.findUnique({
      where: { templateId_languageCode: { templateId, languageCode: sourceLanguageCode } }
    });

    // Draft rows are what the admin preview/editor uses.
    const targetPresentationDraft = await this.prisma.presentationLocalizationDraft.findUnique({
      where: { templateId_languageCode: { templateId, languageCode: targetLanguageCode } }
    });

    if (!targetPresentationDraft) {
      await this.prisma.presentationLocalizationDraft.create({
        data: {
          templateId,
          languageCode: targetLanguageCode,
          welcomeText: sourcePresentation?.welcomeText ?? "",
          welcomeMediaType: sourcePresentation?.welcomeMediaType ?? "NONE",
          welcomeMediaFileId: sourcePresentation?.welcomeMediaFileId ?? undefined
        }
      });
    }

    const sourceMenuItems = await this.prisma.menuItemLocalization.findMany({
      where: {
        languageCode: sourceLanguageCode,
        menuItem: { templateId }
      },
      select: {
        menuItemId: true,
        title: true,
        contentText: true,
        mediaType: true,
        mediaFileId: true,
        externalUrl: true
      }
    });

    const sourceById = new Map<string, { title: string; contentText: string }>();
    for (const loc of sourceMenuItems) {
      sourceById.set(loc.menuItemId, { title: loc.title, contentText: loc.contentText });
    }

    // Create missing MenuItemLocalizationDraft rows for the target language, preserving media fields.
    const createData = menuItems.map((item) => {
      const src = sourceMenuItems.find((l) => l.menuItemId === item.id);
      return {
        menuItemId: item.id,
        languageCode: targetLanguageCode,
        title: src?.title ?? item.key,
        contentText: src?.contentText ?? "",
        mediaType: src?.mediaType ?? "NONE",
        mediaFileId: src?.mediaFileId ?? undefined,
        externalUrl: src?.externalUrl ?? undefined
      };
    });

    await this.prisma.menuItemLocalizationDraft.createMany({
      data: createData,
      skipDuplicates: true
    });

    const productIds = Array.from(
      new Set(
        menuItems
          .map((item) => item.productId ?? null)
          .filter((id): id is string => Boolean(id))
      )
    );

    const sourceProductLocalizationsByProductId = new Map<string, { title: string; description: string; payButtonText: string }>();
    if (productIds.length > 0) {
      const sourceProductLocs = await this.prisma.productLocalization.findMany({
        where: {
          productId: { in: productIds },
          languageCode: sourceLanguageCode
        },
        select: {
          productId: true,
          title: true,
          description: true,
          payButtonText: true
        }
      });

      for (const loc of sourceProductLocs) {
        sourceProductLocalizationsByProductId.set(loc.productId, {
          title: loc.title ?? "",
          description: loc.description ?? "",
          payButtonText: loc.payButtonText ?? ""
        });
      }

      const existingTargetProductLocs = await this.prisma.productLocalization.findMany({
        where: {
          productId: { in: productIds },
          languageCode: targetLanguageCode
        },
        select: { productId: true }
      });
      const existingProductIds = new Set(existingTargetProductLocs.map((loc) => loc.productId));
      const missingRows = productIds
        .filter((productId) => !existingProductIds.has(productId))
        .map((productId) => {
          const src = sourceProductLocalizationsByProductId.get(productId);
          return {
            productId,
            languageCode: targetLanguageCode,
            title: src?.title ?? "",
            description: src?.description ?? "",
            payButtonText: src?.payButtonText ?? ""
          };
        });
      if (missingRows.length > 0) {
        await this.prisma.productLocalization.createMany({
          data: missingRows,
          skipDuplicates: true
        });
      }
    }

    return {
      sourcePresentationWelcomeText: sourcePresentation?.welcomeText ?? "",
      sourceMenuItemLocalizationsById: sourceById,
      sourceProductLocalizationsByProductId
    };
  }

  public async processTask(taskId: string): Promise<void> {
    const task = await this.prisma.languageGenerationTask.findUniqueOrThrow({
      where: { id: taskId }
    });

    if (task.status === "DONE") return;

    const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: task.startedByUserId } });
    const aiTranslation = this.deps.aiTranslation ?? new AiTranslationService();
    logger.info(
      {
        taskId,
        templateId: task.templateId,
        sourceLanguageCode: task.sourceLanguageCode,
        targetLanguageCode: task.targetLanguageCode
      },
      "Language generation task started"
    );

    const template = await this.prisma.presentationTemplate.findUniqueOrThrow({ where: { id: task.templateId } });

    // Load shallow menu items for ordering/stage detection.
    const menuItems = await this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      select: {
        id: true,
        key: true,
        type: true,
        parentId: true,
        sortOrder: true,
        productId: true
      },
      orderBy: [
        { parentId: "asc" },
        { sortOrder: "asc" }
      ]
    });

    const menuItemsShallow: MenuItemShallow[] = menuItems.map((m: any) => ({
      id: m.id,
      key: m.key,
      type: m.type,
      parentId: m.parentId,
      sortOrder: m.sortOrder,
      productId: m.productId ?? null
    }));

    const depthMap = this.getMenuItemsDepthMap(menuItemsShallow);

    await this.prisma.languageGenerationTask.update({
      where: { id: taskId },
      data: { status: task.status === "PENDING" ? "RUNNING" : task.status, startedAt: task.startedAt ?? new Date() }
    });

    // Pre-create localizations for target language (safe, media preserved).
    const { sourcePresentationWelcomeText, sourceMenuItemLocalizationsById, sourceProductLocalizationsByProductId } = await this.ensureTargetLanguageLayer({
      templateId: template.id,
      sourceLanguageCode: task.sourceLanguageCode,
      targetLanguageCode: task.targetLanguageCode,
      menuItems: menuItemsShallow
    });

    // Create task items once (resume-safe). If items already exist, we continue from DONE statuses.
    const existingTaskItems = await this.prisma.languageGenerationTaskItem.findMany({
      where: { taskId }
    });

    const totalItems = 1 + menuItemsShallow.length;

    if (existingTaskItems.length === 0) {
      await this.prisma.languageGenerationTaskItem.createMany({
        data: [
          { taskId, entityType: "PRESENTATION" as const, entityId: "root_welcome" },
          ...menuItemsShallow.map((mi) => ({ taskId, entityType: "MENU_ITEM" as const, entityId: mi.id }))
        ],
        skipDuplicates: false
      });
      await this.prisma.languageGenerationTask.update({
        where: { id: taskId },
        data: { totalItems, completedItems: 0, progressPercent: 0 }
      });
    }

    const taskItems = await this.prisma.languageGenerationTaskItem.findMany({
      where: { taskId },
      orderBy: [{ entityType: "asc" }, { entityId: "asc" }]
    });

    let completedItems = taskItems.filter((i: any) => i.status === "DONE").length;
    let lastNotified = task.progressPercent;

    const targetLanguageLabel =
      this.deps.i18n.availableLanguages().find((l) => l.code === task.targetLanguageCode)?.label ?? task.targetLanguageCode;

    // Sort translation order into meaningful stages.
    const stagePriority: Record<Stage, number> = { "root/welcome": 0, pages: 1, subsections: 2, buttons: 3 };
    const presentationId = "root_welcome";

    const ordered = [...taskItems].sort((a: LanguageGenerationTaskItem, b: LanguageGenerationTaskItem) => {
      const aStage: Stage =
        a.entityType === "PRESENTATION"
          ? "root/welcome"
          : (() => {
              const mi = menuItemsShallow.find((x) => x.id === a.entityId);
              if (!mi) return "subsections";
              return this.getMenuItemStage(depthMap, mi);
            })();
      const bStage: Stage =
        b.entityType === "PRESENTATION"
          ? "root/welcome"
          : (() => {
              const mi = menuItemsShallow.find((x) => x.id === b.entityId);
              if (!mi) return "subsections";
              return this.getMenuItemStage(depthMap, mi);
            })();

      return stagePriority[aStage] - stagePriority[bStage];
    });

    // Milestone notify for current state (resume-safe).
    const initialPercent = totalItems ? Math.round((completedItems / totalItems) * 100) : 0;
    if (MILESTONES.has(initialPercent) && initialPercent !== lastNotified) {
      await this.renderProgressScreen({
        actor,
        task: { ...task, progressPercent: initialPercent, completedItems },
        targetLanguageLabel,
        stage: "root/welcome",
        progressPercent: initialPercent,
        completedItems,
        totalItems
      });
      lastNotified = initialPercent;
    }

    const batchSize = Math.max(1, env.TRANSLATION_BATCH_SIZE ?? env.AI_TRANSLATION_BATCH_SIZE);
    for (let start = 0; start < ordered.length; start += batchSize) {
      const chunk = ordered.slice(start, start + batchSize);
      const pending = chunk.filter((i) => i.status !== "DONE");
      if (pending.length === 0) continue;

      const presentationItems = pending.filter((i) => i.entityType === "PRESENTATION");
      const menuItemsToTranslate = pending.filter((i) => i.entityType === "MENU_ITEM");

      // 1) Translate root/welcome within chunk (rarely more than 1 item).
      for (const item of presentationItems) {
        const stage: Stage = "root/welcome";
        try {
          const welcomeToTranslate = sourcePresentationWelcomeText;
          const translatedWelcome = welcomeToTranslate.trim()
            ? await aiTranslation.translateText({
                text: welcomeToTranslate,
                sourceLanguageCode: task.sourceLanguageCode,
                targetLanguageCode: task.targetLanguageCode
              })
            : "";

          await this.prisma.presentationLocalizationDraft.update({
            where: {
              templateId_languageCode: {
                templateId: task.templateId,
                languageCode: task.targetLanguageCode
              }
            },
            data: { welcomeText: translatedWelcome }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ taskId, itemId: item.id, msg }, "Language generation item failed");
          await this.prisma.languageGenerationTaskItem.update({
            where: { id: item.id },
            data: { status: "FAILED", errorMessage: msg }
          });
          await this.prisma.languageGenerationTask.update({
            where: { id: taskId },
            data: { status: "FAILED", errorMessage: msg, finishedAt: new Date() }
          });
          throw err;
        }

        try {
          await this.prisma.languageGenerationTaskItem.update({
            where: { id: item.id },
            data: { status: "DONE" }
          });

          completedItems += 1;
          const percent = totalItems ? Math.round((completedItems / totalItems) * 100) : 0;

          await this.prisma.languageGenerationTask.update({
            where: { id: taskId },
            data: { completedItems, progressPercent: percent, status: "RUNNING" }
          });

          if (MILESTONES.has(percent) && percent !== lastNotified) {
            logger.info({ taskId, percent, completedItems, totalItems, stage }, "Language generation progress milestone");
            const refreshedActor = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
            await this.renderProgressScreen({
              actor: refreshedActor,
              task: { ...task, progressPercent: percent, completedItems } as any,
              targetLanguageLabel,
              stage,
              progressPercent: percent,
              completedItems,
              totalItems
            });
            lastNotified = percent;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ taskId, itemId: item.id, msg }, "Language generation item post-update failed");
          await this.prisma.languageGenerationTaskItem.update({
            where: { id: item.id },
            data: { status: "FAILED", errorMessage: msg }
          });
          await this.prisma.languageGenerationTask.update({
            where: { id: taskId },
            data: { status: "FAILED", errorMessage: msg, finishedAt: new Date() }
          });
          throw err;
        }
      }

      // 2) Translate MENU_ITEMs in batch within chunk.
      if (menuItemsToTranslate.length > 0) {
        const titleJobs: Array<{
          taskItemId: string;
          text: string;
        }> = [];
        const contentJobs: Array<{
          taskItemId: string;
          text: string;
        }> = [];

        type MenuMeta = {
          mi: MenuItemShallow;
          titleSource: string;
          contentSource: string;
          stage: Stage;
        };

        const metaByTaskItemId = new Map<string, MenuMeta>();

        try {
          for (const item of menuItemsToTranslate) {
            const mi = menuItemsShallow.find((x) => x.id === item.entityId);
            if (!mi) throw new Error(`MenuItem not found for task item: ${item.entityId}`);

            const srcLoc = sourceMenuItemLocalizationsById.get(mi.id);
            const titleSource = srcLoc?.title ?? mi.key ?? "";
            const contentSource = srcLoc?.contentText ?? "";

            const stage = this.getMenuItemStage(depthMap, mi);
            metaByTaskItemId.set(item.id, { mi, titleSource, contentSource, stage });

            if (titleSource.trim()) titleJobs.push({ taskItemId: item.id, text: titleSource });
            if (contentSource.trim()) contentJobs.push({ taskItemId: item.id, text: contentSource });
          }

          const titleInputs = titleJobs.map((j) => ({
            text: j.text,
            sourceLanguageCode: task.sourceLanguageCode,
            targetLanguageCode: task.targetLanguageCode
          }));
          const contentInputs = contentJobs.map((j) => ({
            text: j.text,
            sourceLanguageCode: task.sourceLanguageCode,
            targetLanguageCode: task.targetLanguageCode
          }));

          const titleTranslations = titleInputs.length ? await aiTranslation.translateBatch(titleInputs) : [];
          const contentTranslations = contentInputs.length ? await aiTranslation.translateBatch(contentInputs) : [];

          const titleByTaskItemId = new Map<string, string>();
          for (let i = 0; i < titleJobs.length; i++) {
            titleByTaskItemId.set(titleJobs[i]!.taskItemId, titleTranslations[i]!);
          }
          const contentByTaskItemId = new Map<string, string>();
          for (let i = 0; i < contentJobs.length; i++) {
            contentByTaskItemId.set(contentJobs[i]!.taskItemId, contentTranslations[i]!);
          }

          // Persist translations sequentially to keep status/progress deterministic.
          for (const item of menuItemsToTranslate) {
            const meta = metaByTaskItemId.get(item.id);
            if (!meta) throw new Error(`Missing meta for task item ${item.id}`);

            try {
              const updateData: { title: string; contentText?: string } = { title: meta.titleSource };

              if (meta.titleSource.trim()) {
                updateData.title = titleByTaskItemId.get(item.id) ?? meta.titleSource;
              }
              if (meta.contentSource.trim()) {
                updateData.contentText = contentByTaskItemId.get(item.id) ?? meta.contentSource;
              }

              await this.prisma.menuItemLocalizationDraft.update({
                where: {
                  menuItemId_languageCode: {
                    menuItemId: meta.mi.id,
                    languageCode: task.targetLanguageCode
                  }
                },
                data: updateData
              });

              await this.prisma.languageGenerationTaskItem.update({
                where: { id: item.id },
                data: { status: "DONE" }
              });

              completedItems += 1;
              const percent = totalItems ? Math.round((completedItems / totalItems) * 100) : 0;

              await this.prisma.languageGenerationTask.update({
                where: { id: taskId },
                data: { completedItems, progressPercent: percent, status: "RUNNING" }
              });

              if (MILESTONES.has(percent) && percent !== lastNotified) {
                logger.info(
                  { taskId, percent, completedItems, totalItems, stage: meta.stage },
                  "Language generation progress milestone"
                );
                const refreshedActor = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
                await this.renderProgressScreen({
                  actor: refreshedActor,
                  task: { ...task, progressPercent: percent, completedItems } as any,
                  targetLanguageLabel,
                  stage: meta.stage,
                  progressPercent: percent,
                  completedItems,
                  totalItems
                });
                lastNotified = percent;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ taskId, itemId: item.id, msg }, "Language generation item failed");

              await this.prisma.languageGenerationTaskItem.update({
                where: { id: item.id },
                data: { status: "FAILED", errorMessage: msg }
              });

              await this.prisma.languageGenerationTask.update({
                where: { id: taskId },
                data: { status: "FAILED", errorMessage: msg, finishedAt: new Date() }
              });

              throw err;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ taskId, msg }, "Language generation menu batch failed");

          await Promise.all(
            menuItemsToTranslate.map((item) =>
              this.prisma.languageGenerationTaskItem.update({
                where: { id: item.id },
                data: { status: "FAILED", errorMessage: msg }
              })
            )
          );

          await this.prisma.languageGenerationTask.update({
            where: { id: taskId },
            data: { status: "FAILED", errorMessage: msg, finishedAt: new Date() }
          });

          throw err;
        }
      }
    }

    // Translate product localizations used by menu items (title/description/pay button).
    const productIds = Array.from(sourceProductLocalizationsByProductId.keys());
    if (productIds.length > 0) {
      const jobsTitle: Array<{ productId: string; text: string }> = [];
      const jobsDescription: Array<{ productId: string; text: string }> = [];
      const jobsPay: Array<{ productId: string; text: string }> = [];
      for (const productId of productIds) {
        const src = sourceProductLocalizationsByProductId.get(productId);
        if (!src) continue;
        if (src.title.trim()) jobsTitle.push({ productId, text: src.title });
        if (src.description.trim()) jobsDescription.push({ productId, text: src.description });
        if (src.payButtonText.trim()) jobsPay.push({ productId, text: src.payButtonText });
      }

      const makeInput = (text: string) => ({
        text,
        sourceLanguageCode: task.sourceLanguageCode,
        targetLanguageCode: task.targetLanguageCode
      });
      const [translatedTitles, translatedDescriptions, translatedPays] = await Promise.all([
        jobsTitle.length ? aiTranslation.translateBatch(jobsTitle.map((j) => makeInput(j.text))) : Promise.resolve([] as string[]),
        jobsDescription.length ? aiTranslation.translateBatch(jobsDescription.map((j) => makeInput(j.text))) : Promise.resolve([] as string[]),
        jobsPay.length ? aiTranslation.translateBatch(jobsPay.map((j) => makeInput(j.text))) : Promise.resolve([] as string[])
      ]);

      const byProductId = new Map<string, { title?: string; description?: string; payButtonText?: string }>();
      for (let i = 0; i < jobsTitle.length; i++) {
        const row = byProductId.get(jobsTitle[i]!.productId) ?? {};
        row.title = translatedTitles[i] ?? jobsTitle[i]!.text;
        byProductId.set(jobsTitle[i]!.productId, row);
      }
      for (let i = 0; i < jobsDescription.length; i++) {
        const row = byProductId.get(jobsDescription[i]!.productId) ?? {};
        row.description = translatedDescriptions[i] ?? jobsDescription[i]!.text;
        byProductId.set(jobsDescription[i]!.productId, row);
      }
      for (let i = 0; i < jobsPay.length; i++) {
        const row = byProductId.get(jobsPay[i]!.productId) ?? {};
        row.payButtonText = translatedPays[i] ?? jobsPay[i]!.text;
        byProductId.set(jobsPay[i]!.productId, row);
      }

      for (const productId of productIds) {
        const patch = byProductId.get(productId) ?? {};
        await this.prisma.productLocalization.update({
          where: {
            productId_languageCode: {
              productId,
              languageCode: task.targetLanguageCode
            }
          },
          data: {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.payButtonText !== undefined ? { payButtonText: patch.payButtonText } : {})
          }
        });
      }
    }

    // Finalize.
    await this.prisma.languageGenerationTask.update({
      where: { id: taskId },
      data: { status: "DONE", completedItems, progressPercent: 100, finishedAt: new Date() }
    });
    await this.prisma.localizationLayerState.upsert({
      where: {
        templateId_languageCode: {
          templateId: task.templateId,
          languageCode: task.targetLanguageCode
        }
      },
      update: {
        status: "DRAFT",
        lastEditedByUserId: actor.id,
        draftSavedAt: new Date(),
        publishedAt: null
      },
      create: {
        templateId: task.templateId,
        languageCode: task.targetLanguageCode,
        status: "DRAFT",
        createdByUserId: actor.id,
        lastEditedByUserId: actor.id,
        draftSavedAt: new Date(),
        publishedAt: null
      }
    });
    logger.info({ taskId, completedItems, totalItems }, "Language generation task completed");

    this.deps.audit?.log(actor.id, "language_generation_completed", "language_generation_task", taskId, {
      templateId: task.templateId,
      sourceLanguageCode: task.sourceLanguageCode,
      targetLanguageCode: task.targetLanguageCode,
      completedItems,
      totalItems
    });

    const uiLocale = this.deps.i18n.resolveLanguage(actor.selectedLanguage);
    const fallbackUsage = aiTranslation.getFallbackUsage();
    const fallbackLine =
      fallbackUsage && fallbackUsage.fallbackUsedCount > 0
        ? this.deps.i18n.t(uiLocale, "language_generation_done_fallback_applied").replace("{{count}}", String(fallbackUsage.fallbackUsedCount))
        : null;

    const providerUsedKind = aiTranslation.getUsedProviderKind();
    const providerUsedLine = providerUsedKind
      ? this.deps.i18n
          .t(uiLocale, "language_generation_done_provider_used")
          .replace("{{provider}}", String(providerUsedKind))
      : null;

    const finalText = [
      `✅ ${this.deps.i18n.t(uiLocale, "language_generation_done_title").replace("{{lang}}", targetLanguageLabel)}`,
      this.deps.i18n
        .t(uiLocale, "language_generation_done_translated")
        .replace("{{done}}", String(completedItems))
        .replace("{{total}}", String(totalItems)),
      ...(fallbackLine ? [fallbackLine] : []),
      ...(providerUsedLine ? [providerUsedLine] : []),
      this.deps.i18n.t(uiLocale, "language_generation_done_draft"),
      this.deps.i18n.t(uiLocale, "language_generation_done_next"),
      ""
    ].join("\n");

    const refreshedActor = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          this.deps.i18n.t(uiLocale, "language_version_edit_btn").replace("{{lang}}", targetLanguageLabel),
          makeCallbackData("admin", "edit_lang_version", task.targetLanguageCode)
        )
      ],
      [Markup.button.callback(this.deps.i18n.t(this.deps.i18n.resolveLanguage(refreshedActor.selectedLanguage), "back"), makeCallbackData("admin", "languages"))],
      [Markup.button.callback(this.deps.i18n.t(this.deps.i18n.resolveLanguage(refreshedActor.selectedLanguage), "to_main_menu"), NAV_ROOT_DATA)]
    ]);

    await this.deps.navigation.replaceScreen(refreshedActor, this.deps.telegram, refreshedActor.telegramUserId, { text: finalText }, kb);
  }
}
