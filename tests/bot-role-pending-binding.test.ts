import { describe, expect, it, vi, beforeEach } from "vitest";

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

describe("Pending bot role assignments -> binding on first Telegram appearance", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...baseEnv };
  });

  it("binds PENDING(ADMIN) -> creates user with ADMIN and activates assignment", async () => {
    const audit = { log: vi.fn() } as any;

    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "u1" })
      },
      adminPermission: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({})
      },
      botRoleAssignment: {
        findFirst: vi.fn().mockResolvedValue({ id: "ra1", role: "ADMIN", status: "PENDING" }),
        update: vi.fn().mockResolvedValue({})
      }
    } as any;

    const { UserService } = await import("../src/modules/users/user.service");
    const service = new UserService(prisma, "bot1", audit);

    const { user } = await service.ensureTelegramUser(
      {
        id: "999",
        first_name: "Test",
        last_name: "User",
        username: "Test_User"
      } as any,
      null
    );

    expect(user.id).toBe("u1");
    const createCall = prisma.user.create.mock.calls[0]?.[0];
    // Bot-scoped roles must NOT be stored in User.role (scope separation).
    expect(createCall?.data.role).toBe("USER");

    expect(prisma.adminPermission.upsert).not.toHaveBeenCalled();
    expect(prisma.adminPermission.deleteMany).toHaveBeenCalled();
    expect(prisma.botRoleAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ra1" }
      })
    );
    expect(audit.log).toHaveBeenCalledWith(
      "u1",
      "bot_role_assignment_linked",
      "bot_role_assignment",
      "ra1",
      expect.anything()
    );
  });

  it("binds PENDING(OWNER) -> activates assignment (User.role stays USER)", async () => {
    const audit = { log: vi.fn() } as any;
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: "u1", role: "USER", invitedByUserId: null, mentorUserId: null }),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({ id: "u1" })
      },
      adminPermission: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({})
      },
      botRoleAssignment: {
        findFirst: vi.fn().mockResolvedValue({ id: "ra1", role: "OWNER", status: "PENDING" }),
        update: vi.fn().mockResolvedValue({})
      }
    } as any;

    const { UserService } = await import("../src/modules/users/user.service");
    const service = new UserService(prisma, "bot1", audit);

    await service.ensureTelegramUser(
      {
        id: "999",
        first_name: "Test",
        last_name: "User",
        username: "owner_user"
      } as any,
      null
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1" }
      })
    );
    expect(prisma.adminPermission.deleteMany).toHaveBeenCalled();
    expect(prisma.botRoleAssignment.update).toHaveBeenCalled();
  });

  it("does not bind pending for SUPER_ADMIN -> keeps ALPHA_OWNER and keeps assignment pending", async () => {
    const audit = { log: vi.fn() } as any;

    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "u1" })
      },
      adminPermission: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({})
      },
      botRoleAssignment: {
        findFirst: vi.fn().mockResolvedValue({ id: "ra1", role: "ADMIN", status: "PENDING" }),
        update: vi.fn().mockResolvedValue({})
      }
    } as any;

    const { UserService } = await import("../src/modules/users/user.service");
    const service = new UserService(prisma, "bot1", audit);

    await service.ensureTelegramUser(
      {
        id: "123456",
        first_name: "Super",
        last_name: "Admin",
        username: "super_admin"
      } as any,
      null
    );

    const createCall = prisma.user.create.mock.calls[0]?.[0];
    expect(createCall?.data.role).toBe("ALPHA_OWNER");
    expect(prisma.botRoleAssignment.update).not.toHaveBeenCalled();
  });
});

