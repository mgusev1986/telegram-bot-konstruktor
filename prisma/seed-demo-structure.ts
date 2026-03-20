/**
 * Наполняет бота тестовой демо-структурой:
 * - главная с приветствием {name}
 * - разделы: О компании, О продукте (с подразделами Продукт 1–3), О пассивном доходе, О маркетинге
 * - тестовая drip-серия (3 сообщения, интервал 1 мин, триггер ON_REGISTRATION)
 *
 * Запуск: npx tsx prisma/seed-demo-structure.ts
 * Требуется: .env с DATABASE_URL и SUPER_ADMIN_TELEGRAM_ID (владелец бота).
 */

import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";

import { INACTIVITY_REMINDER_TEMPLATES_RU } from "../src/modules/inactivity-reminders/inactivity-reminder.templates";
import { encryptTelegramBotToken } from "../src/common/telegram-token-encryption";

loadEnv();

const prisma = new PrismaClient();

const DEMO_KEY_PREFIX = "demo_";

function generateReferralCode(): string {
  return "demo_" + Math.random().toString(36).slice(2, 12);
}

async function ensureDemoUser(telegramIdStr: string): Promise<{ id: string }> {
  const telegramId = BigInt(telegramIdStr);
  // In multi-bot mode, user uniqueness is scoped by botInstanceId.
  const telegramUsername = process.env.BOT_USERNAME;
  const telegramToken = process.env.BOT_TOKEN;
  if (!telegramUsername?.trim()) throw new Error("BOT_USERNAME is required for seed-demo-structure");
  if (!telegramToken?.trim()) throw new Error("BOT_TOKEN is required for seed-demo-structure");

  let botInstance = await prisma.botInstance.findFirst({
    where: { telegramBotUsername: telegramUsername },
    orderBy: { createdAt: "desc" }
  });
  if (!botInstance) {
    botInstance = await prisma.botInstance.create({
      data: {
        ownerBackofficeUserId: null,
        name: "Seed Bot",
        telegramBotTokenEncrypted: encryptTelegramBotToken(
          telegramToken,
          process.env.BOT_TOKEN_ENCRYPTION_KEY ?? "dev-insecure-change-me"
        ),
        telegramBotUsername: telegramUsername,
        status: "ACTIVE"
      }
    });
  }
  const botInstanceId = botInstance.id;
  let user = await prisma.user.findFirst({
    where: { telegramUserId: telegramId, botInstanceId }
  });
  if (user) {
    return { id: user.id };
  }
  let referralCode = generateReferralCode();
  while (await prisma.user.findUnique({ where: { referralCode } })) {
    referralCode = generateReferralCode();
  }
  user = await prisma.user.create({
    data: {
      telegramUserId: telegramId,
      botInstanceId: botInstanceId ?? undefined,
      firstName: "Demo",
      lastName: "Admin",
      fullName: "Demo Admin",
      referralCode,
      role: "OWNER",
      selectedLanguage: "ru"
    }
  });
  await prisma.adminPermission.upsert({
    where: { userId: user.id },
    update: { canEditMenu: true, canManageTemplates: true },
    create: {
      userId: user.id,
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
  return { id: user.id };
}

async function ensureTemplate(ownerId: string): Promise<{ id: string }> {
  // Seed v1: ensure we have a BotInstance for current BOT_TOKEN/BOT_USERNAME.
  const telegramToken = process.env.BOT_TOKEN;
  const telegramUsername = process.env.BOT_USERNAME;
  if (!telegramToken?.trim()) throw new Error("BOT_TOKEN is required for seed-demo-structure");
  if (!telegramUsername?.trim()) throw new Error("BOT_USERNAME is required for seed-demo-structure");

  const botInstance = await prisma.botInstance.findFirst({
    where: { telegramBotUsername: telegramUsername },
    orderBy: { createdAt: "desc" }
  });

  const createdBotInstance =
    botInstance ??
    (await prisma.botInstance.create({
      data: {
        ownerBackofficeUserId: null,
        name: "Seed Bot",
        telegramBotTokenEncrypted: encryptTelegramBotToken(
          telegramToken,
          process.env.BOT_TOKEN_ENCRYPTION_KEY ?? "dev-insecure-change-me"
        ),
        telegramBotUsername: telegramUsername,
        status: "ACTIVE"
      }
    }));

  const botInstanceId = createdBotInstance.id;

  let template = await prisma.presentationTemplate.findFirst({
    where: { isActive: true, botInstanceId }
  });
  if (template) {
    return { id: template.id };
  }
  template = await prisma.presentationTemplate.create({
    data: {
      title: "Demo Bot",
      ownerAdminId: ownerId,
      botInstanceId,
      baseLanguageCode: "ru"
    }
  });
  await prisma.presentationLocalization.createMany({
    data: [
      { templateId: template.id, languageCode: "ru", welcomeText: "" },
      { templateId: template.id, languageCode: "en", welcomeText: "" },
      { templateId: template.id, languageCode: "de", welcomeText: "" }
    ]
  });
  return { id: template.id };
}

async function setWelcome(templateId: string, welcomeText: string): Promise<void> {
  await prisma.presentationLocalization.upsert({
    where: {
      templateId_languageCode: { templateId, languageCode: "ru" }
    },
    update: { welcomeText },
    create: { templateId, languageCode: "ru", welcomeText }
  });
}

async function clearDemoMenuItems(templateId: string): Promise<void> {
  const toDelete = await prisma.menuItem.findMany({
    where: { templateId, key: { startsWith: DEMO_KEY_PREFIX } },
    select: { id: true }
  });
  if (toDelete.length > 0) {
    await prisma.menuItem.deleteMany({
      where: { id: { in: toDelete.map((x) => x.id) } }
    });
  }
}

async function createMenuItem(
  templateId: string,
  opts: {
    key: string;
    title: string;
    contentText: string;
    type: "TEXT" | "SUBMENU";
    parentId?: string | null;
    sortOrder: number;
  }
): Promise<string> {
  const item = await prisma.menuItem.create({
    data: {
      templateId,
      parentId: opts.parentId ?? null,
      key: opts.key,
      type: opts.type,
      sortOrder: opts.sortOrder,
      localizations: {
        create: {
          languageCode: "ru",
          title: opts.title,
          contentText: opts.contentText,
          mediaType: "NONE"
        }
      }
    }
  });
  return item.id;
}

async function main(): Promise<void> {
  const telegramId = process.env.SUPER_ADMIN_TELEGRAM_ID;
  if (!telegramId?.trim()) {
    console.error("SUPER_ADMIN_TELEGRAM_ID is required in .env");
    process.exit(1);
  }

  console.log("Ensuring demo user...");
  const { id: userId } = await ensureDemoUser(telegramId.trim());
  console.log("Ensuring template...");
  const { id: templateId } = await ensureTemplate(userId);

  const welcomeText =
    "Привет, {name}!\n\nЭто тестовый бот для проверки структуры, кнопок и логики переходов.\n\nВыберите раздел ниже.";
  console.log("Setting welcome...");
  await setWelcome(templateId, welcomeText);

  console.log("Clearing existing demo menu items (if any)...");
  await clearDemoMenuItems(templateId);

  console.log("Creating root sections...");
  const idAboutCompany = await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}about_company`,
    title: "О компании",
    contentText:
      "О компании\n\nЭто тестовый раздел «О компании».\n\nЗдесь может быть краткое описание компании: миссия, история, команда. Несколько абзацев демонстрационного текста для проверки отображения контента и навигации.\n\nПосле прочтения используйте кнопку «Назад» или «В главное меню».",
    type: "TEXT",
    sortOrder: 1
  });

  const idAboutProduct = await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}about_product`,
    title: "О продукте",
    contentText:
      "О продукте\n\nОбщее описание продуктовой линейки. Ниже — кнопки подразделов: Продукт 1, Продукт 2, Продукт 3.\n\nВыберите нужный подраздел или вернитесь назад.",
    type: "SUBMENU",
    sortOrder: 2
  });

  await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}passive_income`,
    title: "О пассивном доходе",
    contentText:
      "О пассивном доходе\n\nТестовый текст про партнёрскую модель и доход.\n\nПервый блок: как устроена модель вознаграждений и пассивный доход.\n\nВторой блок: условия и шаги для участия.\n\nТретий блок: примеры и сроки. Это демо-контент для проверки отображения.",
    type: "TEXT",
    sortOrder: 3
  });

  await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}marketing`,
    title: "О маркетинге",
    contentText:
      "О маркетинге\n\nТестовый раздел про маркетинг.\n\nПервый блок: что такое маркетинг в контексте продукта и как он помогает.\n\nВторой блок: каналы и инструменты.\n\nТретий блок: результаты и метрики. Демо-контент для проверки навигации и связности.",
    type: "TEXT",
    sortOrder: 4
  });

  console.log("Creating sub-sections under «О продукте»...");
  const idProduct1 = await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}product_1`,
    title: "Продукт 1",
    contentText:
      "Продукт 1\n\nОписание первого продукта. Здесь может быть текст, тестовое фото или видео (медиа добавляется через редактор бота).\n\nЭто подраздел раздела «О продукте». Кнопка «Назад» ведёт в «О продукте».",
    type: "TEXT",
    parentId: idAboutProduct,
    sortOrder: 1
  });
  const idProduct2 = await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}product_2`,
    title: "Продукт 2",
    contentText:
      "Продукт 2\n\nОписание второго продукта. Демо-контент для проверки подразделов и навигации.\n\n«Назад» — в раздел «О продукте», «В главное меню» — на главную страницу.",
    type: "TEXT",
    parentId: idAboutProduct,
    sortOrder: 2
  });
  const idProduct3 = await createMenuItem(templateId, {
    key: `${DEMO_KEY_PREFIX}product_3`,
    title: "Продукт 3",
    contentText:
      "Продукт 3\n\nОписание третьего продукта. Здесь можно добавить документ или файл через редактор страницы.\n\nПодраздел «О продукте». Проверьте, что «Назад» и «В главное меню» работают корректно.",
    type: "TEXT",
    parentId: idAboutProduct,
    sortOrder: 3
  });

  console.log("Seeding inactivity reminder templates...");
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

  console.log("Creating demo inactivity reminder rule for «О продукте»...");
  const softTemplate = INACTIVITY_REMINDER_TEMPLATES_RU.find((t) => t.key === "soft_4")!;
  const softTemplateRow = await prisma.reminderTemplate.findUnique({ where: { key: softTemplate.key } });
  if (softTemplateRow) {
    const existingRule = await prisma.inactivityReminderRule.findFirst({
      where: { triggerPageId: idAboutProduct, templateId: softTemplateRow.id }
    });
    const data = {
      templateId: softTemplateRow.id,
      targetMenuItemId: idProduct1,
      delayMinutes: 45,
      ctaLabel: softTemplateRow.defaultCtaLabel,
      ctaTargetType: "NEXT_PAGE" as const,
      isActive: true
    };
    if (existingRule) {
      await prisma.inactivityReminderRule.update({
        where: { id: existingRule.id },
        data
      });
    } else {
      await prisma.inactivityReminderRule.create({
        data: { ...data, triggerPageId: idAboutProduct }
      });
    }
  }

  console.log("Creating test drip campaign...");
  const existingDrip = await prisma.dripCampaign.findFirst({
    where: { title: "Тестовая серия", createdByUserId: userId }
  });
  if (existingDrip) {
    await prisma.dripStepLocalization.deleteMany({
      where: { dripStep: { campaignId: existingDrip.id } }
    });
    await prisma.dripStep.deleteMany({ where: { campaignId: existingDrip.id } });
    await prisma.dripCampaign.delete({ where: { id: existingDrip.id } });
  }

  const campaign = await prisma.dripCampaign.create({
    data: {
      title: "Тестовая серия",
      triggerType: "ON_REGISTRATION",
      createdByUserId: userId,
      steps: {
        create: [
          {
            stepOrder: 1,
            delayValue: 1,
            delayUnit: "MINUTES",
            localizations: {
              create: {
                languageCode: "ru",
                text:
                  "Тестовая серия 1/3\n\nДобро пожаловать! Это первое автоматическое сообщение."
              }
            }
          },
          {
            stepOrder: 2,
            delayValue: 1,
            delayUnit: "MINUTES",
            localizations: {
              create: {
                languageCode: "ru",
                text:
                  "Тестовая серия 2/3\n\nЭто второе автоматическое сообщение. Проверяем, что серия работает."
              }
            }
          },
          {
            stepOrder: 3,
            delayValue: 1,
            delayUnit: "MINUTES",
            localizations: {
              create: {
                languageCode: "ru",
                text:
                  "Тестовая серия 3/3\n\nЭто третье автоматическое сообщение. Если вы его получили — автосерия работает."
              }
            }
          }
        ]
      }
    }
  });

  console.log("Demo structure created.");
  console.log("  Template ID:", templateId);
  console.log("  Root sections: О компании, О продукте, О пассивном доходе, О маркетинге");
  console.log("  Sub-sections under «О продукте»: Продукт 1, Продукт 2, Продукт 3");
  console.log("  Drip campaign ID:", campaign.id, "(3 steps, 1 min apart, ON_REGISTRATION)");

  const { buildNavigationGraph, validateNavigationGraph } = await import(
    "../src/modules/menu/navigation-audit"
  );
  const menuItems = await prisma.menuItem.findMany({
    where: { templateId },
    select: { id: true, parentId: true, type: true, targetMenuItemId: true }
  });
  const auditItems = menuItems.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    type: row.type,
    targetMenuItemId: row.targetMenuItemId ?? undefined,
    isActive: true
  }));
  const graph = buildNavigationGraph(auditItems);
  const errors = validateNavigationGraph(graph, { requireRootContent: true });
  if (errors.length > 0) {
    console.warn("Navigation audit reported issues:", errors);
  } else {
    console.log("Navigation audit: OK (all links and hierarchy valid).");
  }
  console.log("Open the bot in Telegram and send /start to verify.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
