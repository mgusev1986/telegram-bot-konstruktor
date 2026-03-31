import type { AudienceType, Broadcast, BroadcastStatus, MediaType, PrismaClient, User } from "@prisma/client";
import { Markup, type Telegram } from "telegraf";

import { toJsonValue } from "../../common/json";
import { buildInlineButtonsReplyMarkup, type MessageActionButton } from "../../common/message-buttons";
import { sendRichMessage } from "../../common/media";
import { renderPageContent } from "../../common/page-content-render";
import { makeCallbackData } from "../../common/callback-data";
import type { AuditService } from "../audit/audit.service";
import type { CabinetService } from "../cabinet/cabinet.service";
import type { I18nService } from "../i18n/i18n.service";
import type { SchedulerService } from "../jobs/scheduler.service";
import type { SegmentService } from "../segmentation/segment.service";
import { NAV_ROOT_DATA } from "../../bot/keyboards";
import { logger } from "../../common/logger";
import { isValidTimeZone } from "../../common/timezone";

export type BroadcastButton = MessageActionButton;

export interface BroadcastInput {
  actorUserId: string;
  audienceType: AudienceType;
  segmentQuery?: Record<string, unknown>;
  languageCode: string;
  /**
   * If provided, broadcast will create localizations for multiple languages
   * (typically when admin selects "Все языки").
   */
  languageCodes?: string[];
  text?: string;
  followUpText?: string;
  mediaType?: MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
  buttons?: BroadcastButton[];
  sendAt?: Date | null;
  skipScheduler?: boolean;
}

export interface BroadcastProgressStats {
  totalRecipients: number;
  processedCount: number;
  successCount: number;
  failedCount: number;
  pendingCount: number;
  status: BroadcastStatus;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface DispatchBroadcastOptions {
  /**
   * Called by the instant broadcast runner (scene). Must be throttled upstream.
   * Should be resilient to retries / edits.
   */
  onProgress?: (stats: BroadcastProgressStats) => void | Promise<void>;
  /**
   * Emit progress only every N processed recipients.
   * Defaults chosen to keep admin chat readable.
   */
  progressEmitEvery?: number;
  /** Minimal time between progress emissions. */
  progressEmitMinIntervalMs?: number;

  /**
   * If set, dispatch runs as a "scheduled batch" for a subset of users grouped by
   * their effective timezone (user.timeZone ?? fallbackTimeZone).
   */
  recipientTimeZone?: string | null;
  fallbackTimeZone?: string;
  batchMode?: boolean;
}

export interface ScheduledBroadcastEditInput {
  audienceType: AudienceType;
  segmentQuery?: Record<string, unknown>;
  languageCode: string;
  languageCodes?: string[];
  text?: string;
  followUpText?: string;
  mediaType?: MediaType;
  mediaFileId?: string | null;
  externalUrl?: string | null;
  buttons?: BroadcastButton[];
  sendAt: Date;
}

export class BroadcastService {
  private telegram: Telegram | null = null;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly segments: SegmentService,
    private readonly scheduler: SchedulerService,
    private readonly i18n: I18nService,
    private readonly audit: AuditService,
    private readonly botInstanceId?: string,
    private readonly cabinet?: CabinetService
  ) {}

  public setTelegram(telegram: Telegram): void {
    this.telegram = telegram;
  }

  public async createBroadcast(input: BroadcastInput): Promise<Broadcast> {
    const languageCodes = input.languageCodes && input.languageCodes.length > 0 ? input.languageCodes : [input.languageCode];

    const broadcast = await this.prisma.broadcast.create({
      data: {
        createdByUserId: input.actorUserId,
        botInstanceId: this.botInstanceId ?? undefined,
        audienceType: input.audienceType,
        segmentQuery: toJsonValue(input.segmentQuery ?? {}),
        status: input.sendAt ? "SCHEDULED" : "DRAFT",
        isScheduled: Boolean(input.sendAt),
        sendAt: input.sendAt ?? undefined,
        localizations: {
          create: languageCodes.map((code) => ({
            languageCode: code,
            text: input.text ?? "",
            followUpText: input.followUpText ?? "",
            mediaType: input.mediaType ?? "NONE",
            mediaFileId: input.mediaFileId ?? undefined,
            externalUrl: input.externalUrl ?? undefined,
            buttonsJson: input.buttons && input.buttons.length > 0 ? (input.buttons as object) : undefined
          }))
        }
      }
    });

    if (input.sendAt && !input.skipScheduler) {
      await this.scheduler.schedule(
        "SEND_BROADCAST",
        { broadcastId: broadcast.id },
        input.sendAt,
        `broadcast:${broadcast.id}`
      );
    }

    await this.audit.log(input.actorUserId, "create_broadcast", "broadcast", broadcast.id, {
      audienceType: input.audienceType,
      sendAt: input.sendAt?.toISOString() ?? null
    });

    return broadcast;
  }

  /**
   * List scheduled broadcasts for admin management.
   * Scoped to broadcast creator (createdByUserId).
   */
  public async listScheduledBroadcasts(actorUserId: string) {
    return this.prisma.broadcast.findMany({
      where: {
        createdByUserId: actorUserId,
        ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
        isScheduled: true,
        // Only broadcasts that are still waiting in queue (not already completed/cancelled).
        status: { in: ["SCHEDULED"] }
      },
      orderBy: { createdAt: "desc" },
      include: {
        localizations: { select: { languageCode: true } }
      }
    });
  }

  public async getScheduledBroadcastDetail(actorUserId: string, broadcastId: string) {
    return this.prisma.broadcast.findFirstOrThrow({
      where: { id: broadcastId, createdByUserId: actorUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      include: {
        localizations: { select: { languageCode: true } },
        createdByUser: { select: { id: true } }
      }
    });
  }

  public async stopScheduledBroadcast(actorUserId: string, broadcastId: string) {
    const existing = await this.prisma.broadcast.findFirstOrThrow({
      where: { id: broadcastId, createdByUserId: actorUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) }
    });

    if (existing.status === "CANCELLED") return existing;
    // Only queued scheduled broadcasts can be stopped predictably.
    if (existing.status !== "SCHEDULED") return existing;

    const finishedAt = new Date();
    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: "CANCELLED",
        finishedAt
      }
    });

    // Cancel all queued jobs for this broadcast.
    await this.scheduler.cancelByIdempotencyKeyPrefix(`broadcast:${broadcastId}`);

    return this.prisma.broadcast.findUniqueOrThrow({ where: { id: broadcastId } });
  }

  public async deleteScheduledBroadcast(actorUserId: string, broadcastId: string) {
    const existing = await this.prisma.broadcast.findFirstOrThrow({
      where: { id: broadcastId, createdByUserId: actorUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) }
    });

    // Cancel all queued jobs first, to prevent worker execution while deleting.
    await this.scheduler.cancelByIdempotencyKeyPrefix(`broadcast:${broadcastId}`);

    await this.prisma.broadcast.delete({
      where: { id: existing.id }
    });
  }

  /**
   * True-edit preparation for a scheduled broadcast:
   * - cancel queued jobs
   * - clear old recipient rows so the broadcast can be re-dispatched
   * - replace localizations/content
   * - temporarily mark broadcast as CANCELLED to stop in-flight/old jobs
   * The caller must re-activate it back to SCHEDULED after scheduling new jobs.
   */
  public async prepareScheduledBroadcastEdit(actorUserId: string, broadcastId: string, input: ScheduledBroadcastEditInput) {
    const broadcast = await this.prisma.broadcast.findFirstOrThrow({
      where: { id: broadcastId, createdByUserId: actorUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) }
    });

    // Don't allow editing completed/cancelled broadcasts.
    if (broadcast.status !== "SCHEDULED" && broadcast.status !== "RUNNING") {
      throw new Error(`Broadcast is not editable (status=${broadcast.status})`);
    }

    // 1) Freeze the broadcast so that any already-picked old jobs won't dispatch.
    const now = new Date();
    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: "CANCELLED",
        finishedAt: now,
        startedAt: null,
        sendAt: input.sendAt,
        audienceType: input.audienceType,
        segmentQuery: toJsonValue(input.segmentQuery ?? {}),
        isScheduled: true,
        totalRecipients: 0,
        processedCount: 0,
        successCount: 0,
        failedCount: 0,
        pendingCount: 0,
        // Keep updatedAt via normal update flow.
      }
    });

    // 2) Cancel all queued jobs for this broadcast (stop/cancel edit in progress).
    await this.scheduler.cancelByIdempotencyKeyPrefix(`broadcast:${broadcastId}`);

    // 3) Clear old recipient rows so dispatchBroadcast can re-create them.
    await this.prisma.broadcastRecipient.deleteMany({
      where: { broadcastId }
    });

    // 4) Replace localizations (language versions + content).
    await this.prisma.broadcastLocalization.deleteMany({ where: { broadcastId } });

    const languageCodes =
      input.languageCodes && input.languageCodes.length > 0 ? input.languageCodes : [input.languageCode];

    await this.prisma.broadcastLocalization.createMany({
      data: languageCodes.map((code) => ({
        broadcastId,
        languageCode: code,
        text: input.text ?? "",
        followUpText: input.followUpText ?? "",
        mediaType: input.mediaType ?? "NONE",
        mediaFileId: input.mediaFileId ?? undefined,
        externalUrl: input.externalUrl ?? undefined,
        buttonsJson: input.buttons && input.buttons.length > 0 ? (input.buttons as object) : undefined
      }))
    });
  }

  /**
   * Re-activate edited scheduled broadcast and mark it as queued.
   * Should be called after scheduling new BullMQ jobs.
   */
  public async markScheduledBroadcastRescheduled(actorUserId: string, broadcastId: string) {
    await this.prisma.broadcast.update({
      where: { id: broadcastId, createdByUserId: actorUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      data: {
        status: "SCHEDULED",
        startedAt: null,
        finishedAt: null
      }
    });
  }

  /**
   * Dispatch a scheduled broadcast immediately from admin UI.
   * - Cancels queued batch jobs so they won't fire later.
   * - Does not mark the broadcast as CANCELLED; it will become RUNNING/COMPLETED via dispatchBroadcast.
   */
  public async dispatchScheduledBroadcastNow(
    actorUserId: string,
    broadcastId: string,
    opts?: DispatchBroadcastOptions
  ): Promise<BroadcastProgressStats> {
    const broadcast = await this.prisma.broadcast.findFirstOrThrow({
      where: { id: broadcastId, createdByUserId: actorUserId, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) },
      select: { id: true, status: true }
    });

    if (broadcast.status !== "SCHEDULED") {
      throw new Error(`Broadcast is not in scheduled state (status=${broadcast.status})`);
    }

    await this.scheduler.cancelByIdempotencyKeyPrefix(`broadcast:${broadcastId}`);
    return this.dispatchBroadcast(broadcastId, opts);
  }

  public async dispatchBroadcast(
    broadcastId: string,
    opts?: DispatchBroadcastOptions
  ): Promise<BroadcastProgressStats> {
    const broadcast = await this.prisma.broadcast.findUniqueOrThrow({
      where: { id: broadcastId },
      include: {
        localizations: true,
        createdByUser: true
      }
    });

    if (this.botInstanceId && (broadcast as any).botInstanceId && (broadcast as any).botInstanceId !== this.botInstanceId) {
      throw new Error(`Broadcast botInstanceId mismatch (broadcast=${broadcastId})`);
    }

    if (broadcast.status === "CANCELLED") {
      logger.info({ broadcastId }, "dispatchBroadcast: skipped (broadcast cancelled)");
      return {
        totalRecipients: 0,
        processedCount: 0,
        successCount: 0,
        failedCount: 0,
        pendingCount: 0,
        status: "CANCELLED",
        startedAt: new Date()
      };
    }

    const recipientsAll = await this.segments.resolveAudience({
      audienceType: broadcast.audienceType,
      requesterUserId: broadcast.createdByUserId,
      segmentQuery: broadcast.segmentQuery as Record<string, unknown>
    });

    // Language restriction:
    // If broadcast has a single localization language, we treat it as "specific language"
    // and restrict recipients to those whose selectedLanguage matches it.
    // If broadcast has multiple localization languages (e.g. "Все языки"), we do not restrict.
    const localizationLanguages = Array.from(new Set(broadcast.localizations.map((l) => l.languageCode)));
    let filteredRecipients = recipientsAll;
    if (localizationLanguages.length === 1) {
      const onlyLang = localizationLanguages[0];
      filteredRecipients = recipientsAll.filter((u) => u.selectedLanguage === onlyLang);
    }

    // OWNER verification recipient:
    // when OWNER creates a broadcast, he must also receive the same message
    // as a normal recipient for instant preview/verification.
    // This must not duplicate if OWNER is already part of audience.
    const ownerUser = broadcast.createdByUser;
    const shouldInjectOwnerRecipient = ownerUser?.role === "OWNER" || ownerUser?.role === "ALPHA_OWNER";
    if (shouldInjectOwnerRecipient) {
      const alreadyInAudience = filteredRecipients.some((u) => u.id === ownerUser.id);
      if (!alreadyInAudience) filteredRecipients = [...filteredRecipients, ownerUser as any];
    }

    const isBatch = Boolean(opts?.batchMode || typeof opts?.recipientTimeZone !== "undefined");
    const fallbackTimeZone = opts?.fallbackTimeZone ?? "UTC";
    const totalRecipientsOverall = filteredRecipients.length;

    const hasRecipientTimeZone = opts?.recipientTimeZone != null;
    const recipients = hasRecipientTimeZone
      ? filteredRecipients.filter((u) => {
          const effective = u.timeZone && isValidTimeZone(u.timeZone) ? u.timeZone : fallbackTimeZone;
          return effective === opts.recipientTimeZone;
        })
      : filteredRecipients;

    const totalRecipients = recipients.length;
    if (isBatch) {
      logger.info(
        {
          broadcastId,
          audienceType: broadcast.audienceType,
          localizationLanguages: localizationLanguages,
          languageRestricted: localizationLanguages.length === 1,
          recipientTimeZone: opts?.recipientTimeZone ?? null,
          totalRecipientsOverall,
          totalRecipients,
          isBatch
        },
        "dispatchBroadcast: resolved recipients"
      );
    }
    const startedAt = new Date();
    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;

    // For instant/full dispatch we track progress in broadcast row (admin live UI).
    // For scheduled batch we skip progress-field writes and only finalize status when all recipients are done.
    const shouldTrackProgress = !isBatch;
    let finalStatus: BroadcastStatus = broadcast.status;

    if (shouldTrackProgress) {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: "RUNNING",
          startedAt,
          totalRecipients,
          processedCount: 0,
          successCount: 0,
          failedCount: 0,
          pendingCount: totalRecipients
        }
      });
    } else {
      // Keep broadcast in a meaningful lifecycle state.
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: "RUNNING",
          startedAt: broadcast.startedAt ?? startedAt
        }
      });
    }

    // Mentor username cache for recipient-side "Связь с наставником" URL buttons.
    // This prevents intermediate callback screens and allows direct chat opening.
    const mentorUserIds = Array.from(
      new Set(recipients.map((r) => r.mentorUserId).filter((id): id is string => typeof id === "string" && id.length > 0))
    );
    const mentorRows = mentorUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: mentorUserIds } },
          select: { id: true, username: true }
        })
      : [];
    const mentorUsernameById = new Map<string, string | null>(mentorRows.map((m) => [m.id, m.username]));

    const progressEmitEvery = Math.max(1, opts?.progressEmitEvery ?? 20);
    const progressEmitMinIntervalMs = Math.max(200, opts?.progressEmitMinIntervalMs ?? 1200);
    let lastEmitAt = 0;

    const emitProgress = async (force = false) => {
      const now = Date.now();
      const pendingCount = totalRecipients - processedCount;
      const stats: BroadcastProgressStats = {
        totalRecipients,
        processedCount,
        successCount,
        failedCount,
        pendingCount: Math.max(0, pendingCount),
        status: "RUNNING",
        startedAt
      };

      if (!force) {
        if (processedCount === 0) return;
        const shouldEvery = processedCount % progressEmitEvery === 0;
        const shouldTime = now - lastEmitAt >= progressEmitMinIntervalMs;
        if (!shouldEvery && !shouldTime) return;
      }

      if (force) {
        // even if processedCount is 0, initial progress should show total.
      }

      lastEmitAt = now;
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          processedCount,
          successCount,
          failedCount,
          pendingCount: Math.max(0, totalRecipients - processedCount)
        }
      });

      if (!shouldTrackProgress) return;
      if (opts?.onProgress) {
        try {
          await opts.onProgress(stats);
        } catch {
          // Progress UI must never fail the actual sending.
        }
      }
    };

    // Initial UI emit with totals (instant mode only).
    if (shouldTrackProgress) {
      await emitProgress(true);
    }

    for (const recipient of recipients) {
      const localization =
        this.i18n.pickLocalized(broadcast.localizations, recipient.selectedLanguage) ??
        broadcast.localizations[0];

      const customButtons = await buildInlineButtonsReplyMarkup(
        (localization as any)?.buttonsJson,
        recipient as User,
        this.prisma,
        this.cabinet
      );

      // Always attach recipient system buttons to broadcast messages (UX requirement).
      // If a broadcast has custom buttons configured, use them instead of the default fallback.
      // If mentor username exists, use URL deep link to open chat directly.
      const mentorUsername = recipient.mentorUserId ? mentorUsernameById.get(recipient.mentorUserId) ?? null : null;
      const mentorBtn = mentorUsername
        ? Markup.button.url(
            this.i18n.t(recipient.selectedLanguage, "mentor_contact"),
            `https://t.me/${mentorUsername}`
          )
        : Markup.button.callback(
            this.i18n.t(recipient.selectedLanguage, "mentor_contact"),
            makeCallbackData("mentor", "open")
          );

      const systemButtons = Markup.inlineKeyboard([
        [mentorBtn],
        [
          Markup.button.callback(
            this.i18n.t(recipient.selectedLanguage, "to_main_menu"),
            NAV_ROOT_DATA
          )
        ]
      ]);
      const replyMarkup = "reply_markup" in customButtons ? customButtons : systemButtons;

      const recipientRow = await this.prisma.broadcastRecipient.upsert({
        where: {
          broadcastId_userId: {
            broadcastId,
            userId: recipient.id
          }
        },
        update: {},
        create: {
          broadcastId,
          userId: recipient.id
        }
      });

      // Prevent duplicate delivery if a recipient was already processed by another batch/retry.
      // This also makes the system more resilient to scheduling-time edge cases.
      if (recipientRow?.status === "SENT") {
        processedCount += 1;
        successCount += 1;
        await emitProgress(false);
        continue;
      }
      if (recipientRow?.status === "FAILED") {
        processedCount += 1;
        failedCount += 1;
        await emitProgress(false);
        continue;
      }

      try {
        if (!this.telegram || !localization) {
          await this.prisma.broadcastRecipient.update({
            where: {
              broadcastId_userId: {
                broadcastId,
                userId: recipient.id
              }
            },
            data: {
              status: "FAILED",
              errorMessage: !this.telegram
                ? "Telegram is not configured"
                : "Broadcast localization not found"
            }
          });

          processedCount += 1;
          failedCount += 1;
          continue;
        }

        await sendRichMessage(
          this.telegram,
          recipient.telegramUserId,
          {
            text: renderPageContent(localization.text, recipient),
            followUpText: (localization as any).followUpText
              ? renderPageContent((localization as any).followUpText, recipient)
              : undefined,
            mediaType: localization.mediaType,
            mediaFileId: localization.mediaFileId,
            externalUrl: localization.externalUrl
          },
          replyMarkup
        );

        await this.prisma.broadcastRecipient.update({
          where: {
            broadcastId_userId: {
              broadcastId,
              userId: recipient.id
            }
          },
          data: {
            status: "SENT",
            sentAt: new Date()
          }
        });

        processedCount += 1;
        successCount += 1;
      } catch (error) {
        await this.prisma.broadcastRecipient.update({
          where: {
            broadcastId_userId: {
              broadcastId,
              userId: recipient.id
            }
          },
          data: {
            status: "FAILED",
            errorMessage: error instanceof Error ? error.message : "Unknown broadcast error"
          }
        });

        processedCount += 1;
        failedCount += 1;
      }

      await emitProgress(false);
    }

    const finishedAt = new Date();

    if (shouldTrackProgress) {
      const finalFailedOnly = totalRecipients > 0 && failedCount === totalRecipients;
      finalStatus = finalFailedOnly ? "FAILED" : "COMPLETED";

      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: finalStatus,
          finishedAt,
          processedCount,
          successCount,
          failedCount,
          pendingCount: 0
        }
      });

      // Final UI emit (force) for a consistent end-state.
      await opts?.onProgress?.({
        totalRecipients,
        processedCount,
        successCount,
        failedCount,
        pendingCount: 0,
        status: finalStatus,
        startedAt,
        finishedAt
      });
    } else {
      // Scheduled batch: finalize only when all audience recipients are processed
      // (missing broadcastRecipient rows are treated as "pending").
      const processedOverall = await this.prisma.broadcastRecipient.count({
        where: {
          broadcastId,
          status: { in: ["SENT", "FAILED"] }
        }
      });

      const pendingOverall = totalRecipientsOverall - processedOverall;
      if (pendingOverall <= 0) {
        const failedOverall = await this.prisma.broadcastRecipient.count({
          where: { broadcastId, status: "FAILED" }
        });

        finalStatus = failedOverall > 0 ? "FAILED" : "COMPLETED";
        await this.prisma.broadcast.update({
          where: { id: broadcastId },
          data: { status: finalStatus, finishedAt, pendingCount: 0 }
        });
      }
    }

    return {
      totalRecipients,
      processedCount,
      successCount,
      failedCount,
      pendingCount: 0,
      status: finalStatus,
      startedAt,
      finishedAt
    };
  }
}
