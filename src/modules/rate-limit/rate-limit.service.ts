import type { Redis } from "ioredis";

export class RateLimitService {
  public constructor(
    private readonly redis: Redis,
    private readonly limit = 12,
    private readonly windowSeconds = 10
  ) {}

  public async consume(userId: string, scope: string): Promise<boolean> {
    const key = `ratelimit:${scope}:${userId}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, this.windowSeconds);
    }

    return current <= this.limit;
  }
}
