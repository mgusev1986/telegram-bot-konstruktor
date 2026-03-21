import { MediaType, type MenuItem, type MenuItemLocalization, type PrismaClient, type Product, type User } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { logger } from "../../common/logger";
import { maybeFormatForTelegram } from "../../common/content-formatting";
import { applyPersonalization } from "../../common/personalization";
import type { AbTestService } from "../ab/ab-test.service";
import type { AccessRuleService } from "../access/access-rule.service";
import type { AnalyticsService } from "../analytics/analytics.service";
import type { AuditService } from "../audit/audit.service";
import type { I18nService } from "../i18n/i18n.service";
import { env } from "../../config/env";
import {
  buildNavigationGraph,
  validateNavigationGraph,
  type NavigationAuditError
} from "./navigation-audit";

export interface CreateMenuItemInput {
  actorUserId: string;
  languageCode: string;
  parentId?: string | null;
  key?: string;
  title: string;
  contentText?: string;
  type: "TEXT" | "PHOTO" | "VIDEO" | "DOCUMENT" | "LINK" | "SUBMENU" | "SECTION_LINK";
  mediaType?: MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
  targetMenuItemId?: string | null;
  visibilityMode?: "SHOW" | "HIDE" | "LOCK";
  productId?: string | null;
  accessRuleId?: string | null;
}

type LocalizedMenuItem = MenuItem & {
  localizations: MenuItemLocalization[];
  product: Product | null;
};

export type SystemTargetKind = "my_cabinet" | "partner_register" | "mentor_contact" | "change_language";

export interface AddLanguageVersionResult {
  languageCode: string;
  sourceLanguageCode: string;
  welcomeCopied: boolean;
  createdMenuItemLocalizations: number;
  totalMenuItems: number;
}

export interface DeleteLanguageVersionResult {
  languageCode: string;
  deletedWelcome: boolean;
  deletedMenuItemLocalizations: number;
}

export interface LocalizedContentSnapshot {
  contentText: string;
  mediaType: MediaType;
  mediaFileId: string | null;
  externalUrl: string | null;
  exactMatch: boolean;
  source: "DRAFT" | "PUBLISHED";
}

export class MenuService {
  private readonly botInstanceId?: string;
  private readonly paidAccessEnabled: boolean;
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly i18n: I18nService,
    private readonly accessRules: AccessRuleService,
    private readonly analytics: AnalyticsService,
    private readonly abTests: AbTestService,
    private readonly audit: AuditService,
    botInstanceId?: string,
    paidAccessEnabled: boolean = true
  ) {
    this.botInstanceId = botInstanceId;
    this.paidAccessEnabled = paidAccessEnabled;
  }

  private activeTemplateWhere(): any {
    return this.botInstanceId ? { isActive: true, botInstanceId: this.botInstanceId } : { isActive: true };
  }

  /** Returns custom paywall message for the bot, or null if not set (use default i18n). */
  public async getPaywallMessage(): Promise<string | null> {
    if (!this.botInstanceId) return null;
    const bot = await this.prisma.botInstance.findUnique({
      where: { id: this.botInstanceId },
      select: { paywallMessage: true }
    });
    const msg = bot?.paywallMessage?.trim();
    return msg || null;
  }

  /** Returns active template id. If baseLanguageCode is provided and template exists, updates it; if creating, uses it. */
  public async ensureActiveTemplate(actorUserId: string, baseLanguageCode?: string): Promise<string> {
    const existing = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });

    if (existing) {
      if (baseLanguageCode != null && baseLanguageCode !== existing.baseLanguageCode) {
        await this.prisma.presentationTemplate.update({
          where: { id: existing.id },
          data: { baseLanguageCode }
        });
      }
      return existing.id;
    }

    const code = baseLanguageCode ?? "ru";
    if (!this.botInstanceId) {
      throw new Error("botInstanceId is required to create active PresentationTemplate in multi-bot mode");
    }
    const template = await this.prisma.presentationTemplate.create({
      data: {
        title: "Default MLM Presentation",
        ownerAdminId: actorUserId,
        botInstanceId: this.botInstanceId,
        baseLanguageCode: code
      }
    });

    await this.prisma.presentationLocalization.createMany({
      data: [
        {
          templateId: template.id,
          languageCode: "ru",
          welcomeText: "Добро пожаловать, {{first_name}}! Выберите нужный раздел ниже."
        },
        {
          templateId: template.id,
          languageCode: "en",
          welcomeText: "Welcome, {{first_name}}! Choose a section below."
        },
        {
          templateId: template.id,
          languageCode: "de",
          welcomeText: "Willkommen, {{first_name}}! Wählen Sie unten einen Abschnitt."
        },
        {
          templateId: template.id,
          languageCode: "uk",
          welcomeText: "Ласкаво просимо, {{first_name}}! Оберіть потрібний розділ нижче."
        }
      ]
    });

    return template.id;
  }

  /** Returns the bot's base (primary) language for content creation. Default "ru" if no template. */
  public async getBaseLanguage(actorUserId: string): Promise<string> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    return template?.baseLanguageCode ?? "ru";
  }

  /**
   * Returns distinct languageCodes for which the active template already has MenuItemLocalization rows.
   *
   * We intentionally base it on MenuItemLocalization (not PresentationLocalization):
   * PresentationLocalization may be pre-created during template bootstrap but can still be "empty"
   * until admin clicks "Add language version" and clones full structure localizations.
   */
  public async getActiveTemplateLanguageCodes(): Promise<string[]> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere(),
      select: { id: true }
    });
    if (!template) return [];

    const localizations = await this.prisma.menuItemLocalization.findMany({
      where: { menuItem: { templateId: template.id } },
      select: { languageCode: true }
    });

    return Array.from(new Set(localizations.map((l) => l.languageCode)));
  }

  /**
   * Creates a new "language layer" for the active template by cloning:
   * - PresentationLocalization.welcome* from sourceLanguageCode → targetLanguageCode
   * - MenuItemLocalization fields (title/content/media) for every MenuItem in the template.
   *
   * IMPORTANT: It does NOT duplicate MenuItem structure (parent/child/sortOrder/targetMenuItemId stay intact),
   * only localization rows are added.
   */
  public async addLanguageVersion(
    actorUserId: string,
    sourceLanguageCode: string,
    targetLanguageCode: string
  ): Promise<AddLanguageVersionResult> {
    if (!sourceLanguageCode || !targetLanguageCode) {
      throw new Error("Source/target languageCode is required");
    }
    if (sourceLanguageCode === targetLanguageCode) {
      throw new Error("Target language must be different from source language");
    }

    // Ensure template exists (may create default welcome rows in RU/EN/DE when no template yet).
    const templateId = await this.ensureActiveTemplate(actorUserId);

    const hasMenuLocalizations = await this.prisma.menuItemLocalization.findFirst({
      where: {
        languageCode: targetLanguageCode,
        menuItem: { templateId }
      },
      select: { id: true }
    });
    if (hasMenuLocalizations) throw new Error("Language version already exists");

    const sourceWelcome = await this.prisma.presentationLocalization.findUnique({
      where: {
        templateId_languageCode: {
          templateId,
          languageCode: sourceLanguageCode
        }
      }
    });

    // Fallback: if for some reason the source is missing, try to use base template welcome,
    // then RU, then an empty string. This prevents "blank screens" after creation.
    const template = await this.prisma.presentationTemplate.findUnique({
      where: { id: templateId },
      select: { baseLanguageCode: true }
    });

    const welcomeFallback =
      sourceWelcome ??
      (template?.baseLanguageCode
        ? await this.prisma.presentationLocalization.findUnique({
            where: {
              templateId_languageCode: {
                templateId,
                languageCode: template.baseLanguageCode
              }
            }
          })
        : null) ??
      (await this.prisma.presentationLocalization.findUnique({
        where: {
          templateId_languageCode: {
            templateId,
            languageCode: "ru"
          }
        }
      }));

    await this.prisma.presentationLocalization.upsert({
      where: {
        templateId_languageCode: {
          templateId,
          languageCode: targetLanguageCode
        }
      },
      update: {
        welcomeText: welcomeFallback?.welcomeText ?? "",
        welcomeMediaType: welcomeFallback?.welcomeMediaType ?? "NONE",
        welcomeMediaFileId: welcomeFallback?.welcomeMediaFileId ?? undefined
      },
      create: {
        templateId,
        languageCode: targetLanguageCode,
        welcomeText: welcomeFallback?.welcomeText ?? "",
        welcomeMediaType: welcomeFallback?.welcomeMediaType ?? "NONE",
        welcomeMediaFileId: welcomeFallback?.welcomeMediaFileId ?? undefined
      }
    });

    const menuItems = await this.prisma.menuItem.findMany({
      where: { templateId },
      select: { id: true, key: true }
    });

    const menuItemIds = menuItems.map((i) => i.id);

    const sourceMenuItemLocalizations = await this.prisma.menuItemLocalization.findMany({
      where: {
        languageCode: sourceLanguageCode,
        menuItemId: { in: menuItemIds }
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

    const sourceLocByItemId = new Map<string, (typeof sourceMenuItemLocalizations)[number]>();
    for (const loc of sourceMenuItemLocalizations) sourceLocByItemId.set(loc.menuItemId, loc);

    const createData = menuItems.map((item) => {
      const loc = sourceLocByItemId.get(item.id);
      return {
        menuItemId: item.id,
        languageCode: targetLanguageCode,
        title: loc?.title ?? item.key,
        contentText: loc?.contentText ?? "",
        mediaType: loc?.mediaType ?? ("NONE" as MediaType),
        mediaFileId: loc?.mediaFileId ?? undefined,
        externalUrl: loc?.externalUrl ?? undefined
      };
    });

    const createResult = await this.prisma.menuItemLocalization.createMany({
      data: createData,
      // If structure changed between UI clicks, this keeps the operation resilient and idempotent.
      skipDuplicates: true
    });

    await this.audit.log(actorUserId, "add_language_version", "presentation_template", templateId, {
      sourceLanguageCode,
      targetLanguageCode,
      welcomeCopied: true,
      createdMenuItemLocalizations: createResult.count,
      totalMenuItems: menuItems.length
    });

    return {
      languageCode: targetLanguageCode,
      sourceLanguageCode,
      welcomeCopied: true,
      createdMenuItemLocalizations: createResult.count,
      totalMenuItems: menuItems.length
    };
  }

  /**
   * Deletes a language version from the active template:
   * - removes PresentationLocalization for target language
   * - removes all MenuItemLocalization rows for target language in this template
   *
   * Safety rules:
   * - base language cannot be deleted
   */
  public async deleteLanguageVersion(
    actorUserId: string,
    targetLanguageCode: string
  ): Promise<DeleteLanguageVersionResult> {
    const code = String(targetLanguageCode ?? "").trim().toLowerCase();
    if (!code) throw new Error("Target languageCode is required");

    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere(),
      select: { id: true, baseLanguageCode: true }
    });
    if (!template) throw new Error("Active template not found");

    if (code === String(template.baseLanguageCode).toLowerCase()) {
      throw new Error("Base language cannot be deleted");
    }

    const menuItems = await this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      select: { id: true }
    });
    const menuItemIds = menuItems.map((x) => x.id);

    const [welcomeDeleteResult, menuLocDeleteResult] = await this.prisma.$transaction([
      this.prisma.presentationLocalization.deleteMany({
        where: {
          templateId: template.id,
          languageCode: code
        }
      }),
      this.prisma.menuItemLocalization.deleteMany({
        where: {
          languageCode: code,
          menuItemId: { in: menuItemIds }
        }
      })
    ]);

    await this.audit.log(actorUserId, "delete_language_version", "presentation_template", template.id, {
      languageCode: code,
      deletedWelcome: welcomeDeleteResult.count > 0,
      deletedMenuItemLocalizations: menuLocDeleteResult.count
    });

    return {
      languageCode: code,
      deletedWelcome: welcomeDeleteResult.count > 0,
      deletedMenuItemLocalizations: menuLocDeleteResult.count
    };
  }

  public async setWelcome(
    actorUserId: string,
    languageCode: string,
    welcomeText: string,
    mediaType?: MediaType,
    mediaFileId?: string | null
  ): Promise<void> {
    const templateId = await this.ensureActiveTemplate(actorUserId);

    await this.prisma.presentationLocalization.upsert({
      where: {
        templateId_languageCode: {
          templateId,
          languageCode
        }
      },
      update: {
        welcomeText,
        welcomeMediaType: mediaType ?? "NONE",
        welcomeMediaFileId: mediaFileId ?? undefined
      },
      create: {
        templateId,
        languageCode,
        welcomeText,
        welcomeMediaType: mediaType ?? "NONE",
        welcomeMediaFileId: mediaFileId ?? undefined
      }
    });

    await this.audit.log(actorUserId, "set_welcome", "presentation_template", templateId, {
      languageCode
    });
  }

  public async getWelcomeLocalizationForLanguage(
    actorUserId: string,
    languageCode: string
  ): Promise<{ welcomeText: string; welcomeMediaType: MediaType; welcomeMediaFileId: string | null; exactMatch: boolean }> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    const all = await this.prisma.presentationLocalization.findMany({
      where: { templateId }
    });
    const localized = this.i18n.pickLocalized(all, languageCode);
    const exact = all.some((l) => l.languageCode === languageCode);
    return {
      welcomeText: localized?.welcomeText ?? "",
      welcomeMediaType: localized?.welcomeMediaType ?? "NONE",
      welcomeMediaFileId: localized?.welcomeMediaFileId ?? null,
      exactMatch: exact
    };
  }

  public async patchWelcomeLocalization(
    actorUserId: string,
    languageCode: string,
    patch: Partial<{ welcomeText: string; welcomeMediaType: MediaType; welcomeMediaFileId: string | null }>
  ): Promise<void> {
    const current = await this.getWelcomeLocalizationForLanguage(actorUserId, languageCode);
    await this.setWelcome(
      actorUserId,
      languageCode,
      patch.welcomeText ?? current.welcomeText,
      patch.welcomeMediaType ?? current.welcomeMediaType,
      patch.welcomeMediaFileId !== undefined ? patch.welcomeMediaFileId : current.welcomeMediaFileId
    );
  }

  public async getWelcomeDraftLocalizationForLanguage(
    actorUserId: string,
    languageCode: string
  ): Promise<{ welcomeText: string; welcomeMediaType: MediaType; welcomeMediaFileId: string | null; exactMatch: boolean } | null> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    const row = await this.prisma.presentationLocalizationDraft.findUnique({
      where: {
        templateId_languageCode: {
          templateId,
          languageCode
        }
      }
    });
    if (!row) return null;
    return {
      welcomeText: row.welcomeText ?? "",
      welcomeMediaType: row.welcomeMediaType ?? "NONE",
      welcomeMediaFileId: row.welcomeMediaFileId ?? null,
      exactMatch: true
    };
  }

  public async patchWelcomeDraftLocalization(
    actorUserId: string,
    languageCode: string,
    patch: Partial<{ welcomeText: string; welcomeMediaType: MediaType; welcomeMediaFileId: string | null }>
  ): Promise<void> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    const currentDraft = await this.getWelcomeDraftLocalizationForLanguage(actorUserId, languageCode);
    const currentPublished = await this.getWelcomeLocalizationForLanguage(actorUserId, languageCode);
    const base = currentDraft ?? currentPublished;
    await this.prisma.presentationLocalizationDraft.upsert({
      where: {
        templateId_languageCode: { templateId, languageCode }
      },
      update: {
        welcomeText: patch.welcomeText ?? base.welcomeText,
        welcomeMediaType: patch.welcomeMediaType ?? base.welcomeMediaType,
        welcomeMediaFileId: patch.welcomeMediaFileId !== undefined ? patch.welcomeMediaFileId : base.welcomeMediaFileId
      },
      create: {
        templateId,
        languageCode,
        welcomeText: patch.welcomeText ?? base.welcomeText,
        welcomeMediaType: patch.welcomeMediaType ?? base.welcomeMediaType,
        welcomeMediaFileId: patch.welcomeMediaFileId !== undefined ? patch.welcomeMediaFileId : base.welcomeMediaFileId
      }
    });
    await this.audit.log(actorUserId, "patch_welcome_draft_localization", "presentation_template", templateId, { languageCode });
  }

  public async createMenuItem(input: CreateMenuItemInput): Promise<MenuItem> {
    logger.info(
      {
        actorUserId: input.actorUserId,
        type: input.type,
        parentId: input.parentId,
        titleLength: input.title?.length,
        hasContentText: Boolean(input.contentText),
        contentTextLength: (input.contentText ?? "").length,
        mediaType: input.mediaType,
        hasMediaFileId: Boolean(input.mediaFileId)
      },
      "createMenuItem: started"
    );

    let templateId: string;
    try {
      templateId = await this.ensureActiveTemplate(input.actorUserId);
      logger.info({ templateId }, "createMenuItem: ensureActiveTemplate ok");
    } catch (err) {
      const e = err as Error & { code?: string; meta?: unknown };
      logger.error(
        { err, message: e?.message, code: e?.code, meta: e?.meta, stack: e?.stack },
        "createMenuItem: ensureActiveTemplate failed"
      );
      throw err;
    }

    let siblingsCount: number;
    try {
      siblingsCount = await this.prisma.menuItem.count({
        where: {
          templateId,
          parentId: input.parentId ?? null
        }
      });
      logger.info({ siblingsCount, parentId: input.parentId }, "createMenuItem: count ok");
    } catch (err) {
      const e = err as Error & { code?: string; meta?: unknown };
      logger.error(
        { err, message: e?.message, code: e?.code, meta: e?.meta, stack: e?.stack },
        "createMenuItem: count failed"
      );
      throw err;
    }

    const key =
      input.key ??
      `${input.title.toLowerCase().replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}_${Date.now().toString(36)}`;

    const localizationMediaType: MediaType =
      input.mediaType ??
      (input.type === "LINK"
        ? "LINK"
        : input.type === "TEXT" || input.type === "SUBMENU" || input.type === "SECTION_LINK"
          ? "NONE"
          : (input.type as MediaType));

    const localizationData = {
      languageCode: input.languageCode,
      title: input.title,
      contentText: (input.contentText ?? "").slice(0, 64 * 1024),
      mediaType: localizationMediaType,
      mediaFileId: input.mediaFileId ?? undefined,
      externalUrl: input.externalUrl ?? undefined
    };

    const parentIdForCreate = input.parentId === undefined ? undefined : input.parentId;

    logger.info(
      {
        templateId,
        parentId: parentIdForCreate,
        key,
        type: input.type,
        localizationMediaType,
        contentTextLength: localizationData.contentText.length,
        hasMediaFileId: Boolean(localizationData.mediaFileId)
      },
      "createMenuItem: DB create section started"
    );

    try {
      const menuItem = await this.prisma.menuItem.create({
        data: {
          templateId,
          parentId: parentIdForCreate,
          key,
          type: input.type,
          sortOrder: siblingsCount + 1,
          visibilityMode: input.visibilityMode ?? "SHOW",
          productId: input.productId ?? undefined,
          accessRuleId: input.accessRuleId ?? undefined,
          targetMenuItemId: input.targetMenuItemId ?? undefined,
          localizations: {
            create: localizationData
          }
        }
      });

      logger.info({ menuItemId: menuItem.id }, "createMenuItem: DB create section success");

      await this.audit.log(input.actorUserId, "create_menu_item", "menu_item", menuItem.id, {
        languageCode: input.languageCode
      });

      // When adding a child to a page, ensure it appears in the parent's slot order.
      // If PageNavConfig exists, it overrides the default order—without this, new buttons would never show.
      // Root children use pageId = "root" (parentId in DB = null).
      const parentPageId = parentIdForCreate ?? "root";
      await this.addNewChildToSlotOrder(parentPageId, menuItem.id, input.actorUserId);

      return menuItem;
    } catch (err) {
      const errObj = err as Error & { code?: string; meta?: unknown };
      const isPrisma = err instanceof Prisma.PrismaClientKnownRequestError;
      logger.error(
        {
          err,
          name: errObj?.name,
          message: errObj?.message,
          code: isPrisma ? (err as Prisma.PrismaClientKnownRequestError).code : errObj?.code,
          meta: isPrisma ? (err as Prisma.PrismaClientKnownRequestError).meta : errObj?.meta,
          stack: errObj?.stack,
          inputSummary: {
            type: input.type,
            mediaType: localizationMediaType,
            hasContentText: Boolean(input.contentText),
            contentTextLength: (input.contentText ?? "").length,
            hasMediaFileId: Boolean(input.mediaFileId),
            key
          }
        },
        "createMenuItem: DB save failed"
      );
      throw err;
    }
  }

  /**
   * @param telegramFrom — fallback for firstName/lastName when User has empty fields (e.g. migrated or cross-bot).
   */
  public async getWelcome(
    user: User,
    telegramFrom?: { first_name?: string; last_name?: string; username?: string } | null
  ): Promise<{ text: string; mediaType: MediaType; mediaFileId?: string | null }> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere(),
      include: { localizations: true }
    });

    const localization = template
      ? this.i18n.pickLocalized(template.localizations, user.selectedLanguage)
      : null;

    const abVariant = await this.abTests.resolveVariant("welcome_text", user.id);
    const welcomeText = String(abVariant?.text ?? localization?.welcomeText ?? this.i18n.t(user.selectedLanguage, "welcome_default"));

    const profile =
      telegramFrom && (!user.firstName?.trim() || !user.fullName?.trim())
        ? {
            ...user,
            firstName: telegramFrom.first_name ?? user.firstName,
            lastName: telegramFrom.last_name ?? user.lastName,
            fullName:
              user.fullName?.trim() ||
              [telegramFrom.first_name, telegramFrom.last_name].filter(Boolean).join(" ").trim() ||
              telegramFrom.first_name
          }
        : user;

    const formatted = maybeFormatForTelegram(welcomeText);
    return {
      text: applyPersonalization(formatted, profile, { escapeForHtml: true }),
      mediaType: localization?.welcomeMediaType ?? "NONE",
      mediaFileId: localization?.welcomeMediaFileId
    };
  }

  public async getMenuItemsForParent(user: User, parentId: string | null): Promise<Array<LocalizedMenuItem & { locked: boolean }>> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });

    if (!template) {
      return [];
    }

    const items = await this.prisma.menuItem.findMany({
      where: {
        templateId: template.id,
        parentId,
        isActive: true
      },
      include: {
        localizations: true,
        product: true
      },
      orderBy: {
        sortOrder: "asc"
      }
    });

    const result: Array<LocalizedMenuItem & { locked: boolean }> = [];

    for (const item of items) {
      const allowedByRule = await this.accessRules.evaluate(item.accessRuleId, user, {
        skipProductPurchase: !this.paidAccessEnabled
      });
      const allowedByProduct = this.paidAccessEnabled ? await this.accessRules.evaluateProduct(item.productId, user.id) : true;
      const locked = !(allowedByRule && allowedByProduct);

      if (item.visibilityMode === "HIDE" && locked) {
        continue;
      }

      result.push({
        ...item,
        locked
      });
    }

    return result;
  }

  public localizeMenuItem(item: LocalizedMenuItem, languageCode: string): MenuItemLocalization | null {
    return this.i18n.pickLocalized(item.localizations, languageCode);
  }

  public async getMenuItemContent(
    user: User,
    menuItemId: string
  ): Promise<{ item: LocalizedMenuItem; localization: MenuItemLocalization; locked: boolean }> {
    const item = this.botInstanceId
      ? await this.prisma.menuItem.findFirstOrThrow({
          where: { id: menuItemId, template: { botInstanceId: this.botInstanceId } },
          include: {
            localizations: true,
            product: { include: { localizations: true } }
          }
        })
      : await this.prisma.menuItem.findUniqueOrThrow({
          where: { id: menuItemId },
          include: {
            localizations: true,
            product: { include: { localizations: true } }
          }
        });

    const localization = this.localizeMenuItem(item, user.selectedLanguage);

    if (!localization) {
      throw new Error("Localization is missing");
    }

    const allowedByRule = await this.accessRules.evaluate(item.accessRuleId, user, {
      skipProductPurchase: !this.paidAccessEnabled
    });
    const allowedByProduct = this.paidAccessEnabled ? await this.accessRules.evaluateProduct(item.productId, user.id) : true;
    const locked = !(allowedByRule && allowedByProduct);

    return {
      item,
      localization,
      locked
    };
  }

  public async markViewed(userId: string, menuItemId: string, languageCode: string): Promise<void> {
    await Promise.all([
      this.analytics.recordMenuClick(userId, menuItemId, languageCode),
      this.prisma.contentProgress.upsert({
        where: {
          userId_menuItemId: {
            userId,
            menuItemId
          }
        },
        update: {
          status: "VIEWED",
          viewedAt: new Date(),
          ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {})
        },
        create: {
          userId,
          menuItemId,
          botInstanceId: this.botInstanceId ?? undefined,
          status: "VIEWED",
          viewedAt: new Date()
        }
      })
    ]);
  }

  public async previewTree(languageCode: string): Promise<string> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere(),
      include: {
        menuItems: {
          include: {
            localizations: true
          },
          orderBy: {
            sortOrder: "asc"
          }
        }
      }
    });

    if (!template || template.menuItems.length === 0) {
      return this.i18n.t(languageCode, "menu_empty");
    }

    const rows = template.menuItems.map((item) => {
      const localization = this.i18n.pickLocalized(item.localizations, languageCode);
      const title = localization?.title ?? item.key;
      const depth = this.depthForItem(item.id, template.menuItems);
      return `${"  ".repeat(depth)}- ${title} [${item.type}]`;
    });

    return rows.join("\n");
  }

  private depthForItem(id: string, items: MenuItem[]): number {
    let depth = 0;
    let current = items.find((item) => item.id === id);

    while (current?.parentId) {
      depth += 1;
      current = items.find((item) => item.id === current?.parentId);
    }

    return depth;
  }

  /** Returns child menu items for the given parent (no access filtering, includes inactive). For admin page editor. */
  public async getChildMenuItemsForAdmin(parentId: string | null): Promise<Array<MenuItem & { localizations: MenuItemLocalization[] }>> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return [];

    return this.prisma.menuItem.findMany({
      where: {
        templateId: template.id,
        parentId
      },
      include: { localizations: true },
      orderBy: { sortOrder: "asc" }
    });
  }

  /** True if the active template has no root-level menu items (empty menu). */
  public async isRootMenuEmpty(): Promise<boolean> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return true;
    const count = await this.prisma.menuItem.count({
      where: {
        templateId: template.id,
        parentId: null
      }
    });
    return count === 0;
  }

  /**
   * Wipes all bot structure for the active template: removes all menu items (sections, buttons, hierarchy),
   * resets welcome/localization to default empty state. Does not delete the template itself.
   * Caller should also reset onboarding for the actor (e.g. users.resetOnboarding(actorUserId)).
   */
  public async wipeBotStructure(actorUserId: string): Promise<void> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere(),
      include: { localizations: true }
    });
    if (!template) return;

    await this.prisma.menuItem.deleteMany({
      where: { templateId: template.id }
    });

    const defaultWelcomeByLang: Record<string, string> = {
      ru: "Добро пожаловать! Бот пока не настроен.",
      en: "Welcome! The bot is not configured yet.",
      de: "Willkommen! Der Bot ist noch nicht eingerichtet.",
      uk: "Ласкаво просимо! Бот поки не налаштований."
    };
    for (const loc of template.localizations) {
      await this.prisma.presentationLocalization.update({
        where: {
          templateId_languageCode: {
            templateId: template.id,
            languageCode: loc.languageCode
          }
        },
        data: {
          welcomeText: defaultWelcomeByLang[loc.languageCode] ?? defaultWelcomeByLang.ru,
          welcomeMediaType: "NONE",
          welcomeMediaFileId: undefined
        }
      });
    }

    await this.audit.log(actorUserId, "wipe_bot_structure", "presentation_template", template.id, {});
  }

  public async findMenuItemById(id: string): Promise<(MenuItem & { localizations: MenuItemLocalization[] }) | null> {
    if (!this.botInstanceId) {
      return this.prisma.menuItem.findUnique({
        where: { id },
        include: { localizations: true }
      });
    }

    return this.prisma.menuItem.findFirst({
      where: { id, template: { botInstanceId: this.botInstanceId } },
      include: { localizations: true }
    });
  }

  /** Returns id of system target MenuItem (e.g. __sys_target_partner_register) or null if not found. */
  public async getSystemTargetMenuItemId(kind: SystemTargetKind): Promise<string | null> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere(),
      select: { id: true }
    });
    if (!template) return null;
    const item = await this.prisma.menuItem.findFirst({
      where: { templateId: template.id, key: `__sys_target_${kind}` },
      select: { id: true }
    });
    return item?.id ?? null;
  }

  public async getAllMenuItemsForAdmin(): Promise<Array<MenuItem & { localizations: MenuItemLocalization[] }>> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return [];
    return this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      include: { localizations: true },
      orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }]
    });
  }

  public async getMenuItemLocalizationForLanguage(
    menuItemId: string,
    languageCode: string
  ): Promise<LocalizedContentSnapshot | null> {
    const item = await this.findMenuItemById(menuItemId);
    if (!item) return null;
    const loc = this.i18n.pickLocalized(item.localizations, languageCode);
    const exact = item.localizations.some((l) => l.languageCode === languageCode);
    return {
      contentText: loc?.contentText ?? "",
      mediaType: loc?.mediaType ?? "NONE",
      mediaFileId: loc?.mediaFileId ?? null,
      externalUrl: loc?.externalUrl ?? null,
      exactMatch: exact,
      source: "PUBLISHED"
    };
  }

  public async getMenuItemDraftLocalizationForLanguage(
    menuItemId: string,
    languageCode: string
  ): Promise<LocalizedContentSnapshot | null> {
    const row = await this.prisma.menuItemLocalizationDraft.findUnique({
      where: {
        menuItemId_languageCode: { menuItemId, languageCode }
      }
    });
    if (!row) return null;
    return {
      contentText: row.contentText ?? "",
      mediaType: row.mediaType ?? "NONE",
      mediaFileId: row.mediaFileId ?? null,
      externalUrl: row.externalUrl ?? null,
      exactMatch: true,
      source: "DRAFT"
    };
  }

  /**
   * Returns menu item title localized for language.
   * IMPORTANT: admin language editor should show draft titles before publish.
   */
  public async getMenuItemTitleForLanguage(menuItemId: string, languageCode: string): Promise<string> {
    const [draft, pub, item] = await Promise.all([
      this.prisma.menuItemLocalizationDraft.findUnique({
        where: { menuItemId_languageCode: { menuItemId, languageCode } },
        select: { title: true }
      }),
      this.prisma.menuItemLocalization.findUnique({
        where: { menuItemId_languageCode: { menuItemId, languageCode } },
        select: { title: true }
      }),
      this.prisma.menuItem.findUnique({
        where: { id: menuItemId },
        select: { key: true }
      })
    ]);

    return draft?.title?.trim() ? draft.title : pub?.title?.trim() ? pub.title : item?.key ?? menuItemId;
  }

  public async getEffectiveMenuItemLocalizationForLanguage(
    menuItemId: string,
    languageCode: string
  ): Promise<LocalizedContentSnapshot | null> {
    const draft = await this.getMenuItemDraftLocalizationForLanguage(menuItemId, languageCode);
    if (draft) return draft;
    return this.getMenuItemLocalizationForLanguage(menuItemId, languageCode);
  }

  public async getEffectiveWelcomeLocalizationForLanguage(
    actorUserId: string,
    languageCode: string
  ): Promise<{ welcomeText: string; welcomeMediaType: MediaType; welcomeMediaFileId: string | null; source: "DRAFT" | "PUBLISHED"; exactMatch: boolean }> {
    const draft = await this.getWelcomeDraftLocalizationForLanguage(actorUserId, languageCode);
    if (draft) {
      return { ...draft, source: "DRAFT" };
    }
    const pub = await this.getWelcomeLocalizationForLanguage(actorUserId, languageCode);
    return { ...pub, source: "PUBLISHED" };
  }

  public async patchMenuItemLocalization(
    menuItemId: string,
    actorUserId: string,
    languageCode: string,
    patch: Partial<{ contentText: string; mediaType: MediaType; mediaFileId: string | null; externalUrl: string | null }>
  ): Promise<void> {
    const item = await this.findMenuItemById(menuItemId);
    if (!item) throw new Error("Menu item not found");
    const current = await this.getMenuItemLocalizationForLanguage(menuItemId, languageCode);
    await this.prisma.menuItemLocalization.upsert({
      where: {
        menuItemId_languageCode: { menuItemId, languageCode }
      },
      update: {
        contentText: patch.contentText ?? current?.contentText ?? "",
        mediaType: patch.mediaType ?? current?.mediaType ?? "NONE",
        mediaFileId: patch.mediaFileId !== undefined ? patch.mediaFileId : (current?.mediaFileId ?? null),
        externalUrl: patch.externalUrl !== undefined ? patch.externalUrl : (current?.externalUrl ?? null)
      },
      create: {
        menuItemId,
        languageCode,
        title: this.i18n.pickLocalized(item.localizations, languageCode)?.title ?? item.key,
        contentText: patch.contentText ?? current?.contentText ?? "",
        mediaType: patch.mediaType ?? current?.mediaType ?? "NONE",
        mediaFileId: patch.mediaFileId !== undefined ? patch.mediaFileId : (current?.mediaFileId ?? null),
        externalUrl: patch.externalUrl !== undefined ? patch.externalUrl : (current?.externalUrl ?? null)
      }
    });
    await this.audit.log(actorUserId, "patch_menu_item_localization", "menu_item", menuItemId, { languageCode });
  }

  public async markLanguageVersionDraft(actorUserId: string, languageCode: string): Promise<void> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    await this.prisma.localizationLayerState.upsert({
      where: { templateId_languageCode: { templateId, languageCode } },
      update: {
        status: "DRAFT",
        lastEditedByUserId: actorUserId,
        draftSavedAt: new Date(),
        publishedAt: null
      },
      create: {
        templateId,
        languageCode,
        status: "DRAFT",
        createdByUserId: actorUserId,
        lastEditedByUserId: actorUserId,
        draftSavedAt: new Date(),
        publishedAt: null
      }
    });
  }

  /**
   * Publishes a language version by copying ALL existing draft rows for this language
   * into the published tables (upsert).
   *
   * IMPORTANT: Missing draft rows are treated as "no change" (published stays as-is).
   */
  public async publishLanguageVersion(actorUserId: string, languageCode: string): Promise<void> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    const [draftWelcome, draftPages] = await this.prisma.$transaction([
      this.prisma.presentationLocalizationDraft.findUnique({
        where: { templateId_languageCode: { templateId, languageCode } }
      }),
      this.prisma.menuItemLocalizationDraft.findMany({
        where: { languageCode, menuItem: { templateId } }
      })
    ]);

    await this.prisma.$transaction(async (tx) => {
      if (draftWelcome) {
        await tx.presentationLocalization.upsert({
          where: { templateId_languageCode: { templateId, languageCode } },
          update: {
            welcomeText: draftWelcome.welcomeText,
            welcomeMediaType: draftWelcome.welcomeMediaType,
            welcomeMediaFileId: draftWelcome.welcomeMediaFileId ?? undefined
          },
          create: {
            templateId,
            languageCode,
            welcomeText: draftWelcome.welcomeText,
            welcomeMediaType: draftWelcome.welcomeMediaType,
            welcomeMediaFileId: draftWelcome.welcomeMediaFileId ?? undefined
          }
        });
      }

      for (const d of draftPages) {
        await tx.menuItemLocalization.upsert({
          where: { menuItemId_languageCode: { menuItemId: d.menuItemId, languageCode } },
          update: {
            title: d.title,
            contentText: d.contentText,
            mediaType: d.mediaType,
            mediaFileId: d.mediaFileId ?? undefined,
            externalUrl: d.externalUrl ?? undefined
          },
          create: {
            menuItemId: d.menuItemId,
            languageCode,
            title: d.title,
            contentText: d.contentText,
            mediaType: d.mediaType,
            mediaFileId: d.mediaFileId ?? undefined,
            externalUrl: d.externalUrl ?? undefined
          }
        });
      }

      await tx.localizationLayerState.upsert({
        where: { templateId_languageCode: { templateId, languageCode } },
        update: {
          status: "PUBLISHED",
          lastEditedByUserId: actorUserId,
          publishedAt: new Date()
        },
        create: {
          templateId,
          languageCode,
          status: "PUBLISHED",
          createdByUserId: actorUserId,
          lastEditedByUserId: actorUserId,
          publishedAt: new Date()
        }
      });
    });
  }

  public async getLanguageVersionStatus(
    actorUserId: string,
    languageCode: string
  ): Promise<{ status: "DRAFT" | "PUBLISHED"; updatedAt?: Date }> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    const row = await this.prisma.localizationLayerState.findUnique({
      where: { templateId_languageCode: { templateId, languageCode } }
    });
    if (!row) return { status: "DRAFT" };
    const ts = row.status === "PUBLISHED" ? row.publishedAt : row.draftSavedAt;
    return { status: row.status, updatedAt: ts ?? row.updatedAt };
  }

  public async patchMenuItemDraftLocalization(
    menuItemId: string,
    actorUserId: string,
    languageCode: string,
    patch: Partial<{ contentText: string; mediaType: MediaType; mediaFileId: string | null; externalUrl: string | null }>
  ): Promise<void> {
    const item = await this.findMenuItemById(menuItemId);
    if (!item) throw new Error("Menu item not found");
    const current = (await this.getMenuItemDraftLocalizationForLanguage(menuItemId, languageCode)) ?? (await this.getMenuItemLocalizationForLanguage(menuItemId, languageCode));
    await this.prisma.menuItemLocalizationDraft.upsert({
      where: { menuItemId_languageCode: { menuItemId, languageCode } },
      update: {
        title: this.i18n.pickLocalized(item.localizations, languageCode)?.title ?? item.key,
        contentText: patch.contentText ?? current?.contentText ?? "",
        mediaType: patch.mediaType ?? current?.mediaType ?? "NONE",
        mediaFileId: patch.mediaFileId !== undefined ? patch.mediaFileId : (current?.mediaFileId ?? null),
        externalUrl: patch.externalUrl !== undefined ? patch.externalUrl : (current?.externalUrl ?? null)
      },
      create: {
        menuItemId,
        languageCode,
        title: this.i18n.pickLocalized(item.localizations, languageCode)?.title ?? item.key,
        contentText: patch.contentText ?? current?.contentText ?? "",
        mediaType: patch.mediaType ?? current?.mediaType ?? "NONE",
        mediaFileId: patch.mediaFileId !== undefined ? patch.mediaFileId : (current?.mediaFileId ?? null),
        externalUrl: patch.externalUrl !== undefined ? patch.externalUrl : (current?.externalUrl ?? null)
      }
    });
    await this.audit.log(actorUserId, "patch_menu_item_draft_localization", "menu_item", menuItemId, { languageCode });
  }

  /** Item with resolved title (and target title for SECTION_LINK). */
  private getItemTitle(item: MenuItem & { localizations: MenuItemLocalization[] }, languageCode: string): string {
    const loc = this.i18n.pickLocalized(item.localizations, languageCode);
    return loc?.title ?? item.key ?? item.id;
  }

  /**
   * Builds a readable tree of the bot structure (root → sections → buttons with targets).
   * Returns text lines (without header) so the caller can add title and i18n.
   */
  public async getStructureTreeLines(languageCode: string): Promise<string[]> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return [];

    const items = await this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      include: { localizations: true },
      orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }]
    });

    const byParent = new Map<string | null, (MenuItem & { localizations: MenuItemLocalization[] })[]>();
    const byId = new Map<string, MenuItem & { localizations: MenuItemLocalization[] }>();
    for (const item of items) {
      const pid = item.parentId ?? null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(item);
      byId.set(item.id, item);
    }

    const lines: string[] = [];

    const renderButton = (btn: MenuItem & { localizations: MenuItemLocalization[] }, depth: number): void => {
      const indent = "  ".repeat(depth);
      const title = this.getItemTitle(btn, languageCode);
      const target = btn.targetMenuItemId ? byId.get(btn.targetMenuItemId) : null;
      const targetTitle = target ? this.getItemTitle(target, languageCode) : "—";
      lines.push(`${indent}🔘 Кнопка: ${title} → ${targetTitle}`);
    };

    const renderPage = (page: MenuItem & { localizations: MenuItemLocalization[] }, depth: number): void => {
      const indent = "  ".repeat(depth);
      const title = this.getItemTitle(page, languageCode);

      lines.push(`${indent}📄 Раздел: ${title}`);

      const children = byParent.get(page.id) ?? [];
      const buttons = children.filter((c) => c.type === "SECTION_LINK") as Array<MenuItem & { localizations: MenuItemLocalization[] }>;
      const pages = children.filter((c) => c.type !== "SECTION_LINK") as Array<MenuItem & { localizations: MenuItemLocalization[] }>;

      if (buttons.length > 0) {
        lines.push(`${"  ".repeat(depth + 1)}Кнопки:`);
        for (const b of buttons) renderButton(b, depth + 2);
      }

      if (pages.length > 0) {
        lines.push(`${"  ".repeat(depth + 1)}Подразделы:`);
        for (const p of pages) renderPage(p, depth + 2);
      }
    };

    const rootChildren = byParent.get(null) ?? [];
    for (const item of rootChildren) {
      if (item.type === "SECTION_LINK") {
        renderButton(item as any, 0);
      } else {
        renderPage(item as any, 0);
      }
    }
    return lines;
  }

  /**
   * Human-readable structure overview for admin.
   * UX: show only Главная + разделы/подразделы as a readable tree with sticks.
   * - No buttons, no statuses, no SECTION_LINK technical items
   */
  public async getHumanReadableStructure(languageCode: string): Promise<string> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return this.i18n.t(languageCode, "structure_empty");

    const items = await this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      include: { localizations: true },
      orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }]
    });

    const byParent = new Map<string | null, (MenuItem & { localizations: MenuItemLocalization[] })[]>();
    for (const item of items) {
      const pid = item.parentId ?? null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(item);
    }

    const safeTitle = (item: MenuItem & { localizations: MenuItemLocalization[] }): string => {
      const loc = this.i18n.pickLocalized(item.localizations, languageCode);
      return loc?.title ?? "Без названия";
    };

    const pageChildren = (
      list: (MenuItem & { localizations: MenuItemLocalization[] })[]
    ): Array<MenuItem & { localizations: MenuItemLocalization[] }> => list.filter((x) => x.type !== "SECTION_LINK");

    const rootSections = pageChildren(byParent.get(null) ?? []);
    const lines: string[] = [];
    lines.push("🏠 Главная");

    if (rootSections.length === 0) {
      lines.push("- нет");
      return lines.join("\n");
    }

    const renderNode = (
      node: MenuItem & { localizations: MenuItemLocalization[] },
      prefix: string,
      isLast: boolean
    ): void => {
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${safeTitle(node)}`);

      const children = pageChildren(byParent.get(node.id) ?? []);
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      for (let i = 0; i < children.length; i++) {
        renderNode(children[i]!, nextPrefix, i === children.length - 1);
      }
    };

    for (let i = 0; i < rootSections.length; i++) {
      renderNode(rootSections[i]!, "", i === rootSections.length - 1);
      // "Воздух" между верхнеуровневыми ветками, но с сохранением визуальной связности.
      // Это делает блок похожим на единый "скелет" дерева (как на твоем скрине).
      if (i !== rootSections.length - 1) lines.push("│");
    }

    return lines.join("\n");
  }

  /**
   * For page editor: child sections (SUBMENU/content types) and buttons (all children with "title → target").
   */
  public async getPageEditorBlocks(
    parentId: string | null,
    languageCode: string
  ): Promise<{ childSections: Array<{ id: string; title: string }>; buttons: Array<{ id: string; title: string; targetTitle: string }> }> {
    const children = await this.getChildMenuItemsForAdmin(parentId);
    const childSections: Array<{ id: string; title: string }> = [];
    const buttons: Array<{ id: string; title: string; targetTitle: string }> = [];

    for (const c of children) {
      const title = this.getItemTitle(c, languageCode);
      if (c.type === "SECTION_LINK" && c.targetMenuItemId) {
        const target = await this.findMenuItemById(c.targetMenuItemId);
        buttons.push({ id: c.id, title, targetTitle: target ? this.getItemTitle(target, languageCode) : "—" });
      } else {
        childSections.push({ id: c.id, title });
        buttons.push({ id: c.id, title, targetTitle: title });
      }
    }
    return { childSections, buttons };
  }

  /**
   * Full pre-publish preview: hierarchy with root, buttons (with status), sections, system buttons.
   * Uses i18n keys: preview_root_label, preview_buttons_label, preview_sections_label, preview_subsections_label, preview_system_buttons_label, item_active, item_inactive, preview_system_list.
   */
  public async getFullPreviewContent(languageCode: string): Promise<string> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return this.i18n.t(languageCode, "structure_empty");

    const items = await this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      include: { localizations: true },
      orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }]
    });

    const byParent = new Map<string | null, (MenuItem & { localizations: MenuItemLocalization[] })[]>();
    const byId = new Map<string, MenuItem & { localizations: MenuItemLocalization[] }>();
    for (const item of items) {
      const pid = item.parentId ?? null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(item);
      byId.set(item.id, item);
    }

    const rootLabel = this.i18n.t(languageCode, "preview_root_label");
    const buttonsLabel = this.i18n.t(languageCode, "preview_buttons_label");
    const sectionsLabel = this.i18n.t(languageCode, "preview_sections_label");
    const systemLabel = this.i18n.t(languageCode, "preview_system_buttons_label");
    const activeLabel = this.i18n.t(languageCode, "item_active");
    const inactiveLabel = this.i18n.t(languageCode, "item_inactive");
    const systemList = this.i18n.t(languageCode, "preview_system_list");

    const lines: string[] = [];
    lines.push(`🏠 ${rootLabel}`);

    const recurse = (parentId: string | null, indent: string): void => {
      const children = byParent.get(parentId) ?? [];
      const buttons: string[] = [];
      const sections: (MenuItem & { localizations: MenuItemLocalization[] })[] = [];
      for (const item of children) {
        const title = this.getItemTitle(item, languageCode);
        const status = item.isActive ? activeLabel : inactiveLabel;
        if (item.type === "SECTION_LINK") {
          const target = item.targetMenuItemId ? byId.get(item.targetMenuItemId) : null;
          const targetTitle = target ? this.getItemTitle(target, languageCode) : "—";
          buttons.push(`${indent}- ${title} → ${targetTitle} (${status})`);
        } else {
          sections.push(item);
          buttons.push(`${indent}- ${title} → ${title} (${status})`);
        }
      }
      if (buttons.length > 0) {
        lines.push(`${indent}${buttonsLabel}`);
        lines.push(buttons.join("\n"));
      }
      if (sections.length > 0) {
        lines.push(`${indent}${sectionsLabel}`);
        for (const item of sections) {
          const title = this.getItemTitle(item, languageCode);
          lines.push(`${indent}📄 ${title}`);
          recurse(item.id, indent + "  ");
        }
      }
    };

    recurse(null, "");
    lines.push("");
    lines.push(systemLabel);
    lines.push(systemList);
    return lines.join("\n");
  }

  /** Validation warnings for pre-publish. Returns translated warning strings. */
  public async getPreviewWarnings(languageCode: string): Promise<string[]> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    const warnings: string[] = [];
    if (!template) return warnings;

    const items = await this.prisma.menuItem.findMany({
      where: { templateId: template.id },
      include: { localizations: true }
    });
    const byParent = new Map<string | null, (MenuItem & { localizations: MenuItemLocalization[] })[]>();
    const byId = new Map<string, MenuItem & { localizations: MenuItemLocalization[] }>();
    for (const item of items) {
      const pid = item.parentId ?? null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(item);
      byId.set(item.id, item);
    }

    const rootChildren = byParent.get(null) ?? [];
    if (rootChildren.length === 0) {
      warnings.push(this.i18n.t(languageCode, "preview_warning_structure_empty"));
    }

    let hasInactive = false;
    let hasUnlinked = false;
    let hasMissingTarget = false;
    const titlesByParent = new Map<string | null, Map<string, number>>();

    for (const item of items) {
      if (!item.isActive) hasInactive = true;
      if (item.type === "SECTION_LINK") {
        if (!item.targetMenuItemId) hasUnlinked = true;
        else if (!byId.has(item.targetMenuItemId)) hasMissingTarget = true;
      }
      const pid = item.parentId ?? null;
      const title = this.getItemTitle(item, languageCode);
      if (!titlesByParent.has(pid)) titlesByParent.set(pid, new Map());
      const count = titlesByParent.get(pid)!.get(title) ?? 0;
      titlesByParent.get(pid)!.set(title, count + 1);
    }

    if (hasInactive) warnings.push(this.i18n.t(languageCode, "preview_warning_has_inactive"));
    if (hasUnlinked) warnings.push(this.i18n.t(languageCode, "preview_warning_button_not_linked"));
    if (hasMissingTarget) warnings.push(this.i18n.t(languageCode, "preview_warning_button_target_missing"));

    let hasDuplicateTitles = false;
    for (const [, titleCount] of titlesByParent) {
      for (const [, count] of titleCount) {
        if (count > 1) {
          hasDuplicateTitles = true;
          break;
        }
      }
    }
    if (hasDuplicateTitles) warnings.push(this.i18n.t(languageCode, "preview_warning_duplicate_titles"));

    return warnings;
  }

  /** Sections/pages that can be linked by a button (content destinations). For "Add new button" picker. */
  public async getContentSectionsForPicker(languageCode: string): Promise<Array<{ id: string; title: string }>> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) return [];

    const items = await this.prisma.menuItem.findMany({
      where: {
        templateId: template.id,
        type: { in: ["TEXT", "PHOTO", "VIDEO", "DOCUMENT", "SUBMENU"] }
      },
      include: { localizations: true },
      orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }]
    });

    return items.map((item) => {
      const loc = this.i18n.pickLocalized(item.localizations, languageCode);
      return { id: item.id, title: loc?.title ?? item.key };
    });
  }

  /**
   * Ensures hidden technical page for a system-target link and returns its id.
   * This keeps SECTION_LINK foreign-key valid (targets a real MenuItem).
   */
  public async ensureSystemTargetMenuItem(
    actorUserId: string,
    languageCode: string,
    kind: SystemTargetKind
  ): Promise<string> {
    const templateId = await this.ensureActiveTemplate(actorUserId);
    const key = `__sys_target_${kind}`;
    const existing = await this.prisma.menuItem.findFirst({
      where: { templateId, key }
    });
    if (existing) return existing.id;

    const titleByKind: Record<SystemTargetKind, string> = {
      my_cabinet: this.i18n.t(languageCode, "sys_btn_my_cabinet"),
      partner_register: this.i18n.t(languageCode, "sys_btn_partner_register"),
      mentor_contact: this.i18n.t(languageCode, "sys_btn_mentor_contact"),
      change_language: this.i18n.t(languageCode, "sys_btn_change_language")
    };

    const created = await this.prisma.menuItem.create({
      data: {
        templateId,
        parentId: null,
        key,
        type: "TEXT",
        isActive: false,
        sortOrder: 0,
        localizations: {
          create: {
            languageCode,
            title: titleByKind[kind],
            contentText: "",
            mediaType: "NONE"
          }
        }
      }
    });
    await this.audit.log(actorUserId, "ensure_system_target_menu_item", "menu_item", created.id, { kind });
    return created.id;
  }

  public async deleteMenuItem(menuItemId: string, actorUserId: string): Promise<void> {
    await this.prisma.menuItem.delete({
      where: { id: menuItemId }
    });
    await this.audit.log(actorUserId, "delete_menu_item", "menu_item", menuItemId, {});
  }

  public async updateMenuItemContent(
    menuItemId: string,
    actorUserId: string,
    languageCode: string,
    content: {
      contentText?: string;
      mediaType?: MediaType;
      mediaFileId?: string | null;
      externalUrl?: string | null;
    }
  ): Promise<void> {
    await this.prisma.menuItemLocalization.upsert({
      where: {
        menuItemId_languageCode: { menuItemId, languageCode }
      },
      update: {
        contentText: content.contentText ?? undefined,
        mediaType: content.mediaType ?? undefined,
        mediaFileId: content.mediaFileId,
        externalUrl: content.externalUrl
      },
      create: {
        menuItemId,
        languageCode,
        title: "Item",
        contentText: content.contentText ?? "",
        mediaType: content.mediaType ?? "NONE",
        mediaFileId: content.mediaFileId,
        externalUrl: content.externalUrl
      }
    });
    await this.audit.log(actorUserId, "update_menu_item_content", "menu_item", menuItemId, { languageCode });
  }

  public async setMenuItemActive(menuItemId: string, isActive: boolean, actorUserId: string): Promise<void> {
    await this.prisma.menuItem.update({
      where: { id: menuItemId },
      data: { isActive }
    });
    await this.audit.log(actorUserId, "set_menu_item_active", "menu_item", menuItemId, { isActive });
  }

  public async updateMenuItemTitle(
    menuItemId: string,
    languageCode: string,
    title: string,
    actorUserId: string
  ): Promise<void> {
    await this.prisma.menuItemLocalization.upsert({
      where: {
        menuItemId_languageCode: { menuItemId, languageCode }
      },
      update: { title: title.trim() || "Item" },
      create: {
        menuItemId,
        languageCode,
        title: title.trim() || "Item",
        contentText: "",
        mediaType: "NONE"
      }
    });
    await this.audit.log(actorUserId, "update_menu_item_title", "menu_item", menuItemId, { languageCode });
  }

  public async updateMenuItemTarget(
    menuItemId: string,
    targetMenuItemId: string,
    actorUserId: string
  ): Promise<void> {
    await this.prisma.menuItem.update({
      where: { id: menuItemId },
      data: { targetMenuItemId }
    });
    await this.audit.log(actorUserId, "update_menu_item_target", "menu_item", menuItemId, { targetMenuItemId });
  }

  public async moveMenuItemOrder(menuItemId: string, direction: "up" | "down", actorUserId: string): Promise<void> {
    const item = await this.prisma.menuItem.findUniqueOrThrow({
      where: { id: menuItemId }
    });
    const siblings = await this.prisma.menuItem.findMany({
      where: {
        templateId: item.templateId,
        parentId: item.parentId
      },
      orderBy: { sortOrder: "asc" }
    });
    const idx = siblings.findIndex((s) => s.id === menuItemId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const other = siblings[swapIdx];
    if (!other) return;
    await this.prisma.$transaction([
      this.prisma.menuItem.update({
        where: { id: menuItemId },
        data: { sortOrder: other.sortOrder }
      }),
      this.prisma.menuItem.update({
        where: { id: other.id },
        data: { sortOrder: item.sortOrder }
      })
    ]);
    await this.audit.log(actorUserId, "move_menu_item", "menu_item", menuItemId, { direction });
  }

  /** Slot ids for special nav buttons in page button order. */
  public static readonly NAV_SLOT_BACK = "__nav_back";
  public static readonly NAV_SLOT_TO_MAIN = "__nav_to_main";

  /** Slot ids for special system buttons on root menu. */
  public static readonly SYS_SLOT_PARTNER_REGISTER = "__sys_partner_register";
  public static readonly SYS_SLOT_MY_CABINET = "__sys_my_cabinet";
  public static readonly SYS_SLOT_MENTOR_CONTACT = "__sys_mentor_contact";
  public static readonly SYS_SLOT_LANGUAGE = "__sys_lang";
  public static readonly SYS_SLOT_ADMIN_PANEL = "__sys_admin_panel";
  public static readonly SYS_SLOT_CONFIGURE_PAGE = "__sys_configure_page";

  /**
   * Marker slot for root PageNavConfig: when present, treat sys-slot list as user-managed.
   * This prevents breaking backward compatibility for legacy configs without sys slots.
   */
  public static readonly SYS_SLOT_CONFIGURED_MARKER = "__sys_configured_marker";

  private static readonly DEFAULT_ROOT_SYS_SLOTS = [
    MenuService.SYS_SLOT_PARTNER_REGISTER,
    MenuService.SYS_SLOT_MY_CABINET,
    MenuService.SYS_SLOT_MENTOR_CONTACT,
    MenuService.SYS_SLOT_LANGUAGE,
    MenuService.SYS_SLOT_ADMIN_PANEL,
    MenuService.SYS_SLOT_CONFIGURE_PAGE
  ] as const;

  private static readonly DEFAULT_ROOT_SYS_SLOTS_WITH_MARKER = [
    ...MenuService.DEFAULT_ROOT_SYS_SLOTS,
    MenuService.SYS_SLOT_CONFIGURED_MARKER
  ] as const;

  /** Returns stored slot order for page (content ids + __nav_back / __nav_to_main), or null if not set. */
  public async getPageNavConfig(pageId: string): Promise<string[] | null> {
    const row = await this.prisma.pageNavConfig.findUnique({
      where: { menuItemId: pageId }
    });
    if (!row || !Array.isArray(row.slotOrder)) return null;
    return row.slotOrder as string[];
  }

  /** Saves slot order for page. slotOrder may include menu item ids and NAV_SLOT_BACK, NAV_SLOT_TO_MAIN. */
  public async setPageNavConfig(pageId: string, slotOrder: string[], actorUserId: string): Promise<void> {
    await this.prisma.pageNavConfig.upsert({
      where: { menuItemId: pageId },
      create: { menuItemId: pageId, slotOrder },
      update: { slotOrder }
    });
    await this.audit.log(actorUserId, "set_page_nav_config", "page_nav_config", pageId, { slotOrder });
  }

  /**
   * Adds a newly created child's id to the parent page's slot order.
   * If no PageNavConfig exists, the default order already includes all children—no change needed.
   * If PageNavConfig exists, the new id is inserted before nav slots (__nav_back, __nav_to_main).
   */
  public async addNewChildToSlotOrder(
    parentPageId: string,
    newChildId: string,
    actorUserId: string
  ): Promise<void> {
    const stored = await this.getPageNavConfig(parentPageId);
    if (stored == null || stored.length === 0) return;
    if (stored.includes(newChildId)) return;
    const navSlots = [MenuService.NAV_SLOT_BACK, MenuService.NAV_SLOT_TO_MAIN];
    const nonContentSlots = new Set<string>([...navSlots, ...MenuService.DEFAULT_ROOT_SYS_SLOTS_WITH_MARKER]);

    const contentPart: string[] = [];
    const tailPart: string[] = [];
    let hasTail = false;
    for (const s of stored) {
      if (nonContentSlots.has(s)) {
        hasTail = true;
        tailPart.push(s);
      } else if (!hasTail) {
        contentPart.push(s);
      } else {
        // Legacy/edge case: once tail started, keep everything after as tail.
        tailPart.push(s);
      }
    }
    contentPart.push(newChildId);
    const next = [...contentPart, ...tailPart];
    await this.setPageNavConfig(parentPageId, next, actorUserId);
  }

  /**
   * Returns effective slot order for a page: from config if present, else default.
   * For root: default = contentIds only (no nav in editor). For non-root: default = contentIds + __nav_back + __nav_to_main.
   */
  public async getEffectiveSlotOrder(pageId: string, contentIdsOrdered: string[]): Promise<string[]> {
    const stored = await this.getPageNavConfig(pageId);
    const isRoot = pageId === "root";

    if (isRoot) {
      const defaultEffective = [...contentIdsOrdered, ...MenuService.DEFAULT_ROOT_SYS_SLOTS_WITH_MARKER];
      if (stored == null || stored.length === 0) return defaultEffective;

      const sysAndNavSlots = new Set([
        ...MenuService.DEFAULT_ROOT_SYS_SLOTS_WITH_MARKER,
        MenuService.NAV_SLOT_BACK,
        MenuService.NAV_SLOT_TO_MAIN
      ]);

      // Marker means the sys-slot list is explicitly managed by alpha-owner UI.
      if (stored.includes(MenuService.SYS_SLOT_CONFIGURED_MARKER)) {
        // Merge in content IDs that exist now but are missing from stored (fixes sections disappearing).
        // Happens when user opened "Системные кнопки" before creating sections — config saved with only sys slots.
        const storedContentIds = stored.filter((s) => !sysAndNavSlots.has(s));
        const validStored = storedContentIds.filter((id) => contentIdsOrdered.includes(id));
        const missingContentIds = contentIdsOrdered.filter((id) => !stored.includes(id));
        if (missingContentIds.length > 0 || validStored.length !== storedContentIds.length) {
          const contentPart = [...validStored, ...missingContentIds];
          const sysPart = stored.filter((s) => sysAndNavSlots.has(s));
          return [...contentPart, ...sysPart];
        }
        return stored;
      }

      // Legacy config: return custom content order, but ensure sys slots are visible by default.
      const merged = [...stored];
      for (const sys of MenuService.DEFAULT_ROOT_SYS_SLOTS) {
        if (!merged.includes(sys)) merged.push(sys);
      }
      return merged;
    }

    if (stored != null && stored.length > 0) return stored;
    return [...contentIdsOrdered, MenuService.NAV_SLOT_BACK, MenuService.NAV_SLOT_TO_MAIN];
  }

  /**
   * Moves one slot (content id or nav slot) up or down in the page's slot order and saves.
   */
  public async moveSlotOrder(pageId: string, slotId: string, direction: "up" | "down", actorUserId: string): Promise<void> {
    const contentIds = (await this.getChildMenuItemsForAdmin(pageId === "root" ? null : pageId)).map((c) => c.id);
    const effective = await this.getEffectiveSlotOrder(pageId, contentIds);
    const idx = effective.indexOf(slotId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= effective.length) return;
    const a = effective[idx];
    const b = effective[swapIdx];
    if (a === undefined || b === undefined) return;
    effective[idx] = b;
    effective[swapIdx] = a;
    await this.setPageNavConfig(pageId, effective, actorUserId);
  }

  /**
   * Toggles nav slot visibility: if present in slot order removes it (hide), else adds at end (show).
   */
  public async toggleNavSlot(pageId: string, slotId: string, actorUserId: string): Promise<void> {
    if (slotId !== MenuService.NAV_SLOT_BACK && slotId !== MenuService.NAV_SLOT_TO_MAIN) return;
    const contentIds = (await this.getChildMenuItemsForAdmin(pageId === "root" ? null : pageId)).map((c) => c.id);
    const effective = await this.getEffectiveSlotOrder(pageId, contentIds);
    const has = effective.includes(slotId);
    const next = has ? effective.filter((s) => s !== slotId) : [...effective, slotId];
    await this.setPageNavConfig(pageId, next, actorUserId);
  }

  /**
   * Runs navigation graph audit for the active template: validates button targets,
   * parent-child links, reachability from root. Use in tests or admin/health checks.
   */
  public async runNavigationAudit(options?: { requireRootContent?: boolean }): Promise<NavigationAuditError[]> {
    const template = await this.prisma.presentationTemplate.findFirst({
      where: this.activeTemplateWhere()
    });
    if (!template) {
      return options?.requireRootContent ? [{ code: "EMPTY_ROOT", message: "No active template" }] : [];
    }

    const items = await this.prisma.menuItem.findMany({
      where: { templateId: template.id, isActive: true },
      select: { id: true, parentId: true, type: true, targetMenuItemId: true }
    });

    const auditItems = items.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      type: row.type,
      targetMenuItemId: row.targetMenuItemId ?? undefined,
      isActive: true
    }));

    const graph = buildNavigationGraph(auditItems);
    return validateNavigationGraph(graph, options);
  }
}
