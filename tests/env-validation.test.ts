import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseEnv = {
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
  HTTP_PORT: "3000",
  LOG_LEVEL: "info"
};

describe("env validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("fails for workers_ai without cloudflare variables", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      AI_TRANSLATION_PROVIDER: "workers_ai",
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_AI_API_TOKEN: "",
      CLOUDFLARE_AI_MODEL: ""
    };

    await expect(import("../src/config/env")).rejects.toThrow("Environment validation failed");
  });

  it("passes for ollama setup", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      AI_TRANSLATION_PROVIDER: "ollama",
      AI_TRANSLATION_MODEL: "qwen2.5:14b",
      OLLAMA_BASE_URL: "http://localhost:11434"
    };

    const mod = await import("../src/config/env");
    expect(mod.env.AI_TRANSLATION_PROVIDER).toBe("ollama");
  });

  it("maps docker postgres and redis hosts to localhost on host machine", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/db?schema=public",
      REDIS_URL: "redis://redis:6379"
    };

    const mod = await import("../src/config/env");
    expect(mod.env.DATABASE_URL).toBe("postgresql://postgres:postgres@127.0.0.1:5432/db?schema=public");
    expect(mod.env.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("keeps docker hostnames inside container runtime", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/db?schema=public",
      REDIS_URL: "redis://redis:6379"
    };

    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((path: string) => path === "/.dockerenv")
    }));

    const mod = await import("../src/config/env");
    expect(mod.env.DATABASE_URL).toBe("postgresql://postgres:postgres@postgres:5432/db?schema=public");
    expect(mod.env.REDIS_URL).toBe("redis://redis:6379");
  });

  it("fails for cerebras without CEREBRAS_API_KEY", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      AI_TRANSLATION_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: ""
    };

    await expect(import("../src/config/env")).rejects.toThrow("Environment validation failed");
  });

  it("fails for TRANSLATION_PROVIDER=cerebras without CEREBRAS_API_KEY", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      TRANSLATION_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: ""
    };

    await expect(import("../src/config/env")).rejects.toThrow("Environment validation failed");
  });

  it("passes for TRANSLATION_PROVIDER=auto without CEREBRAS_API_KEY", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      TRANSLATION_PROVIDER: "auto",
      CEREBRAS_API_KEY: ""
    };

    const mod = await import("../src/config/env");
    expect(mod.env.TRANSLATION_PROVIDER).toBe("auto");
  });

  it("passes for cerebras with CEREBRAS_API_KEY", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      AI_TRANSLATION_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "sk-test-key",
      CEREBRAS_MODEL: "llama3.1-8b"
    };

    const mod = await import("../src/config/env");
    expect(mod.env.AI_TRANSLATION_PROVIDER).toBe("cerebras");
    expect(mod.env.CEREBRAS_API_KEY).toBe("sk-test-key");
  });

  it("passes without BOT_TOKEN and BOT_USERNAME (multi-bot from DB mode)", async () => {
    process.env = {
      ...process.env,
      ...baseEnv,
      BOT_TOKEN: "",
      BOT_USERNAME: "",
      AI_TRANSLATION_PROVIDER: "ollama",
      AI_TRANSLATION_MODEL: "qwen2.5:14b",
      OLLAMA_BASE_URL: "http://localhost:11434"
    };

    const mod = await import("../src/config/env");
    expect(mod.env.BOT_TOKEN).toBe("");
    expect(mod.env.BOT_USERNAME).toBe("");
  });
});
