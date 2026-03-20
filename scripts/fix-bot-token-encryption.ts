/**
 * Re-encrypts the bot token for the bot matching BOT_USERNAME in .env.
 * Use when BOT_TOKEN_ENCRYPTION_KEY was changed and stored tokens can't be decrypted.
 *
 * Run: npx tsx scripts/fix-bot-token-encryption.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { encryptTelegramBotToken, hashTelegramBotToken } from "../src/common/telegram-token-encryption";

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const BOT_USERNAME = process.env.BOT_USERNAME?.trim();
const BOT_TOKEN_ENCRYPTION_KEY = process.env.BOT_TOKEN_ENCRYPTION_KEY || "dev-insecure-change-me";

if (!BOT_TOKEN || !BOT_USERNAME) {
  console.error("Set BOT_TOKEN and BOT_USERNAME in .env");
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const bot = await prisma.botInstance.findFirst({
    where: { telegramBotUsername: BOT_USERNAME },
    orderBy: { createdAt: "desc" }
  });

  if (!bot) {
    console.error(`Bot with username ${BOT_USERNAME} not found in DB.`);
    process.exit(1);
  }

  const encrypted = encryptTelegramBotToken(BOT_TOKEN, BOT_TOKEN_ENCRYPTION_KEY);
  const hash = hashTelegramBotToken(BOT_TOKEN);

  await prisma.botInstance.update({
    where: { id: bot.id },
    data: {
      telegramBotTokenEncrypted: encrypted,
      telegramBotTokenHash: hash,
      status: "ACTIVE"
    }
  });

  console.log(`✓ Token re-encrypted for ${BOT_USERNAME} (id: ${bot.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
