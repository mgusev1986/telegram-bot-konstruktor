import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const baseEnv: Record<string, string> = {
  BOT_TOKEN: "bot-token",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/db?schema=public",
  REDIS_URL: "redis://localhost:6379",
  BOT_TOKEN_ENCRYPTION_KEY: "secret-secret",
  SUPER_ADMIN_TELEGRAM_ID: "123456",
  BOT_USERNAME: "bot_username",
  BACKOFFICE_JWT_SECRET: "backoffice-secret",
  BACKOFFICE_COOKIE_NAME: "backoffice_session",
  DEFAULT_LANGUAGE: "ru",
  APP_TIMEZONE: "UTC",
  PAYMENT_PROVIDER_MODE: "crypto",
  USDT_TRC20_WALLET: "",
  USDT_BEP20_WALLET: "",
  HTTP_PORT: "3000",
  LOG_LEVEL: "info",
  AI_TRANSLATION_PROVIDER: "ollama",
  AI_TRANSLATION_MODEL: "qwen2.5:14b",
  OLLAMA_BASE_URL: "http://localhost:11434",
  CLOUDFLARE_ACCOUNT_ID: "",
  CLOUDFLARE_AI_API_TOKEN: "",
  CLOUDFLARE_AI_MODEL: ""
};

describe("SUPER_ADMIN_TELEGRAM_ID -> ALPHA_OWNER mapping", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...baseEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("creates ALPHA_OWNER role for new super-admin user", async () => {
    const { UserService } = await import("../src/modules/users/user.service");

    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }: any) => ({
          id: "u1",
          telegramUserId: data.telegramUserId,
          selectedLanguage: data.selectedLanguage,
          role: data.role
        })),
        update: vi.fn()
      },
      adminPermission: {
        upsert: vi.fn().mockResolvedValue({})
      }
    } as any;

    const service = new UserService(prisma);

    await service.ensureTelegramUser(
      {
        id: baseEnv.SUPER_ADMIN_TELEGRAM_ID,
        first_name: "Super",
        last_name: "Admin",
        username: "super",
        language_code: "ru"
      } as any,
      null
    );

    const createCall = prisma.user.create.mock.calls[0]?.[0];
    expect(createCall?.data.role).toBe("ALPHA_OWNER");
    expect(prisma.adminPermission.upsert).toHaveBeenCalled();
  });

  it("upgrades existing OWNER row to ALPHA_OWNER for super-admin", async () => {
    const { UserService } = await import("../src/modules/users/user.service");

    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: "u1",
          role: "OWNER",
          invitedByUserId: null,
          mentorUserId: null
        }),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({
          id: "u1",
          role: "ALPHA_OWNER"
        })
      },
      adminPermission: {
        upsert: vi.fn().mockResolvedValue({})
      }
    } as any;

    const service = new UserService(prisma);

    await service.ensureTelegramUser(
      {
        id: baseEnv.SUPER_ADMIN_TELEGRAM_ID,
        first_name: "Super",
        last_name: "Admin",
        username: "super",
        language_code: "ru"
      } as any,
      null
    );

    const updateCall = prisma.user.update.mock.calls[0]?.[0];
    expect(updateCall?.data.role).toBe("ALPHA_OWNER");
    expect(prisma.adminPermission.upsert).toHaveBeenCalled();
  });
});

