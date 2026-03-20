import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";

import { env } from "../config/env";
import { logger } from "../common/logger";
import type { AppServices } from "../app/services";

export const buildHttpServer = (services: AppServices, prisma: PrismaClient) => {
  const server = Fastify({
    logger: false
  });

  server.get("/health", async () => ({
    ok: true,
    timestamp: new Date().toISOString()
  }));

  server.post<{
    Body: {
      referenceCode: string;
      status: string;
      externalTxId?: string;
    };
  }>("/webhooks/payments/crypto", async (request, reply) => {
    // Payment confirmation should be executed by the global creator ALPHA_OWNER.
    const owner = await prisma.user.findFirst({
      where: {
        role: "ALPHA_OWNER"
      }
    });

    if (!owner) {
      reply.code(409);
      return { ok: false, error: "Owner user is not initialized yet" };
    }

    if (request.body.status !== "paid") {
      return { ok: true, skipped: true };
    }

    await services.payments.confirmPaymentByReference(
      request.body.referenceCode,
      owner.id,
      request.body.externalTxId
    );

    return { ok: true };
  });

  return {
    server,
    async start() {
      await server.listen({
        port: env.HTTP_PORT,
        host: "0.0.0.0"
      });
      logger.info({ port: env.HTTP_PORT }, "HTTP server started");
    }
  };
};
