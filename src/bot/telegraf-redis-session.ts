import type IORedis from "ioredis";

/** TTL for Telegram chat session blobs (nav + wizard state). */
const SESSION_TTL_SEC = 60 * 60 * 24 * 14;

/**
 * Telegraf default session is in-memory only; it is lost on restart and is fragile under load.
 * Redis store persists wizard/scene state (e.g. drip “add buttons” flow) per bot instance.
 */
export function createRedisSessionStore(redis: IORedis, keyPrefix: string) {
  const prefix = keyPrefix.endsWith(":") ? keyPrefix : `${keyPrefix}:`;

  return {
    async get(name: string): Promise<Record<string, unknown> | undefined> {
      const raw = await redis.get(prefix + name);
      if (raw == null) return undefined;
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    },
    async set(name: string, value: Record<string, unknown>): Promise<void> {
      await redis.set(prefix + name, JSON.stringify(value), "EX", SESSION_TTL_SEC);
    },
    async delete(name: string): Promise<void> {
      await redis.del(prefix + name);
    }
  };
}
