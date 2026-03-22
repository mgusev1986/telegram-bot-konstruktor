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
  server.get("/", async (_req, reply) => {
    return reply.redirect("/health", 302);
  });
  return server;
}

/**
 * Starts listening on the given server. Call after all routes are registered.
 */
export async function startHttpServer(server: FastifyInstance): Promise<void> {
  await server.listen({ port: env.HTTP_PORT, host: "0.0.0.0" });
  logger.info({ port: env.HTTP_PORT }, "HTTP server started");
  logger.info("/health route enabled (GET /health and GET / redirect)");
}

/**
 * Registers payment webhook routes on an existing server.
 * Accepts a getter so the route can be registered before services are ready.
 * Returns 503 until services are available.
 */
export function addPaymentWebhookRoute(
  server: FastifyInstance,
  getServices: () => AppServices | null,
  prisma: PrismaClient
): void {
  // NOWPayments IPN — needs raw body for signature verification
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req: any, body: string, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(body) as object);
      } catch (e) {
        done(e as Error, undefined);
      }
    }
  );

  server.get("/webhooks/payments/nowpayments", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      ok: true,
      provider: "nowpayments",
      route: "/webhooks/payments/nowpayments",
      servicesReady: Boolean(getServices()),
      timestamp: new Date().toISOString()
    };
  });

  server.post<{
    Body: Record<string, unknown>;
    RawBody?: string;
  }>("/webhooks/payments/nowpayments", async (request, reply) => {
    const services = getServices();
    if (!services) {
      logger.warn({ route: "/webhooks/payments/nowpayments" }, "NOWPayments webhook rejected: services not ready");
      reply.code(503);
      return { ok: false, error: "Services not ready" };
    }
    const rawBody = (request as any).rawBody ?? JSON.stringify(request.body ?? {});
    const signatureHeader = request.headers["x-nowpayments-sig"];
    const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    logger.info(
      {
        route: "/webhooks/payments/nowpayments",
        contentLength: request.headers["content-length"] ?? null,
        hasSignature: Boolean(sig)
      },
      "NOWPayments webhook request received"
    );
    const result = await services.balance.processNowPaymentsIpn(rawBody, sig);
    if (!result.ok) {
      logger.warn(
        { route: "/webhooks/payments/nowpayments", error: result.error ?? "invalid_request" },
        "NOWPayments webhook request rejected"
      );
      reply.code(400);
      return { ok: false, error: result.error ?? "invalid_request" };
    }
    logger.info(
      {
        route: "/webhooks/payments/nowpayments",
        credited: Boolean(result.credited),
        duplicate: Boolean(result.duplicate),
        status: result.status ?? null
      },
      "NOWPayments webhook request processed"
    );
    return { ok: true, credited: result.credited, duplicate: result.duplicate };
  });

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
