import { env } from "./config/env";
import { logger } from "./common/logger";
import { prisma } from "./infrastructure/prisma";
import { bullConnection, redis } from "./infrastructure/redis";
import { createHealthServer, startHttpServer, addPaymentWebhookRoute } from "./http/server";
import type { AppServices } from "./app/services";
import { startWorkers } from "./modules/jobs/workers";
import { encryptTelegramBotToken, hashTelegramBotToken } from "./common/telegram-token-encryption";
import { randomBytes } from "node:crypto";
import { BotRuntimeManager } from "./bot/bot-runtime-manager";
import { registerBackofficeRoutes } from "./http/backoffice/register-backoffice";
import { INACTIVITY_REMINDER_TEMPLATES_RU } from "./modules/inactivity-reminders/inactivity-reminder.templates";

const bootstrap = async (): Promise<void> => {
  // Preflight: without the DB enum value, Prisma will throw when we assign role = "ALPHA_OWNER",
  // which can make the whole bot appear "not starting".
  const assertUserRoleEnumHasAlphaOwner = async (): Promise<void> => {
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_enum
        JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
        WHERE pg_type.typname = 'UserRole' AND pg_enum.enumlabel = 'ALPHA_OWNER'
      ) AS "exists"
    `;
    const exists = Boolean(rows?.[0]?.exists);
    if (!exists) {
      throw new Error(
        "В PostgreSQL отсутствует значение enum 'UserRole.ALPHA_OWNER'. " +
          "Примените миграцию: npx prisma migrate dev (или migrate deploy в проде) " +
          "перед запуском бота."
      );
    }
  };

  // Foundation v1: ensure at least one BotInstance exists in DB,
  // so MenuService can resolve templates in a bot-scoped manner.
  const ensureSuperAdminUser = async () => {
    const telegramUserId = env.SUPER_ADMIN_TELEGRAM_ID;
    const existing = await prisma.user.findFirst({
      where: { telegramUserId }
    });
    if (existing) {
      await prisma.adminPermission.upsert({
        where: { userId: existing.id },
        update: {
          canEditMenu: true,
          canSendBroadcasts: true,
          canScheduleMessages: true,
          canManageLanguages: true,
          canManagePayments: true,
          canManageSegments: true,
          canViewGlobalStats: true,
          canManageTemplates: true
        },
        create: {
          userId: existing.id,
          canEditMenu: true,
          canSendBroadcasts: true,
          canScheduleMessages: true,
          canManageLanguages: true,
          canManagePayments: true,
          canManageSegments: true,
          canViewGlobalStats: true,
          canManageTemplates: true
        }
      });

      if (existing.role !== "ALPHA_OWNER") {
        await prisma.user.update({
          where: { id: existing.id },
          data: { role: "ALPHA_OWNER" }
        });
      }

      return existing;
    }

    const createReferralCode = (): string => randomBytes(5).toString("hex");
    let referralCode = createReferralCode();
    while (await prisma.user.findUnique({ where: { referralCode } })) {
      referralCode = createReferralCode();
    }

    const created = await prisma.user.create({
      data: {
        telegramUserId,
        username: undefined,
        firstName: "Super",
        lastName: "Admin",
        fullName: "Super Admin",
        selectedLanguage: env.DEFAULT_LANGUAGE,
        role: "ALPHA_OWNER",
        referralCode
      }
    });

    await prisma.adminPermission.create({
      data: {
        userId: created.id,
        canEditMenu: true,
        canSendBroadcasts: true,
        canScheduleMessages: true,
        canManageLanguages: true,
        canManagePayments: true,
        canManageSegments: true,
        canViewGlobalStats: true,
        canManageTemplates: true
      }
    });

    return created;
  };

  await assertUserRoleEnumHasAlphaOwner();

  const httpServer = createHealthServer();

  // Payment webhook uses lazy getter so it can be registered before bots start.
  // Returns 503 until services are ready.
  let servicesRef: AppServices | null = null;
  addPaymentWebhookRoute(httpServer, () => servicesRef, prisma);

  const hasEnvBot = Boolean(env.BOT_TOKEN?.trim() && env.BOT_USERNAME?.trim());

  const ensureDefaultBotInstanceAndTemplate = async (): Promise<{ id: string }> => {
    const ownerUser = await ensureSuperAdminUser();

    if (hasEnvBot) {
      const tokenHash = hashTelegramBotToken(env.BOT_TOKEN!);
      // Ищем по token hash (уникальный), а не по username — BOT_USERNAME может отличаться (с/без @)
      const existingBot = await prisma.botInstance.findFirst({
        where: { telegramBotTokenHash: tokenHash },
        orderBy: { createdAt: "desc" }
      });

      let botInstance = existingBot;
      if (!botInstance) {
        try {
          botInstance = await prisma.botInstance.upsert({
            where: { telegramBotTokenHash: tokenHash },
            update: {
              telegramBotUsername: env.BOT_USERNAME,
              status: "ACTIVE",
              telegramBotTokenEncrypted: encryptTelegramBotToken(env.BOT_TOKEN!, env.BOT_TOKEN_ENCRYPTION_KEY)
            },
            create: {
              ownerBackofficeUserId: null,
              name: "Default Bot",
              telegramBotTokenEncrypted: encryptTelegramBotToken(env.BOT_TOKEN!, env.BOT_TOKEN_ENCRYPTION_KEY),
              telegramBotTokenHash: tokenHash,
              telegramBotUsername: env.BOT_USERNAME,
              status: "ACTIVE"
            }
          });
        } catch (err: unknown) {
          if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
            const retry = await prisma.botInstance.findFirst({
              where: { telegramBotTokenHash: tokenHash },
              orderBy: { createdAt: "desc" }
            });
            if (retry) botInstance = retry;
            else throw err;
          } else {
            throw err;
          }
        }
      }

      const template = await prisma.presentationTemplate.findFirst({
        where: { botInstanceId: botInstance.id, isActive: true }
      });

      if (!template) {
        const createdTemplate = await prisma.presentationTemplate.create({
          data: {
            title: "Default MLM Presentation",
            ownerAdminId: ownerUser.id,
            botInstanceId: botInstance.id,
            baseLanguageCode: env.DEFAULT_LANGUAGE
          }
        });

        await prisma.presentationLocalization.createMany({
          data: [
            { templateId: createdTemplate.id, languageCode: "ru", welcomeText: "Добро пожаловать, {{first_name}}! Выберите нужный раздел ниже." },
            { templateId: createdTemplate.id, languageCode: "en", welcomeText: "Welcome, {{first_name}}! Choose a section below." },
            { templateId: createdTemplate.id, languageCode: "de", welcomeText: "Willkommen, {{first_name}}! Wählen Sie unten einen Abschnitt." },
            { templateId: createdTemplate.id, languageCode: "uk", welcomeText: "Ласкаво просимо, {{first_name}}! Оберіть потрібний розділ нижче." }
          ]
        });
      }

      return botInstance;
    }

    const firstActive = await prisma.botInstance.findFirst({
      where: { status: "ACTIVE", isArchived: false },
      orderBy: { createdAt: "asc" }
    });

    if (!firstActive) {
      throw new Error(
        "No bot in DB. Either set BOT_TOKEN and BOT_USERNAME in .env, or create a bot via back-office first."
      );
    }

    return firstActive;
  };

  const botInstance = await ensureDefaultBotInstanceAndTemplate();

  // Ensure default inactivity reminder templates exist.
  // Without this, admin template categories show empty state even when code contains templates.
  const ensureInactivityReminderTemplates = async () => {
    logger.info("Syncing inactivity reminder templates (default)");
    for (const tpl of INACTIVITY_REMINDER_TEMPLATES_RU) {
      await prisma.reminderTemplate.upsert({
        where: { key: tpl.key },
        update: {
          category: tpl.category as any,
          title: tpl.title,
          text: tpl.text,
          defaultCtaLabel: tpl.defaultCtaLabel,
          sortOrder: tpl.sortOrder,
          languageCode: tpl.languageCode,
          isActive: tpl.isActive
        },
        create: {
          key: tpl.key,
          category: tpl.category as any,
          title: tpl.title,
          text: tpl.text,
          defaultCtaLabel: tpl.defaultCtaLabel,
          sortOrder: tpl.sortOrder,
          languageCode: tpl.languageCode,
          isActive: tpl.isActive
        }
      });
    }
  };

  await ensureInactivityReminderTemplates();
  // Backfill: consolidate data to the current default bot instance.
  // 1) Rows with botInstanceId=null (legacy single-bot).
  // 2) Rows with botInstanceId pointing to another BotInstance with same telegramBotUsername
  //    (e.g. duplicate instances or "primary" changed after deploy) — migrate to current.
  const sameUsernameBotIds =
    env.BOT_USERNAME?.trim()
      ? (await prisma.botInstance.findMany({
          where: { telegramBotUsername: env.BOT_USERNAME },
          select: { id: true }
        }))
      : [];
  const otherBotIds = sameUsernameBotIds.map((b) => b.id).filter((id) => id !== botInstance.id);
  const migrateWhere =
    otherBotIds.length > 0
      ? ({ OR: [{ botInstanceId: null }, { botInstanceId: { in: otherBotIds } }] } as const)
      : ({ botInstanceId: null } as const);

  const existingTelegramIds = await prisma.user.findMany({
    where: { botInstanceId: botInstance.id },
    select: { telegramUserId: true }
  });
  const legacyToUpdate = await prisma.user.findMany({
    where: {
      ...(migrateWhere as object),
      ...(existingTelegramIds.length > 0
        ? { NOT: { telegramUserId: { in: existingTelegramIds.map((u) => u.telegramUserId) } } }
        : {})
    } as any,
    select: { id: true }
  });
  if (legacyToUpdate.length > 0) {
    await prisma.user.updateMany({
      where: { id: { in: legacyToUpdate.map((u) => u.id) } },
      data: { botInstanceId: botInstance.id }
    });
  }
  const dripUpdated = await prisma.dripCampaign.updateMany({
    where: migrateWhere as any,
    data: { botInstanceId: botInstance.id }
  });
  if (dripUpdated.count > 0) {
    logger.info({ count: dripUpdated.count }, "Backfill: migrated drip campaigns to current bot instance");
  }
  await prisma.broadcast.updateMany({
    where: migrateWhere as any,
    data: { botInstanceId: botInstance.id }
  });
  await prisma.userDripProgress.updateMany({
    where: migrateWhere as any,
    data: { botInstanceId: botInstance.id }
  });
  await prisma.payment.updateMany({
    where: migrateWhere as any,
    data: { botInstanceId: botInstance.id }
  });
  await prisma.contentProgress.updateMany({
    where: migrateWhere as any,
    data: { botInstanceId: botInstance.id }
  });
  const runtimeManager = new BotRuntimeManager(prisma, redis, bullConnection);

  await registerBackofficeRoutes(httpServer, prisma, runtimeManager);
  logger.info("Backoffice routes registered");

  await startHttpServer(httpServer);

  // Load all active, non-archived bots and start each in parallel (no blocking between bots).
  const activeBots = await prisma.botInstance.findMany({
    where: { status: "ACTIVE", isArchived: false },
    orderBy: { createdAt: "asc" }
  });
  logger.info({ count: activeBots.length, ids: activeBots.map((b) => b.id) }, "Starting active bots");

  let primaryRuntime: Awaited<ReturnType<BotRuntimeManager["startBotInstance"]>> | null = null;
  const totalBots = activeBots.length;
  const launchedBotIds: string[] = [];

  const results = await Promise.allSettled(
    activeBots.map((bot, idx) => {
      logger.info(
        { botInstanceId: bot.id, username: bot.telegramBotUsername, index: idx + 1, total: totalBots },
        "Starting bot X/Y..."
      );
      return runtimeManager
        .startBotInstance(bot.id, { launch: true })
        .then((rt) => ({ status: "fulfilled" as const, rt, bot }));
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const bot = activeBots[i]!;
    const fulfilled = result.status === "fulfilled" && result.value.status === "fulfilled";
    if (fulfilled) {
      if (!primaryRuntime) primaryRuntime = result.value.rt;
      launchedBotIds.push(bot.id);
      logger.info(
        { botInstanceId: bot.id, username: bot.telegramBotUsername },
        "Bot started successfully"
      );
    } else {
      const msg =
        result.status === "rejected"
          ? (() => {
              const e = result.reason;
              return e instanceof Error ? e.message : String(e);
            })()
          : "Unknown";
      logger.error(
        { botInstanceId: bot.id, username: bot.telegramBotUsername, error: msg },
        "Failed to start bot instance (continuing with others)"
      );
    }
  }

  if (!primaryRuntime || runtimeManager.getRunningCount() === 0) {
    // Keep backoffice/admin available even if Telegram polling fails.
    // This allows fixing bot token/settings from UI instead of hard crash on bootstrap.
    const fallbackBot = activeBots[0];
    if (!fallbackBot) {
      throw new Error("No ACTIVE bot instance found.");
    }
    primaryRuntime = await runtimeManager.startBotInstance(fallbackBot.id, { launch: false });
    logger.warn(
      { botInstanceId: fallbackBot.id, username: fallbackBot.telegramBotUsername },
      "Started fallback bot runtime without Telegram launch; backoffice remains available"
    );
  }

  servicesRef = primaryRuntime.services;

  await servicesRef.payments.ensureDemoProducts();
  await servicesRef.scheduler.recoverPendingJobs();
  await servicesRef.scheduler.recoverDueJobs();

  const worker = startWorkers({
    prisma,
    connection: bullConnection,
    scheduler: servicesRef.scheduler,
    runtimeManager
  });

  const dueJobsRecoveryTimer = setInterval(() => {
    void servicesRef?.scheduler.recoverDueJobs().catch((error) => {
      logger.warn({ err: error }, "Failed to recover due scheduled jobs");
    });
  }, 5000);

  logger.info(
    {
      runningBots: launchedBotIds.length,
      botUsernames: activeBots
        .filter((b) => launchedBotIds.includes(b.id))
        .map((b) => b.telegramBotUsername ?? b.id),
      port: env.HTTP_PORT
    },
    "Telegram bot platform started (multi-bot runtime)"
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    clearInterval(dueJobsRecoveryTimer);
    await runtimeManager.stopAll(signal);
    await worker.close();
    await httpServer.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
};

void bootstrap().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  logger.fatal({ error, errorMessage, errorStack }, "Application bootstrap failed");
  await prisma.$disconnect().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
