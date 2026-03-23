import { describe, expect, it, vi } from "vitest";

import { SchedulerService } from "../src/modules/jobs/scheduler.service";
import { QUEUE_NAMES } from "../src/common/constants";

describe("SchedulerService.recoverDueJobs", () => {
  it("promotes due delayed jobs already present in BullMQ", async () => {
    const queueJob = {
      getState: vi.fn().mockResolvedValue("delayed"),
      promote: vi.fn().mockResolvedValue(undefined)
    };

    const queue = {
      add: vi.fn(),
      remove: vi.fn(),
      getJob: vi.fn().mockResolvedValue(queueJob)
    };

    const prisma = {
      scheduledJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "job-1",
            jobType: "SEND_SUBSCRIPTION_REMINDER",
            runAt: new Date(Date.now() - 1000)
          }
        ])
      }
    };

    const service = new SchedulerService(prisma as any, {} as any, undefined, queue as any);
    const recovered = await service.recoverDueJobs();

    expect(queue.getJob).toHaveBeenCalledWith("job-1");
    expect(queueJob.promote).toHaveBeenCalledTimes(1);
    expect(recovered).toBe(1);
  });

  it("re-enqueues due jobs missing from BullMQ state", async () => {
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      getJob: vi.fn().mockResolvedValue(undefined)
    };

    const prisma = {
      scheduledJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "job-2",
            jobType: "PROCESS_ACCESS_EXPIRY",
            runAt: new Date(Date.now() - 1000)
          }
        ])
      }
    };

    const service = new SchedulerService(prisma as any, {} as any, undefined, queue as any);
    const recovered = await service.recoverDueJobs();

    expect(queue.add).toHaveBeenCalledWith(
      QUEUE_NAMES.scheduled,
      { scheduledJobId: "job-2" },
      expect.objectContaining({
        jobId: "job-2",
        delay: 0
      })
    );
    expect(recovered).toBe(1);
  });

  it("re-enqueues retryable due jobs when BullMQ already marked them completed", async () => {
    const queueJob = {
      getState: vi.fn().mockResolvedValue("completed"),
      promote: vi.fn().mockResolvedValue(undefined)
    };

    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(queueJob)
    };

    const prisma = {
      scheduledJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "job-3",
            jobType: "PROCESS_ACCESS_EXPIRY",
            runAt: new Date(Date.now() - 1000)
          }
        ])
      }
    };

    const service = new SchedulerService(prisma as any, {} as any, undefined, queue as any);
    const recovered = await service.recoverDueJobs();

    expect(queue.remove).toHaveBeenCalledWith("job-3");
    expect(queue.add).toHaveBeenCalledWith(
      QUEUE_NAMES.scheduled,
      { scheduledJobId: "job-3" },
      expect.objectContaining({
        jobId: "job-3",
        delay: 0
      })
    );
    expect(recovered).toBe(1);
  });
});
