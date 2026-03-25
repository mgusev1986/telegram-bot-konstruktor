import type { DripTriggerType, MediaType, PrismaClient } from "@prisma/client";
import { Markup } from "telegraf";
import type { Telegram } from "telegraf";

import { sendRichMessage } from "../../common/media";
import { makeCallbackData } from "../../common/callback-data";
import type { CabinetService } from "../cabinet/cabinet.service";

const NAV_ROOT_DATA = "nav:root";
import type { User } from "@prisma/client";

/** Inline button for drip step message */
export type DripStepButton =
  | { type: "url"; label: string; url: string }
  | { type: "system"; label: string; systemKind: "partner_register" | "mentor_contact" | "main_menu" }
  | { type: "section"; label: string; targetMenuItemId: string };

export const DRIP_SYSTEM_KINDS = ["partner_register", "mentor_contact", "main_menu"] as const;
export type DripSystemKind = (typeof DRIP_SYSTEM_KINDS)[number];

import { renderPageContent } from "../../common/page-content-render";
import type { AuditService } from "../audit/audit.service";
import type { I18nService } from "../i18n/i18n.service";
import type { SchedulerService } from "../jobs/scheduler.service";

export interface DripStepInput {
  languageCode: string;
  delayValue: number;
  delayUnit: "MINUTES" | "HOURS" | "DAYS";
  text?: string;
  followUpText?: string;
  mediaType?: MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
  buttons?: DripStepButton[];
}

export interface CreateDripCampaignInput {
  actorUserId: string;
  title: string;
  triggerType: DripTriggerType;
  steps: DripStepInput[];
}

export class DripService {
  private telegram: Telegram | null = null;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly scheduler: SchedulerService,
    private readonly i18n: I18nService,
    private readonly audit: AuditService,
    private readonly botInstanceId?: string,
    private readonly cabinet?: CabinetService
  ) {}

  /** Build inline keyboard for drip step buttons, resolving system targets per recipient. */
  public async buildButtonsReplyMarkup(buttonsJson: unknown, user: User): Promise<{ reply_markup: object } | Record<string, never>> {
    const arr = Array.isArray(buttonsJson) ? buttonsJson : [];
    if (arr.length === 0) return {};
    const rows: Array<Array<ReturnType<typeof Markup.button.url> | ReturnType<typeof Markup.button.callback>>> = [];

    for (const b of arr) {
      if (!b || typeof b !== "object" || typeof (b as any).label !== "string") continue;

      const label = (b as any).label as string;

      if ((b as any).type === "url" && typeof (b as any).url === "string") {
        rows.push([Markup.button.url(label, (b as any).url)]);
        continue;
      }

      if ((b as any).type === "system" && typeof (b as any).systemKind === "string") {
        const kind = (b as any).systemKind as DripSystemKind;

        if (kind === "main_menu") {
          rows.push([Markup.button.callback(label, NAV_ROOT_DATA)]);
          continue;
        }

        if (kind === "partner_register" && this.cabinet) {
          const url = await this.cabinet.getPartnerRegisterLinkForUser(user);
          if (url) rows.push([Markup.button.url(label, url)]);
          continue;
        }

        if (kind === "mentor_contact") {
          const mentorUsername =
            user.mentorUserId
              ? (await this.prisma.user.findUnique({
                  where: { id: user.mentorUserId },
                  select: { username: true }
                }))?.username ?? null
              : null;
          if (mentorUsername?.trim()) {
            rows.push([Markup.button.url(label, `https://t.me/${mentorUsername.trim()}`)]);
          } else {
            rows.push([Markup.button.callback(label, makeCallbackData("mentor", "open"))]);
          }
          continue;
        }
      }

      if ((b as any).type === "section" && typeof (b as any).targetMenuItemId === "string") {
        const targetId = (b as any).targetMenuItemId as string;
        rows.push([Markup.button.callback(label, makeCallbackData("menu", "open", targetId))]);
        continue;
      }
    }

    if (rows.length === 0) return {};
    return Markup.inlineKeyboard(rows);
  }

  public setTelegram(telegram: Telegram): void {
    this.telegram = telegram;
  }

  public async createCampaign(input: CreateDripCampaignInput) {
    const campaign = await this.prisma.dripCampaign.create({
      data: {
        title: input.title,
        triggerType: input.triggerType,
        createdByUserId: input.actorUserId,
        botInstanceId: this.botInstanceId ?? undefined,
        steps: {
          create: input.steps.map((step, index) => ({
            stepOrder: index + 1,
            delayValue: step.delayValue,
            delayUnit: step.delayUnit,
            localizations: {
              create: {
                languageCode: step.languageCode,
                text: step.text ?? "",
                followUpText: step.followUpText ?? "",
                mediaType: step.mediaType ?? "NONE",
                mediaFileId: step.mediaFileId ?? undefined,
                externalUrl: step.externalUrl ?? undefined,
                buttonsJson: step.buttons && step.buttons.length > 0 ? (step.buttons as object) : undefined
              }
            }
          }))
        }
      }
    });

    await this.audit.log(input.actorUserId, "create_drip_campaign", "drip_campaign", campaign.id, {
      triggerType: input.triggerType,
      steps: input.steps.length
    });

    return campaign;
  }

  public async listCampaigns(createdByUserId: string) {
    return await this.prisma.dripCampaign.findMany({
      where: { createdByUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      orderBy: { createdAt: "desc" },
      include: {
        steps: {
          orderBy: { stepOrder: "asc" },
          include: { localizations: true }
        }
      }
    });
  }

  public async getCampaign(createdByUserId: string, campaignId: string) {
    return await this.prisma.dripCampaign.findFirst({
      where: { id: campaignId, createdByUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      include: {
        steps: {
          orderBy: { stepOrder: "asc" },
          include: { localizations: true }
        }
      }
    });
  }

  public async toggleCampaignActive(createdByUserId: string, campaignId: string): Promise<boolean | null> {
    const found = await this.prisma.dripCampaign.findFirst({
      where: { id: campaignId, createdByUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      select: { isActive: true }
    });
    if (!found) return null;
    const updated = await this.prisma.dripCampaign.update({
      where: { id: campaignId },
      data: { isActive: !found.isActive },
      select: { isActive: true }
    });
    await this.audit.log(createdByUserId, "toggle_drip_campaign", "drip_campaign", campaignId, { isActive: updated.isActive });
    return updated.isActive;
  }

  public async deleteCampaign(createdByUserId: string, campaignId: string): Promise<boolean> {
    const found = await this.prisma.dripCampaign.findFirst({
      where: { id: campaignId, createdByUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      select: { id: true }
    });
    if (!found) return false;
    await this.prisma.dripCampaign.delete({ where: { id: campaignId } });
    await this.audit.log(createdByUserId, "delete_drip_campaign", "drip_campaign", campaignId, {});
    return true;
  }

  public async appendStep(
    createdByUserId: string,
    campaignId: string,
    input: DripStepInput
  ) {
    const campaign = await this.prisma.dripCampaign.findFirst({
      where: { id: campaignId, createdByUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      include: { steps: true }
    });
    if (!campaign) return null;
    const nextOrder = (campaign.steps.reduce((m, s) => Math.max(m, s.stepOrder), 0) ?? 0) + 1;
    const step = await this.prisma.dripStep.create({
      data: {
        campaignId,
        stepOrder: nextOrder,
        delayValue: input.delayValue,
        delayUnit: input.delayUnit as any,
        localizations: {
          create: {
            languageCode: input.languageCode,
            text: input.text ?? "",
            followUpText: input.followUpText ?? "",
            mediaType: input.mediaType ?? "NONE",
            mediaFileId: input.mediaFileId ?? undefined,
            externalUrl: input.externalUrl ?? undefined,
            buttonsJson: input.buttons && input.buttons.length > 0 ? (input.buttons as object) : undefined
          } as any
        }
      },
      include: { localizations: true }
    });
    await this.audit.log(createdByUserId, "append_drip_step", "drip_step", step.id, { campaignId, stepOrder: nextOrder });
    return step;
  }

  public async deleteStep(createdByUserId: string, campaignId: string, stepId: string): Promise<boolean> {
    const campaign = await this.prisma.dripCampaign.findFirst({
      where: { id: campaignId, createdByUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      select: { id: true }
    });
    if (!campaign) return false;
    const found = await this.prisma.dripStep.findFirst({ where: { id: stepId, campaignId }, select: { id: true } });
    if (!found) return false;
    await this.prisma.dripStep.delete({ where: { id: stepId } });
    await this.audit.log(createdByUserId, "delete_drip_step", "drip_step", stepId, { campaignId });
    return true;
  }

  public async updateStepButtons(
    createdByUserId: string,
    stepId: string,
    languageCode: string,
    buttons: DripStepButton[]
  ): Promise<boolean | null> {
    const step = await this.prisma.dripStep.findFirst({
      where: {
        id: stepId,
        campaign: {
          createdByUserId,
          ...(this.botInstanceId ? { OR: [{ botInstanceId: this.botInstanceId }, { botInstanceId: null }] } : {})
        }
      },
      include: { localizations: true }
    });
    if (!step) return null;
    const loc = step.localizations.find((l) => l.languageCode === languageCode) ?? step.localizations[0];
    if (!loc) return null;
    await this.prisma.dripStepLocalization.update({
      where: { id: loc.id },
      data: {
        buttonsJson: buttons.length > 0 ? (buttons as object) : undefined
      }
    });
    await this.audit.log(createdByUserId, "update_drip_step_buttons", "drip_step_localization", loc.id, {
      stepId,
      buttonCount: buttons.length
    });
    return true;
  }

  public async getStepWithCampaign(createdByUserId: string, stepId: string) {
    return this.prisma.dripStep.findFirst({
      where: {
        id: stepId,
        campaign: {
          createdByUserId,
          ...(this.botInstanceId ? { OR: [{ botInstanceId: this.botInstanceId }, { botInstanceId: null }] } : {})
        }
      },
      include: {
        campaign: true,
        localizations: true
      }
    });
  }

  public async deleteStepById(createdByUserId: string, stepId: string): Promise<{ ok: boolean; campaignId?: string }> {
    const step = await this.prisma.dripStep.findFirst({
      where: {
        id: stepId,
        campaign: { createdByUserId }
      },
      select: { id: true, campaignId: true }
    });
    if (!step) return { ok: false };
    await this.prisma.dripStep.delete({ where: { id: stepId } });
    await this.audit.log(createdByUserId, "delete_drip_step", "drip_step", stepId, { campaignId: step.campaignId });
    return { ok: true, campaignId: step.campaignId };
  }

  public async enrollUser(userId: string, triggerType: DripTriggerType): Promise<void> {
    const campaigns = await this.prisma.dripCampaign.findMany({
      where: {
        isActive: true,
        triggerType,
        ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {})
      },
      include: {
        steps: {
          orderBy: {
            stepOrder: "asc"
          }
        }
      }
    });

    for (const campaign of campaigns) {
      const firstStep = campaign.steps[0];

      if (!firstStep) {
        continue;
      }

      const nextRunAt = this.calculateNextRun(new Date(), firstStep.delayValue, firstStep.delayUnit);
      const progress = await this.prisma.userDripProgress.upsert({
        where: {
          userId_campaignId: {
            userId,
            campaignId: campaign.id
          }
        },
        update: {
          currentStep: 1,
          status: "ACTIVE",
          nextRunAt
        },
        create: {
          userId,
          campaignId: campaign.id,
          botInstanceId: this.botInstanceId ?? undefined,
          currentStep: 1,
          nextRunAt
        }
      });

      await this.scheduler.schedule(
        "SEND_DRIP_STEP",
        { progressId: progress.id },
        nextRunAt,
        `drip:${progress.id}:${progress.currentStep}`
      );
    }
  }

  public async processProgress(progressId: string): Promise<void> {
    const progress = await this.prisma.userDripProgress.findUniqueOrThrow({
      where: { id: progressId },
      include: {
        user: true,
        campaign: {
          include: {
            steps: {
              include: {
                localizations: true
              },
              orderBy: {
                stepOrder: "asc"
              }
            }
          }
        }
      }
    });

    if (progress.status !== "ACTIVE") {
      return;
    }

    const step = progress.campaign.steps.find((item) => item.stepOrder === progress.currentStep);

    if (!step) {
      await this.prisma.userDripProgress.update({
        where: { id: progress.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date()
        }
      });
      return;
    }

    const localization = this.i18n.pickLocalized(step.localizations, progress.user.selectedLanguage) ?? step.localizations[0];

    if (this.telegram && localization) {
      const replyMarkup = await this.buildButtonsReplyMarkup(localization.buttonsJson, progress.user);
      await sendRichMessage(
        this.telegram,
        progress.user.telegramUserId,
        {
          text: renderPageContent(localization.text, progress.user),
          followUpText: (localization as any).followUpText
            ? renderPageContent((localization as any).followUpText, progress.user)
            : undefined,
          mediaType: localization.mediaType,
          mediaFileId: localization.mediaFileId,
          externalUrl: localization.externalUrl
        },
        Object.keys(replyMarkup).length > 0 ? replyMarkup : {}
      );
    }

    const nextStep = progress.campaign.steps.find((item) => item.stepOrder === progress.currentStep + 1);

    if (!nextStep) {
      await this.prisma.userDripProgress.update({
        where: { id: progress.id },
        data: {
          currentStep: progress.currentStep,
          status: "COMPLETED",
          completedAt: new Date(),
          nextRunAt: null
        }
      });
      return;
    }

    const nextRunAt = this.calculateNextRun(new Date(), nextStep.delayValue, nextStep.delayUnit);
    await this.prisma.userDripProgress.update({
      where: { id: progress.id },
      data: {
        currentStep: nextStep.stepOrder,
        nextRunAt
      }
    });

    await this.scheduler.schedule(
      "SEND_DRIP_STEP",
      { progressId: progress.id },
      nextRunAt,
      `drip:${progress.id}:${nextStep.stepOrder}`
    );
  }

  private calculateNextRun(base: Date, delayValue: number, delayUnit: "MINUTES" | "HOURS" | "DAYS"): Date {
    const multiplier =
      delayUnit === "MINUTES" ? 60 * 1000 : delayUnit === "HOURS" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    return new Date(base.getTime() + delayValue * multiplier);
  }
}
