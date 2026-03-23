import { Queue, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "@prisma/client";

import { QUEUE_NAMES } from "../../common/constants";
import { toJsonValue } from "../../common/json";
import { logger } from "../../common/logger";

export interface QueuePayload {
  scheduledJobId: string;
}

type QueueJobLike = {
  getState(): Promise<string>;
  promote(): Promise<void>;
};

type QueueLike = {
  add(
    name: string,
    data: QueuePayload,
    opts: {
      jobId: string;
      delay: number;
      removeOnComplete: number;
      removeOnFail: number;
    }
  ): Promise<unknown>;
  remove(jobId: string): Promise<unknown>;
  getJob(jobId: string): Promise<QueueJobLike | undefined>;
};

const RETRYABLE_TERMINAL_DUE_JOB_TYPES = new Set([
  "SEND_SUBSCRIPTION_REMINDER",
  "PROCESS_ACCESS_EXPIRY",
  "PROCESS_PAYMENT_EXPIRY",
  "SEND_INACTIVITY_REMINDER"
]);

export class SchedulerService {
  private readonly queue: QueueLike;

  public constructor(
    private readonly prisma: PrismaClient,
    connection: ConnectionOptions,
    private readonly botInstanceId?: string,
    queueOverride?: QueueLike
  ) {
    this.queue = queueOverride
      ?? new Queue<QueuePayload>(QUEUE_NAMES.scheduled, {
        connection
      });
  }

  public async schedule(
    jobType:
      | "SEND_BROADCAST"
      | "SEND_BROADCAST_BATCH"
      | "SEND_DRIP_STEP"
      | "SEND_NOTIFICATION"
      | "PROCESS_PAYMENT_EXPIRY"
      | "SEND_INACTIVITY_REMINDER"
      | "GENERATE_LANGUAGE_VERSION_AI"
      | "SEND_SUBSCRIPTION_REMINDER"
      | "PROCESS_ACCESS_EXPIRY",
    payloadJson: Record<string, unknown>,
    runAt: Date,
    idempotencyKey: string
  ) {
    const effectiveBotId =
      payloadJson.botInstanceId && String(payloadJson.botInstanceId).trim()
        ? String(payloadJson.botInstanceId)
        : this.botInstanceId;
    const payloadWithBot = effectiveBotId ? { ...payloadJson, botInstanceId: effectiveBotId } : payloadJson;
    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    const existing = await this.prisma.scheduledJob.findUnique({
      where: { idempotencyKey }
    });

    if (existing) {
      return existing;
    }

    const scheduledJob = await this.prisma.scheduledJob.create({
      data: {
        jobType,
        payloadJson: toJsonValue(payloadWithBot),
        runAt,
        idempotencyKey
      }
    });

    // Helpful for debugging delayed delivery issues.
    logger.info(
      {
        jobType,
        scheduledJobId: scheduledJob.id,
        runAt: runAt.toISOString(),
        delayMs,
        idempotencyKey
      },
      "Scheduled job created"
    );
    await this.enqueue(scheduledJob.id, runAt);
    return scheduledJob;
  }

  public async enqueue(scheduledJobId: string, runAt: Date): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - Date.now());
    await this.queue.add(
      QUEUE_NAMES.scheduled,
      { scheduledJobId },
      {
        jobId: scheduledJobId,
        delay,
        removeOnComplete: 100,
        removeOnFail: 1000
      }
    );
  }

  /**
   * Cancel all queued scheduled jobs whose idempotencyKey starts with a prefix.
   * Used to stop scheduled broadcasts.
   */
  public async cancelByIdempotencyKeyPrefix(prefix: string): Promise<number> {
    const now = new Date();
    const jobs = await this.prisma.scheduledJob.findMany({
      where: {
        idempotencyKey: { startsWith: prefix },
        status: { in: ["PENDING", "RUNNING"] }
      },
      select: { id: true }
    });

    const jobIds = jobs.map((j) => j.id);
    if (jobIds.length === 0) return 0;

    // Remove from BullMQ to prevent worker execution.
    await Promise.allSettled(jobIds.map((id) => this.queue.remove(id).catch(() => undefined)));

    await this.prisma.scheduledJob.updateMany({
      where: { id: { in: jobIds } },
      data: {
        status: "CANCELLED",
        processedAt: now
      }
    });

    return jobIds.length;
  }

  public async cancelScheduledJobById(scheduledJobId: string): Promise<boolean> {
    const existing = await this.prisma.scheduledJob.findUnique({
      where: { id: scheduledJobId },
      select: { id: true, status: true }
    });

    if (!existing) return false;
    if (!["PENDING", "RUNNING"].includes(existing.status)) return false;

    await this.queue.remove(scheduledJobId).catch(() => undefined);
    await this.prisma.scheduledJob.update({
      where: { id: scheduledJobId },
      data: { status: "CANCELLED", processedAt: new Date() }
    });
    return true;
  }

  public async recoverPendingJobs(): Promise<void> {
    const pendingJobs = await this.prisma.scheduledJob.findMany({
      where: {
        status: "PENDING"
      }
    });

    for (const job of pendingJobs) {
      await this.enqueue(job.id, job.runAt);
    }
  }

  public async recoverDueJobs(limit = 100): Promise<number> {
    const dueJobs = await this.prisma.scheduledJob.findMany({
      where: {
        status: "PENDING",
        runAt: {
          lte: new Date()
        }
      },
      orderBy: {
        runAt: "asc"
      },
      take: limit,
      select: {
        id: true,
        jobType: true,
        runAt: true
      }
    });

    let recovered = 0;

    for (const job of dueJobs) {
      const queueJob = await this.queue.getJob(job.id);

      if (!queueJob) {
        await this.enqueue(job.id, new Date());
        recovered += 1;
        continue;
      }

      const state = await queueJob.getState();
      if (state === "delayed") {
        await queueJob.promote();
        recovered += 1;
        continue;
      }

      if (
        (state === "completed" || state === "failed")
        && RETRYABLE_TERMINAL_DUE_JOB_TYPES.has(job.jobType)
      ) {
        logger.warn(
          {
            scheduledJobId: job.id,
            jobType: job.jobType,
            queueState: state
          },
          "Recovering due job with terminal BullMQ state but pending DB status"
        );
        await this.queue.remove(job.id).catch(() => undefined);
        await this.enqueue(job.id, new Date());
        recovered += 1;
      }
    }

    if (recovered > 0) {
      logger.info(
        {
          recovered,
          limit
        },
        "Recovered due scheduled jobs"
      );
    }

    return recovered;
  }

  public async markRunning(scheduledJobId: string): Promise<void> {
    await this.prisma.scheduledJob.update({
      where: { id: scheduledJobId },
      data: {
        status: "RUNNING",
        lockedAt: new Date()
      }
    });
  }

  public async markCompleted(scheduledJobId: string): Promise<void> {
    await this.prisma.scheduledJob.update({
      where: { id: scheduledJobId },
      data: {
        status: "COMPLETED",
        processedAt: new Date()
      }
    });
  }

  public async markFailed(scheduledJobId: string, errorMessage: string): Promise<void> {
    await this.prisma.scheduledJob.update({
      where: { id: scheduledJobId },
      data: {
        status: "FAILED",
        processedAt: new Date(),
        errorMessage,
        retryCount: {
          increment: 1
        }
      }
    });
  }
}
