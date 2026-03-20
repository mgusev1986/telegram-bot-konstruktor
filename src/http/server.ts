import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { env } from "../config/env";
import { logger } from "../common/logger";
import type { AppServices } from "../app/services";

/**
 * Creates HTTP server with /health route. Does NOT call listen() — all routes
 * (backoffice, webhooks) must be registered before listen() to avoid Fastify
 * "Root plugin has already booted" error.
 */
export function createHealthServer(): FastifyInstance {
  const server = Fastify({ logger: false });
  server.get("/health", async () => ({
    ok: true,
    timestamp: new Date().toISOString()
  }));
  return server;
}

/**
 * Starts listening on the given server. Call after all routes are registered.
 */
export async function startHttpServer(server: FastifyInstance): Promise<void> {
  await server.listen({ port: env.HTTP_PORT, host: "0.0.0.0" });
  logger.info({ port: env.HTTP_PORT }, "HTTP server started");
}

/**
 * Registers the payment webhook route on an existing server.
 * Accepts a getter so the route can be registered before services are ready.
 * Returns 503 until services are available.
 */
export function addPaymentWebhookRoute(
  server: FastifyInstance,
  getServices: () => AppServices | null,
  prisma: PrismaClient
): void {
  server.post<{
    Body: {
      referenceCode: string;
      status: string;
      externalTxId?: string;
    };
  }>("/webhooks/payments/crypto", async (request, reply) => {
    const services = getServices();
    if (!services) {
      reply.code(503);
      return { ok: false, error: "Services not ready" };
    }

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
}
