import { PrismaClient } from "@prisma/client";

import { logger } from "../common/logger";

export const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "production"
      ? ["error", "warn"]
      : [
          { level: "query", emit: "event" },
          { level: "error", emit: "stdout" },
          { level: "warn", emit: "stdout" }
        ]
});

if (process.env.NODE_ENV !== "production") {
  prisma.$on("query", (event) => {
    logger.debug({ query: event.query, params: event.params, duration: event.duration }, "Prisma query");
  });
}
