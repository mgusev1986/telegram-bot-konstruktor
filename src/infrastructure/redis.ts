import IORedis from "ioredis";
import type { ConnectionOptions } from "bullmq";

import { env } from "../config/env";

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});

const redisUrl = new URL(env.REDIS_URL);

export const bullConnection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: redisUrl.pathname ? Number(redisUrl.pathname.replace("/", "") || 0) : 0
};
