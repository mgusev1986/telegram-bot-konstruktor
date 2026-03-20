import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseEnv: Record<string, string> = {
  BOT_TOKEN: "bot-token",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BOT_TOKEN_ENCRYPTION_KEY: "secret-secret",
  SUPER_ADMIN_TELEGRAM_ID: "123456",
  BOT_USERNAME: "bot_username",
  BACKOFFICE_JWT_SECRET: "backoffice-secret",
  BACKOFFICE_COOKIE_NAME: "backoffice_session",
  DEFAULT_LANGUAGE: "ru",
  APP_TIMEZONE: "UTC",
  PAYMENT_PROVIDER_MODE: "crypto",
  HTTP_PORT: "3000",
  LOG_LEVEL: "info",
  AI_TRANSLATION_PROVIDER: "ollama",
  AI_TRANSLATION_MODEL: "qwen2.5:14b",
  OLLAMA_BASE_URL: "http://localhost:11434"
};

describe("BotRuntimeManager", () => {
  const originalEnv = { ...process.env };
  const mockPrisma = { botInstance: {} };
  const mockRedis = {};
  const mockBullConnection = {};

  beforeEach(() => {
    process.env = { ...originalEnv, ...baseEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("getRunningCount returns 0 initially", async () => {
    const { BotRuntimeManager } = await import("../src/bot/bot-runtime-manager");
    const manager = new BotRuntimeManager(mockPrisma as any, mockRedis as any, mockBullConnection as any);
    expect(manager.getRunningCount()).toBe(0);
  });

  it("getRuntime returns undefined for unknown bot", async () => {
    const { BotRuntimeManager } = await import("../src/bot/bot-runtime-manager");
    const manager = new BotRuntimeManager(mockPrisma as any, mockRedis as any, mockBullConnection as any);
    expect(manager.getRuntime("unknown-id")).toBeUndefined();
  });

  it("getAllRuntimes returns empty array initially", async () => {
    const { BotRuntimeManager } = await import("../src/bot/bot-runtime-manager");
    const manager = new BotRuntimeManager(mockPrisma as any, mockRedis as any, mockBullConnection as any);
    expect(manager.getAllRuntimes()).toEqual([]);
  });
});
