import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import {
  buildNavigationGraph,
  validateNavigationGraph,
  type MenuItemType,
  type AuditMenuItem
} from "../menu/navigation-audit";

export type BotCloneInput = {
  sourceBotInstanceId: string;
  actorBackofficeUserId: string;
  newBot: {
    name: string;
    telegramBotTokenEncrypted: string;
    telegramBotTokenHash: string;
    telegramBotUsername: string | null;
    paidAccessEnabled: boolean;
    isArchived: boolean;
  };
};

function uniqueCode(base: string, suffix: string): string {
  return `${base}_clone_${suffix}`;
}

function mapProductIdInConfigJson(
  configJson: unknown,
  productIdMap: Map<string, string>
): unknown {
  if (!configJson || typeof configJson !== "object") return configJson;
  const obj = configJson as Record<string, unknown>;
  if (!("productId" in obj)) return configJson;
  const oldProductId = obj.productId == null ? null : String(obj.productId);
  if (!oldProductId) return configJson;
  const mapped = productIdMap.get(oldProductId);
  if (!mapped) return configJson;
  return {
    ...obj,
    productId: mapped
  };
}

export class BotCloneService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async cloneBot(input: BotCloneInput): Promise<{ newBotInstanceId: string; newTemplateId: string }> {
    const sourceBot = await this.prisma.botInstance.findUniqueOrThrow({
      where: { id: input.sourceBotInstanceId },
      select: {
        id: true,
        status: true,
        paidAccessEnabled: true,
        isArchived: true
      }
    });

    const sourceTemplate = await this.prisma.presentationTemplate.findFirstOrThrow({
      where: { botInstanceId: sourceBot.id, isActive: true },
      include: {
        localizations: true,
        draftLocalizations: true
      }
    });

    const sourceMenuItems = await this.prisma.menuItem.findMany({
      where: { templateId: sourceTemplate.id },
      include: {
        localizations: true,
        draftLocalizations: true
      }
    });

    const sourceProductIds = Array.from(
      new Set(sourceMenuItems.map((mi) => mi.productId).filter((x): x is string => Boolean(x)))
    );

    const sourceAccessRuleIds = Array.from(
      new Set(sourceMenuItems.map((mi) => mi.accessRuleId).filter((x): x is string => Boolean(x)))
    );

    const sourceProducts = sourceProductIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: sourceProductIds } },
          include: { localizations: true }
        })
      : [];

    const sourceAccessRules = sourceAccessRuleIds.length
      ? await this.prisma.accessRule.findMany({
          where: { id: { in: sourceAccessRuleIds } }
        })
      : [];

    const sourcePageNavConfigs = await this.prisma.pageNavConfig.findMany({
      where: { menuItemId: { in: sourceMenuItems.map((mi) => mi.id) } }
    });

    const sourceDripCampaigns = await this.prisma.dripCampaign.findMany({
      where: { botInstanceId: sourceBot.id },
      include: {
        steps: {
          include: { localizations: true }
        }
      }
    });

    const suffix = randomUUID().slice(0, 8);
    const newBotInstanceId = randomUUID();

    const newMenuItemIdMap = new Map<string, string>();
    for (const mi of sourceMenuItems) newMenuItemIdMap.set(mi.id, randomUUID());

    const newProductIdMap = new Map<string, string>();
    const newAccessRuleIdMap = new Map<string, string>();

    const shouldActivate = sourceBot.status === "ACTIVE" && !sourceBot.isArchived && !input.newBot.isArchived;

    const result = await this.prisma.$transaction(async (tx) => {
      const newBot = await tx.botInstance.create({
        data: {
          id: newBotInstanceId,
          ownerBackofficeUserId: input.actorBackofficeUserId,
          name: input.newBot.name,
          telegramBotTokenEncrypted: input.newBot.telegramBotTokenEncrypted,
          telegramBotTokenHash: input.newBot.telegramBotTokenHash,
          telegramBotUsername: input.newBot.telegramBotUsername,
          status: shouldActivate ? "DISABLED" : "DISABLED",
          paidAccessEnabled: input.newBot.paidAccessEnabled,
          isArchived: input.newBot.isArchived
        }
      });

      const newTemplate = await tx.presentationTemplate.create({
        data: {
          title: `${input.newBot.name} Template`,
          ownerAdminId: sourceTemplate.ownerAdminId,
          botInstanceId: newBot.id,
          baseLanguageCode: sourceTemplate.baseLanguageCode,
          isActive: true
        }
      });

      if (sourceTemplate.localizations.length) {
        await tx.presentationLocalization.createMany({
          data: sourceTemplate.localizations.map((l) => ({
            templateId: newTemplate.id,
            languageCode: l.languageCode,
            welcomeText: l.welcomeText,
            welcomeMediaType: l.welcomeMediaType,
            welcomeMediaFileId: l.welcomeMediaFileId
          }))
        });
      }

      if (sourceTemplate.draftLocalizations.length) {
        await tx.presentationLocalizationDraft.createMany({
          data: sourceTemplate.draftLocalizations.map((l) => ({
            templateId: newTemplate.id,
            languageCode: l.languageCode,
            welcomeText: l.welcomeText,
            welcomeMediaType: l.welcomeMediaType,
            welcomeMediaFileId: l.welcomeMediaFileId
          }))
        });
      }

      // 1) Clone products first (access rules PRODUCT_PURCHASE config references product ids).
      for (const p of sourceProducts) {
        const newCode = uniqueCode(p.code, suffix);
        const created = await tx.product.create({
          data: {
            code: newCode,
            type: p.type,
            price: p.price,
            currency: p.currency,
            billingType: p.billingType,
            durationDays: p.durationDays,
            isActive: p.isActive,
            localizations: {
              create: p.localizations.map((pl) => ({
                languageCode: pl.languageCode,
                title: pl.title,
                description: pl.description,
                payButtonText: pl.payButtonText
              }))
            }
          }
        });
        newProductIdMap.set(p.id, created.id);
      }

      // 2) Clone access rules (remap productId inside PRODUCT_PURCHASE config).
      for (const r of sourceAccessRules) {
        const newCode = uniqueCode(r.code, suffix);
        const mappedConfig = mapProductIdInConfigJson(r.configJson, newProductIdMap);
        const created = await tx.accessRule.create({
          data: {
            code: newCode,
            ruleType: r.ruleType,
            configJson: mappedConfig as any,
            isActive: r.isActive
          }
        });
        newAccessRuleIdMap.set(r.id, created.id);
      }

      // 3) Clone menu items (with localizations).
      for (const mi of sourceMenuItems) {
        const newId = newMenuItemIdMap.get(mi.id)!;
        const newParentId = mi.parentId ? newMenuItemIdMap.get(mi.parentId) ?? null : null;
        const newTargetId = mi.targetMenuItemId
          ? newMenuItemIdMap.get(mi.targetMenuItemId) ?? null
          : null;

        const newAccessRuleId = mi.accessRuleId ? newAccessRuleIdMap.get(mi.accessRuleId) ?? null : null;
        const newProductId = mi.productId ? newProductIdMap.get(mi.productId) ?? null : null;

        await tx.menuItem.create({
          data: {
            id: newId,
            templateId: newTemplate.id,
            parentId: newParentId,
            key: `${mi.key}_clone_${suffix}_${newId.slice(0, 6)}`,
            type: mi.type as MenuItemType,
            sortOrder: mi.sortOrder,
            isActive: mi.isActive,
            visibilityMode: mi.visibilityMode,
            accessRuleId: newAccessRuleId ?? undefined,
            productId: newProductId ?? undefined,
            targetMenuItemId: newTargetId ?? undefined,
            localizations: {
              create: mi.localizations.map((l) => ({
                languageCode: l.languageCode,
                title: l.title,
                contentText: l.contentText,
                mediaType: l.mediaType,
                mediaFileId: l.mediaFileId,
                externalUrl: l.externalUrl
              }))
            },
            draftLocalizations: {
              create: mi.draftLocalizations.map((l) => ({
                languageCode: l.languageCode,
                title: l.title,
                contentText: l.contentText,
                mediaType: l.mediaType,
                mediaFileId: l.mediaFileId,
                externalUrl: l.externalUrl
              }))
            }
          }
        });
      }

      // 4) Clone page nav configs (and remap ids inside slotOrder).
      for (const cfg of sourcePageNavConfigs) {
        const newMenuItemId = newMenuItemIdMap.get(cfg.menuItemId);
        if (!newMenuItemId) continue;

        const slotOrder = Array.isArray(cfg.slotOrder) ? (cfg.slotOrder as string[]) : [];
        const remappedSlotOrder = slotOrder.map((id) => {
          if (newMenuItemIdMap.has(id)) return newMenuItemIdMap.get(id)!;
          return id;
        });

        await tx.pageNavConfig.create({
          data: {
            menuItemId: newMenuItemId,
            slotOrder: remappedSlotOrder
          }
        });
      }

      // 5) Clone drip campaigns (configuration only, without user progress).
      for (const camp of sourceDripCampaigns) {
        const newCampaign = await tx.dripCampaign.create({
          data: {
            title: camp.title,
            isActive: camp.isActive,
            triggerType: camp.triggerType,
            createdByUserId: camp.createdByUserId,
            botInstanceId: newBotInstanceId
          }
        });

        const newStepIdMap = new Map<string, string>();
        for (const st of camp.steps) newStepIdMap.set(st.id, randomUUID());

        for (const st of camp.steps) {
          const createdStep = await tx.dripStep.create({
            data: {
              id: newStepIdMap.get(st.id)!,
              campaignId: newCampaign.id,
              stepOrder: st.stepOrder,
              delayValue: st.delayValue,
              delayUnit: st.delayUnit,
              localizations: {
                create: st.localizations.map((l) => ({
                  languageCode: l.languageCode,
                  text: l.text,
                  mediaType: l.mediaType,
                  mediaFileId: l.mediaFileId,
                  externalUrl: l.externalUrl
                }))
              }
            }
          });
          void createdStep;
        }
      }

      // 6) Integrity validation (navigation graph for active items).
      const clonedMenuItems = await tx.menuItem.findMany({
        where: { templateId: newTemplate.id },
        select: { id: true, parentId: true, type: true, targetMenuItemId: true, isActive: true }
      });

      const auditItems: AuditMenuItem[] = clonedMenuItems
        .filter((i) => i.isActive)
        .map((i) => ({
          id: i.id,
          parentId: i.parentId ?? null,
          type: i.type as MenuItemType,
          targetMenuItemId: i.type === "SECTION_LINK" ? (i.targetMenuItemId ?? undefined) : undefined,
          isActive: true
        }));

      const graph = buildNavigationGraph(auditItems);
      const errors = validateNavigationGraph(graph, { requireRootContent: true });
      if (errors.length > 0) {
        throw new Error(`Clone navigation validation failed: ${errors.map((e) => e.code).join(", ")}`);
      }

      if (shouldActivate) {
        await tx.botInstance.update({
          where: { id: newBotInstanceId },
          data: { status: "ACTIVE", isArchived: false }
        });
      }

      return { newBotInstanceId: newBotInstanceId, newTemplateId: newTemplate.id };
    });

    return result;
  }
}

