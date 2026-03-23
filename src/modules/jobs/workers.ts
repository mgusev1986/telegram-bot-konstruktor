import { Worker, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "@prisma/client";

import { QUEUE_NAMES } from "../../common/constants";
import { logger } from "../../common/logger";
import type { BroadcastService } from "../broadcasts/broadcast.service";
import type { DripService } from "../drip/drip.service";
import type { InactivityReminderService } from "../inactivity-reminders/inactivity-reminder.service";
import type { SchedulerService } from "./scheduler.service";
import type { NavigationService } from "../navigation/navigation.service";
import type { I18nService } from "../i18n/i18n.service";
import type { BotRuntimeManager } from "../../bot/bot-runtime-manager";
import { AiTranslationService } from "../ai/ai-translation.service";
import { LanguageGenerationService } from "../ai/language-generation.service";
import { createAiTranslationProvider } from "../ai/providers/provider-factory";
import { OwnerPayoutService } from "../payments/owner-payout.service";

interface WorkerDependencies {
  prisma: PrismaClient;
  connection: ConnectionOptions;
  scheduler: SchedulerService;
  runtimeManager: BotRuntimeManager;
}

export const startWorkers = ({
  prisma,
  connection,
  scheduler,
  runtimeManager
}: WorkerDependencies): Worker => {
  const worker = new Worker(
    QUEUE_NAMES.scheduled,
    async (job) => {
      const scheduledJobId = job.data.scheduledJobId;
      const scheduledJob = await prisma.scheduledJob.findUniqueOrThrow({
        where: { id: scheduledJobId }
      });

      const payload = scheduledJob.payloadJson as Record<string, unknown>;
      const jobType = scheduledJob.jobType as string;

      if (jobType === "PROCESS_OWNER_DAILY_PAYOUTS") {
        const payoutService = new OwnerPayoutService(prisma);
        const botId = payload.botInstanceId ? String(payload.botInstanceId) : null;
        const results = botId
          ? [await payoutService.processBotPayout(botId)]
          : await payoutService.processAllBots();
        logger.info(
          { scheduledJobId, results: results.map((r) => ({ bot: r.botInstanceId, status: r.status })) },
          "PROCESS_OWNER_DAILY_PAYOUTS completed"
        );
        await scheduler.markCompleted(scheduledJobId);
        return;
      }

      const botInstanceId = (payload.botInstanceId ? String(payload.botInstanceId) : runtimeManager.getFirstRuntime()?.botInstanceId) ?? null;
      if (!botInstanceId) {
        throw new Error(`Missing botInstanceId for scheduled job ${scheduledJobId} (${jobType})`);
      }

      const runtime = await runtimeManager.startBotInstance(botInstanceId, { launch: false });
      logger.info(
        {
          scheduledJobId,
          jobType: scheduledJob.jobType,
          runAt: scheduledJob.runAt.toISOString(),
          payload
        },
        "Scheduled worker picked job"
      );

      await scheduler.markRunning(scheduledJobId);

      try {
        switch (scheduledJob.jobType) {
          case "SEND_BROADCAST":
            {
              const broadcastId = String(payload.broadcastId);
              const status = await prisma.broadcast.findUnique({
                where: { id: broadcastId },
                select: { status: true }
              });
              if (status?.status === "CANCELLED") {
                logger.info({ scheduledJobId, broadcastId }, "SEND_BROADCAST skipped (broadcast cancelled)");
                break;
              }
              await runtime.services.broadcasts.dispatchBroadcast(broadcastId);
            }
            break;
          case "SEND_BROADCAST_BATCH": {
            const broadcastId = String(payload.broadcastId);
            const recipientTimeZone = (payload.recipientTimeZone ?? null) as string | null;
            const fallbackTimeZone = (payload.fallbackTimeZone ?? "UTC") as string;
            const status = await prisma.broadcast.findUnique({
              where: { id: broadcastId },
              select: { status: true }
            });
            if (status?.status === "CANCELLED") {
              logger.info({ scheduledJobId, broadcastId }, "SEND_BROADCAST_BATCH skipped (broadcast cancelled)");
              break;
            }
            {
              const stats = await runtime.services.broadcasts.dispatchBroadcast(broadcastId, {
                recipientTimeZone,
                fallbackTimeZone,
                batchMode: true
              });
              logger.info(
                {
                  broadcastId,
                  recipientTimeZone,
                  fallbackTimeZone,
                  stats
                },
                "SEND_BROADCAST_BATCH finished"
              );
            }
            break;
          }
          case "SEND_DRIP_STEP":
            await runtime.services.drips.processProgress(String(payload.progressId));
            break;
          case "SEND_INACTIVITY_REMINDER":
            await runtime.services.inactivityReminders.processScheduledReminderState(String(payload.reminderStateId));
            break;
          case "PROCESS_PAYMENT_EXPIRY": {
            const paymentId = String(payload.paymentId ?? "");
            if (!paymentId) {
              throw new Error(`Missing paymentId for PROCESS_PAYMENT_EXPIRY (${scheduledJobId})`);
            }

            const payment = await prisma.payment.findUnique({
              where: { id: paymentId },
              select: { id: true, status: true, expiresAt: true, user: { select: { id: true } } }
            });

            if (payment && payment.status !== "PAID") {
              const now = Date.now();
              const expired = payment.expiresAt ? payment.expiresAt.getTime() <= now : true;
              if (expired) {
                await prisma.payment.update({
                  where: { id: paymentId },
                  data: { status: "EXPIRED" }
                });
              }
            }

            break;
          }
          case "SEND_SUBSCRIPTION_REMINDER": {
            const accessRightId = String(payload.accessRightId ?? "");
            const daysLeft = Number(payload.daysLeft ?? 1);
            const minutesLeft = Number(payload.minutesLeft ?? 0);
            if (accessRightId) {
              await runtime.services.subscriptionChannel.sendReminder(accessRightId, {
                ...(minutesLeft > 0 ? { minutesLeft } : { daysLeft })
              });
            }
            break;
          }
          case "PROCESS_ACCESS_EXPIRY": {
            const accessRightId = String(payload.accessRightId ?? "");
            if (accessRightId) {
              await runtime.services.subscriptionChannel.processExpiry(accessRightId);
            }
            break;
          }
          case "GENERATE_LANGUAGE_VERSION_AI": {
            const taskId = String(payload.taskId);
            const providerOverride = typeof payload.providerOverride === "string" ? payload.providerOverride : undefined;
            const provider = createAiTranslationProvider(providerOverride as any);
            const svc = new LanguageGenerationService(prisma, {
              i18n: runtime.services.i18n,
              navigation: runtime.services.navigation,
              telegram: runtime.bot.telegram,
              aiTranslation: new AiTranslationService(provider),
              audit: runtime.services.audit
            });
            await svc.processTask(taskId);
            break;
          }
          default:
            logger.warn({ scheduledJobId, jobType: scheduledJob.jobType }, "Unhandled scheduled job type");
        }

        await scheduler.markCompleted(scheduledJobId);
      } catch (error) {
        await scheduler.markFailed(
          scheduledJobId,
          error instanceof Error ? error.message : "Unknown scheduled job error"
        );
        throw error;
      }
    },
    {
      connection,
      concurrency: 5
    }
  );

  worker.on("failed", (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        error
      },
      "Background worker failed"
    );
  });

  worker.on("ready", () => {
    logger.info("Background worker ready");
  });

  worker.on("error", (error) => {
    logger.error({ err: error }, "Background worker error");
  });

  return worker;
};
