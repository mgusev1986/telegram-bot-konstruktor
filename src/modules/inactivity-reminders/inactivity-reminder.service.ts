import type { InactivityReminderCtaTargetType, InactivityReminderStateStatus, PrismaClient, ReminderTemplate, User } from "@prisma/client";
import type { Telegram } from "telegraf";
import { Markup } from "telegraf";

import { sendRichMessage } from "../../common/media";
import { renderPersonalizedText } from "../../common/personalization";
import { makeCallbackData } from "../../common/callback-data";
import { NAV_ROOT_DATA } from "../../bot/keyboards";
import type { SchedulerService } from "../jobs/scheduler.service";

import type { InactivityReminderRule } from "@prisma/client";
import { env } from "../../config/env";

export class InactivityReminderService {
  private telegram: Telegram | null = null;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly scheduler: SchedulerService
  ) {}

  public setTelegram(telegram: Telegram): void {
    this.telegram = telegram;
  }

  /**
   * Cancels pending reminders for this user where triggerPageId != keepTriggerPageId.
   * If keepTriggerPageId is null, cancels all pending reminders.
   */
  public async cancelPendingForUserExcept(userId: string, keepTriggerPageId: string | null): Promise<number> {
    const now = new Date();
    const pending = await this.prisma.userInactivityReminderState.findMany({
      where: {
        userId,
        status: "PENDING",
        ...(keepTriggerPageId == null ? {} : { triggerPageId: { not: keepTriggerPageId } })
      },
      select: {
        id: true,
        schedulerJobId: true,
        triggerPageId: true
      }
    });

    let cancelledCount = 0;
    for (const st of pending) {
      if (st.schedulerJobId) {
        await this.scheduler.cancelScheduledJobById(st.schedulerJobId).catch(() => undefined);
      }
      await this.prisma.userInactivityReminderState.update({
        where: { id: st.id },
        data: { status: "CANCELLED", cancelledAt: now }
      });
      cancelledCount += 1;
    }
    return cancelledCount;
  }

  public async scheduleForPageOpen(user: User, triggerPageId: string, opts: { shouldSchedule: boolean }): Promise<void> {
    if (!opts.shouldSchedule) return;

    const rules = await this.prisma.inactivityReminderRule.findMany({
      where: { triggerPageId, isActive: true },
      include: { template: true }
    });
    if (rules.length === 0) return;

    for (const rule of rules) {
      // One reminder per user per rule (anti-spam).
      const existing = await this.prisma.userInactivityReminderState.findUnique({
        where: {
          userId_ruleId: { userId: user.id, ruleId: rule.id }
        }
      });
      if (existing) continue;

      const scheduledFor = new Date(Date.now() + rule.delayMinutes * 60_000);

      const state = await this.prisma.userInactivityReminderState.create({
        data: {
          userId: user.id,
          ruleId: rule.id,
          triggerPageId,
          targetMenuItemId: rule.targetMenuItemId,
          status: "PENDING",
          scheduledFor
        }
      });

      try {
        const scheduledJob = await this.scheduler.schedule(
          "SEND_INACTIVITY_REMINDER",
          { reminderStateId: state.id, botInstanceId: user.botInstanceId ?? undefined },
          scheduledFor,
          `inact:${state.id}`
        );
        await this.prisma.userInactivityReminderState.update({
          where: { id: state.id },
          data: { schedulerJobId: scheduledJob.id }
        });
      } catch (e) {
        await this.prisma.userInactivityReminderState.update({
          where: { id: state.id },
          data: { status: "EXPIRED" }
        }).catch(() => undefined);
        throw e;
      }
    }
  }

  public async cancelPendingForRule(ruleId: string): Promise<number> {
    const now = new Date();
    const pending = await this.prisma.userInactivityReminderState.findMany({
      where: { ruleId, status: "PENDING" },
      select: { id: true, schedulerJobId: true }
    });

    let cancelled = 0;
    for (const st of pending) {
      if (st.schedulerJobId) await this.scheduler.cancelScheduledJobById(st.schedulerJobId).catch(() => undefined);
      await this.prisma.userInactivityReminderState.update({
        where: { id: st.id },
        data: { status: "CANCELLED", cancelledAt: now }
      });
      cancelled += 1;
    }
    return cancelled;
  }

  public async processScheduledReminderState(reminderStateId: string): Promise<void> {
    if (!this.telegram) return;

    const state = await this.prisma.userInactivityReminderState.findUnique({
      where: { id: reminderStateId },
      include: {
        user: true,
        rule: { include: { template: true } }
      }
    });
    if (!state) return;

    if (state.status !== "PENDING") return;

    const rule = state.rule;
    if (!rule || !rule.isActive) {
      await this.prisma.userInactivityReminderState.update({
        where: { id: state.id },
        data: { status: "EXPIRED" }
      }).catch(() => undefined);
      return;
    }

    // Extra anti-race checks: if user already clicked the target or navigated away, do not send.
    const clickedTarget = await this.prisma.buttonClickEvent.findFirst({
      where: {
        userId: state.userId,
        menuItemId: state.targetMenuItemId,
        createdAt: { gt: state.createdAt }
      },
      select: { id: true }
    });
    if (clickedTarget) {
      await this.prisma.userInactivityReminderState.update({
        where: { id: state.id },
        data: { status: "CANCELLED", cancelledAt: new Date() }
      }).catch(() => undefined);
      return;
    }

    const navigatedAway = await this.prisma.buttonClickEvent.findFirst({
      where: {
        userId: state.userId,
        createdAt: { gt: state.createdAt },
        menuItemId: { not: state.triggerPageId }
      },
      select: { id: true }
    });
    if (navigatedAway) {
      await this.prisma.userInactivityReminderState.update({
        where: { id: state.id },
        data: { status: "EXPIRED" }
      }).catch(() => undefined);
      return;
    }

    const text = renderPersonalizedText(rule.template.text, state.user as any);

    let callbackData: string = NAV_ROOT_DATA;
    if (rule.ctaTargetType !== "ROOT") {
      const targetItem = await this.prisma.menuItem.findUnique({
        where: { id: state.targetMenuItemId },
        select: { id: true, type: true, targetMenuItemId: true }
      });

      const destinationPageId =
        targetItem?.type === "SECTION_LINK" && targetItem.targetMenuItemId
          ? targetItem.targetMenuItemId
          : targetItem?.id ?? null;

      if (destinationPageId) callbackData = makeCallbackData("menu", "open", destinationPageId);
    }

    const keyboard = Markup.inlineKeyboard([[Markup.button.callback(rule.ctaLabel, callbackData)]]);

    await sendRichMessage(
      this.telegram,
      state.user.telegramUserId,
      { text },
      { reply_markup: keyboard }
    );

    await this.prisma.userInactivityReminderState.update({
      where: { id: state.id },
      data: { status: "SENT", sentAt: new Date() }
    });
  }

  // -----------------------
  // Admin helpers (rules/templates).
  // -----------------------

  public async getTemplateById(templateId: string) {
    return this.prisma.reminderTemplate.findUnique({ where: { id: templateId } });
  }

  public async getTemplatesByCategory(params: { languageCode: string; category: string; fallbackLanguageCode?: string }) {
    const primaryLang = String(params.languageCode ?? "").toLowerCase();
    const fallbackLang = String(params.fallbackLanguageCode ?? env.DEFAULT_LANGUAGE ?? "ru").toLowerCase();

    const primary = await this.prisma.reminderTemplate.findMany({
      where: {
        isActive: true,
        languageCode: primaryLang,
        category: params.category as any
      },
      orderBy: { sortOrder: "asc" }
    });

    if (primary.length > 0) return primary;

    return this.prisma.reminderTemplate.findMany({
      where: {
        isActive: true,
        languageCode: fallbackLang,
        category: params.category as any
      },
      orderBy: { sortOrder: "asc" }
    });
  }

  public async getAllActiveTemplatesGrouped(languageCode: string) {
    const categories = ["SOFT", "MOTIVATING", "BUSINESS", "LIGHT_HUMOR", "HOOKING", "CALL_TO_ACTION"] as const;
    const out: Record<string, ReminderTemplate[]> = {};
    for (const cat of categories) out[cat] = [];

    // Load for requested language first; if any category is empty, fallback to RU for that category.
    for (const cat of categories) {
      out[cat] = await this.getTemplatesByCategory({ languageCode, category: cat });
    }
    return out;
  }

  public async upsertRuleForTriggerPage(input: {
    triggerPageId: string;
    templateId: string;
    targetMenuItemId: string;
    delayMinutes: number; // 1–1440
    ctaLabel: string;
    ctaTargetType: InactivityReminderCtaTargetType;
    ruleId?: string;
  }) {
    const template = await this.prisma.reminderTemplate.findUnique({
      where: { id: input.templateId },
      select: { id: true, isActive: true }
    });
    if (!template || !template.isActive) {
      throw new Error("Template not found or inactive");
    }
    const delay = Math.max(1, Math.min(1440, Math.round(input.delayMinutes)));
    if (Number.isNaN(delay) || delay < 1 || delay > 1440) {
      throw new Error("delayMinutes must be between 1 and 1440");
    }

    if (input.ruleId) {
      return this.prisma.inactivityReminderRule.update({
        where: { id: input.ruleId },
        data: {
        templateId: input.templateId,
        targetMenuItemId: input.targetMenuItemId,
        delayMinutes: delay,
          ctaLabel: input.ctaLabel,
          ctaTargetType: input.ctaTargetType,
          isActive: true
        },
        include: { template: true }
      });
    }

    return this.prisma.inactivityReminderRule.create({
      data: {
        templateId: input.templateId,
        triggerPageId: input.triggerPageId,
        targetMenuItemId: input.targetMenuItemId,
        delayMinutes: delay,
        ctaLabel: input.ctaLabel,
        ctaTargetType: input.ctaTargetType,
        isActive: true
      },
      include: { template: true }
    });
  }

  public async getRuleByTriggerPageId(triggerPageId: string) {
    return this.prisma.inactivityReminderRule.findFirst({
      where: { triggerPageId },
      orderBy: { createdAt: "desc" },
      include: { template: true }
    });
  }

  public async getRuleById(ruleId: string) {
    return this.prisma.inactivityReminderRule.findUnique({
      where: { id: ruleId },
      include: { template: true }
    });
  }

  public async listRulesForTriggerPageId(triggerPageId: string) {
    return this.prisma.inactivityReminderRule.findMany({
      where: { triggerPageId },
      include: { template: true },
      orderBy: { createdAt: "asc" }
    });
  }

  public async setRuleActive(ruleId: string, isActive: boolean): Promise<void> {
    await this.prisma.inactivityReminderRule.update({
      where: { id: ruleId },
      data: { isActive }
    });

    if (!isActive) {
      await this.cancelPendingForRule(ruleId);
    }
  }

  public async deleteRule(ruleId: string): Promise<void> {
    await this.cancelPendingForRule(ruleId);
    await this.prisma.inactivityReminderRule.delete({ where: { id: ruleId } });
  }

  public async deleteRuleByTriggerPageId(triggerPageId: string): Promise<void> {
    const rules = await this.listRulesForTriggerPageId(triggerPageId);
    for (const rule of rules) {
      await this.deleteRule(rule.id);
    }
  }
}

