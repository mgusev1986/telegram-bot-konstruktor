import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { z } from "zod";

loadEnv();

function isRunningInsideContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

function normalizeDockerHostnameForHostRun(rawUrl: string, dockerHostname: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.hostname !== dockerHostname || isRunningInsideContainer()) {
    return rawUrl;
  }
  parsed.hostname = "127.0.0.1";
  return parsed.toString();
}

const envSchema = z.object({
  // Optional when running multi-bot from DB only (bots created via back-office).
  // Required for bootstrap when no active bots exist in DB.
  BOT_TOKEN: z.string().optional().default(""),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL"),
  // Used to encrypt Telegram bot tokens before storing them in DB.
  // IMPORTANT: In production set a unique high-entropy value.
  BOT_TOKEN_ENCRYPTION_KEY: z.string().min(1).default("dev-insecure-change-me"),
  SUPER_ADMIN_TELEGRAM_ID: z
    .string()
    .min(1, "SUPER_ADMIN_TELEGRAM_ID is required")
    .regex(/^\d+$/, "SUPER_ADMIN_TELEGRAM_ID must be numeric"),
  BOT_USERNAME: z.string().optional().default(""),
  // Back-office session signing (JWT-like token stored in httpOnly cookie).
  BACKOFFICE_JWT_SECRET: z.string().min(1).default("dev-backoffice-secret-change-me"),
  BACKOFFICE_COOKIE_NAME: z.string().min(1).default("backoffice_session"),
  // Optional initial admin for local dev.
  BACKOFFICE_ADMIN_EMAIL: z.string().email().optional(),
  BACKOFFICE_ADMIN_PASSWORD: z.string().min(6).optional(),
  /** Email of backoffice user with platform-wide ALPHA_OWNER access (global user directory, etc.). Optional. */
  BACKOFFICE_ALPHA_EMAIL: z.string().email().optional(),
  /**
   * If true, users who are not yet in the database must open the bot via a referral link
   * (?start=<telegramUserId>). Direct /start without valid payload is rejected (except super-admin and pending owner invite by username).
   */
  REQUIRE_REFERRAL_LINK_FOR_NEW_USERS: z.coerce.boolean().default(true),
  DEFAULT_LANGUAGE: z.string().min(2).default("ru"),
  APP_TIMEZONE: z.string().min(1).default("UTC"),
  PAYMENT_PROVIDER_MODE: z.enum(["crypto", "manual"]).default("crypto"),
  USDT_TRC20_WALLET: z.string().optional().default(""),
  USDT_BEP20_WALLET: z.string().optional().default(""),
  // NOWPayments (balance-based flow)
  NOWPAYMENTS_API_KEY: z.string().optional().default(""),
  NOWPAYMENTS_IPN_SECRET: z.string().optional().default(""),
  NOWPAYMENTS_BASE_URL: z.string().url().optional().default("https://api.nowpayments.io/v1"),
  /** Full URL for IPN callbacks, e.g. https://yourdomain.com/webhooks/payments/nowpayments. Empty = disabled. */
  NOWPAYMENTS_IPN_CALLBACK_URL: z.union([z.string().url(), z.literal("")]).optional().default(""),
  // NOWPayments v1 (payout, config defaults)
  /** Use Custody API for payouts (different auth/endpoints). Optional, default false. */
  NOWPAYMENTS_USE_CUSTODY: z.coerce.boolean().optional().default(false),
  /** Default pay currency for top-up, e.g. usdtbsc, usdttrc20. */
  NOWPAYMENTS_DEFAULT_PAY_CURRENCY: z.string().optional().default("usdtbsc"),
  /** Default settlement currency for payouts, e.g. usdttrc20. */
  NOWPAYMENTS_DEFAULT_SETTLEMENT_CURRENCY: z.string().optional().default("usdttrc20"),
  /** Payout fee policy: "deduct_from_payout" | "add_to_payout" | etc. For v1 used as hint. */
  NOWPAYMENTS_PAYOUT_FEE_POLICY: z.string().optional().default("deduct_from_payout"),
  /** Cron expression for daily payout job, e.g. "0 1 * * *" (1:00 daily). Empty = use payoutHourLocal. */
  NOWPAYMENTS_DAILY_PAYOUT_CRON: z.string().optional().default(""),
  /** Timezone for daily payout run, e.g. Europe/Madrid. */
  NOWPAYMENTS_DAILY_PAYOUT_TIMEZONE: z.string().optional().default("Europe/Madrid"),
  /** Account email for Mass Payouts API (Bearer auth). Required for owner payouts. */
  NOWPAYMENTS_EMAIL: z.union([z.string().email(), z.literal("")]).optional().default(""),
  /** Account password for Mass Payouts API. Required for owner payouts. */
  NOWPAYMENTS_PASSWORD: z.string().optional().default(""),
  /** Secret for triggering owner payout via HTTP (cron). If set, POST /webhooks/payments/owner-payout-trigger?secret=xxx triggers payout. */
  NOWPAYMENTS_PAYOUT_TRIGGER_SECRET: z.string().optional().default(""),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  // PORT используется Render, Docker и др. — приоритет над HTTP_PORT
  PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // New translation configuration (Cerebras integration).
  // Supported values for provider choice:
  // - ollama: local only
  // - cerebras: online only
  // - auto: use ollama if it passes healthcheck, otherwise use cerebras
  //
  // Backward compatibility:
  // - legacy AI_* vars are still supported below, but TRANSLATION_PROVIDER takes precedence when set.
  TRANSLATION_PROVIDER: z.enum(["ollama", "cerebras", "auto"]).optional(),
  TRANSLATION_FALLBACK_PROVIDER: z.enum(["ollama", "cerebras"]).optional(),
  TRANSLATION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  TRANSLATION_BATCH_SIZE: z.coerce.number().int().positive().optional(),
  TRANSLATION_OVERWRITE_DEFAULT: z.coerce.boolean().default(true),

  // Cerebras
  CEREBRAS_BASE_URL: z.string().url("CEREBRAS_BASE_URL must be a valid URL").optional().default("https://api.cerebras.ai/v1"),
  CEREBRAS_API_KEY: z.string().optional().default(""),
  CEREBRAS_MODEL: z.string().optional().default("llama3.1-8b"),

  // Ollama
  OLLAMA_MODEL: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url("OLLAMA_BASE_URL must be a valid URL").default("http://localhost:11434"),
  // Cloudflare (legacy workers_ai support, not required for this Cerebras task)
  CLOUDFLARE_ACCOUNT_ID: z.string().optional().default(""),
  CLOUDFLARE_AI_API_TOKEN: z.string().optional().default(""),
  CLOUDFLARE_AI_MODEL: z.string().optional().default(""),

  // Legacy AI_* translation config (kept for backward compatibility with existing tests/flows).
  AI_TRANSLATION_PROVIDER: z.enum(["ollama", "workers_ai", "cerebras"]).default("ollama"),
  AI_TRANSLATION_MODEL: z.string().min(1).default("qwen2.5:14b"),
  AI_TRANSLATION_FALLBACK_ENABLED: z.coerce.boolean().default(true),
  AI_TRANSLATION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_TRANSLATION_BATCH_SIZE: z.coerce.number().int().positive().default(1)
}).superRefine((data, ctx) => {
  const effectiveProvider = data.TRANSLATION_PROVIDER ?? data.AI_TRANSLATION_PROVIDER;

  if (effectiveProvider === "ollama") {
    if (!data.OLLAMA_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OLLAMA_BASE_URL"],
        message: "OLLAMA_BASE_URL is required when AI_TRANSLATION_PROVIDER=ollama"
      });
    }
  }

  if (effectiveProvider === "cerebras") {
    if (!data.CEREBRAS_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CEREBRAS_API_KEY"],
        message: "CEREBRAS_API_KEY is required when TRANSLATION_PROVIDER=cerebras"
      });
    }
  }

  if (data.AI_TRANSLATION_PROVIDER === "workers_ai" || effectiveProvider === "workers_ai") {
    if (data.AI_TRANSLATION_PROVIDER === "workers_ai" || effectiveProvider === "workers_ai") {
      if (!data.CLOUDFLARE_ACCOUNT_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CLOUDFLARE_ACCOUNT_ID"],
          message: "CLOUDFLARE_ACCOUNT_ID is required when AI_TRANSLATION_PROVIDER=workers_ai"
        });
      }
      if (!data.CLOUDFLARE_AI_API_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CLOUDFLARE_AI_API_TOKEN"],
          message: "CLOUDFLARE_AI_API_TOKEN is required when AI_TRANSLATION_PROVIDER=workers_ai"
        });
      }
      if (!data.CLOUDFLARE_AI_MODEL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CLOUDFLARE_AI_MODEL"],
          message: "CLOUDFLARE_AI_MODEL is required when AI_TRANSLATION_PROVIDER=workers_ai"
        });
      }
    }
  }

});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.errors
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Environment validation failed:\n${details}`);
}

const effectivePort = parsed.data.PORT ?? parsed.data.HTTP_PORT;
const normalizedDatabaseUrl = normalizeDockerHostnameForHostRun(parsed.data.DATABASE_URL, "postgres");
const normalizedRedisUrl = normalizeDockerHostnameForHostRun(parsed.data.REDIS_URL, "redis");

process.env.DATABASE_URL = normalizedDatabaseUrl;
process.env.REDIS_URL = normalizedRedisUrl;

export const env = {
  ...parsed.data,
  DATABASE_URL: normalizedDatabaseUrl,
  REDIS_URL: normalizedRedisUrl,
  HTTP_PORT: effectivePort,
  // Aliases for the new names. Prefer new TRANSLATION_* when provided.
  TRANSLATION_TIMEOUT_MS: parsed.data.TRANSLATION_TIMEOUT_MS ?? parsed.data.AI_TRANSLATION_TIMEOUT_MS,
  TRANSLATION_BATCH_SIZE: parsed.data.TRANSLATION_BATCH_SIZE ?? parsed.data.AI_TRANSLATION_BATCH_SIZE,
  OLLAMA_MODEL: parsed.data.OLLAMA_MODEL ?? parsed.data.AI_TRANSLATION_MODEL,
  SUPER_ADMIN_TELEGRAM_ID: BigInt(parsed.data.SUPER_ADMIN_TELEGRAM_ID)
};

export type AppEnv = typeof env;
