import type { PrismaClient } from "@prisma/client";
import type { ConnectionOptions } from "bullmq";

import { env } from "../config/env";

import { AbTestService } from "../modules/ab/ab-test.service";
import { AccessRuleService } from "../modules/access/access-rule.service";
import { AnalyticsService } from "../modules/analytics/analytics.service";
import { AuditService } from "../modules/audit/audit.service";
import { BroadcastService } from "../modules/broadcasts/broadcast.service";
import { BotRoleAssignmentService } from "../modules/bot-roles/bot-role-assignment.service";
import { CabinetService } from "../modules/cabinet/cabinet.service";
import { CrmService } from "../modules/crm/crm.service";
import { DripService } from "../modules/drip/drip.service";
import { ExportService } from "../modules/exports/export.service";
import { I18nService } from "../modules/i18n/i18n.service";
import { SchedulerService } from "../modules/jobs/scheduler.service";
import { MenuService } from "../modules/menu/menu.service";
import { NavigationService } from "../modules/navigation/navigation.service";
import { NotificationService } from "../modules/notifications/notification.service";
import { PaymentService } from "../modules/payments/payment.service";
import { BalanceService } from "../modules/payments/balance.service";
import { PermissionService } from "../modules/permissions/permission.service";
import { RateLimitService } from "../modules/rate-limit/rate-limit.service";
import { ReferralService } from "../modules/referrals/referral.service";
import { SegmentService } from "../modules/segmentation/segment.service";
import { UserService } from "../modules/users/user.service";
import { MediaLibraryService } from "../modules/media-library/media-library.service";
import { InactivityReminderService } from "../modules/inactivity-reminders/inactivity-reminder.service";
import { LanguageGenerationTaskService } from "../modules/ai/language-generation-task.service";
import { SubscriptionChannelService } from "../modules/subscription-channel/subscription-channel.service";

export interface AppServices {
  i18n: I18nService;
  audit: AuditService;
  rateLimit: RateLimitService;
  users: UserService;
  botRoles: BotRoleAssignmentService;
  permissions: PermissionService;
  notifications: NotificationService;
  referrals: ReferralService;
  analytics: AnalyticsService;
  abTests: AbTestService;
  accessRules: AccessRuleService;
  crm: CrmService;
  payments: PaymentService;
  balance: BalanceService;
  menu: MenuService;
  navigation: NavigationService;
  cabinet: CabinetService;
  segments: SegmentService;
  scheduler: SchedulerService;
  broadcasts: BroadcastService;
  drips: DripService;
  inactivityReminders: InactivityReminderService;
  subscriptionChannel: SubscriptionChannelService;
  exports: ExportService;
  mediaLibrary: MediaLibraryService;
  languageGenerationTasks: LanguageGenerationTaskService;
}

export interface BuildServicesOptions {
  botInstanceId?: string;
  botUsername?: string;
  paidAccessEnabled?: boolean;
}

export const buildServices = (
  prisma: PrismaClient,
  redis: import("ioredis").default,
  bullConnection: ConnectionOptions,
  options?: BuildServicesOptions
): AppServices => {
  const i18n = new I18nService();
  const botInstanceId = options?.botInstanceId;
  const botUsername = options?.botUsername ?? env.BOT_USERNAME;
  const paidAccessEnabled = options?.paidAccessEnabled ?? true;
  const audit = new AuditService(prisma);
  const rateLimit = new RateLimitService(redis);
  const users = new UserService(prisma, botInstanceId, audit);
  const notifications = new NotificationService(prisma, i18n);
  const referrals = new ReferralService(prisma, notifications, botInstanceId);
  const analytics = new AnalyticsService(prisma);
  const abTests = new AbTestService(prisma);
  const accessRules = new AccessRuleService(prisma, referrals);
  const crm = new CrmService(prisma);
  const scheduler = new SchedulerService(prisma, bullConnection, botInstanceId);
  const subscriptionChannel = new SubscriptionChannelService(prisma, notifications);
  const payments = new PaymentService(prisma, notifications, audit, crm, scheduler, subscriptionChannel);
  const balance = new BalanceService(prisma, notifications, audit, crm, scheduler, subscriptionChannel);
  const menu = new MenuService(prisma, i18n, accessRules, analytics, abTests, audit, botInstanceId, paidAccessEnabled);
  const navigation = new NavigationService(prisma);
  const cabinet = new CabinetService(prisma, referrals, payments, balance, i18n, botUsername, botInstanceId, paidAccessEnabled);
  const segments = new SegmentService(prisma, referrals, botInstanceId);
  const broadcasts = new BroadcastService(prisma, segments, scheduler, i18n, audit, botInstanceId);
  const drips = new DripService(prisma, scheduler, i18n, audit, botInstanceId, cabinet);
  const exports = new ExportService(prisma, referrals);
  const permissions = new PermissionService(prisma, users, audit, botInstanceId);
  const botRoles = new BotRoleAssignmentService(prisma, botInstanceId ?? "", permissions, audit);
  const mediaLibrary = new MediaLibraryService(prisma);
  const inactivityReminders = new InactivityReminderService(prisma, scheduler, botInstanceId);
  const languageGenerationTasks = new LanguageGenerationTaskService(prisma, i18n);

  return {
    i18n,
    audit,
    rateLimit,
    users,
    botRoles,
    permissions,
    notifications,
    referrals,
    analytics,
    abTests,
    accessRules,
    crm,
    payments,
    balance,
    menu,
    navigation,
    cabinet,
    segments,
    scheduler,
    broadcasts,
    drips,
    inactivityReminders,
    subscriptionChannel,
    exports,
    mediaLibrary,
    languageGenerationTasks
  };
};
