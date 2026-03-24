import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { env } from "../config/env";
import { logger } from "../common/logger";
import type { AppServices } from "../app/services";
import { NowPaymentsAdapter } from "../modules/payments/nowpayments.adapter";

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
 * Deposit notification is sent via BalanceService.onDepositCredited (uses deposit.botInstanceId).
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
    const rawBody = (request as any).rawBody ?? JSON.stringify(request.body ?? {});
    const signatureHeader = request.headers["x-nowpayments-sig"];
    const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const ipnSecret = env.NOWPAYMENTS_IPN_SECRET?.trim();
    const signatureValid = Boolean(ipnSecret && (await NowPaymentsAdapter.verifyIpnSignature(rawBody, sig, ipnSecret)));

    let bodyJson: object;
    try {
      bodyJson = typeof request.body === "object" && request.body ? (request.body as object) : (JSON.parse(rawBody) as object);
    } catch {
      bodyJson = { _parseError: "invalid_json" };
    }
    const externalEventId = typeof (bodyJson as any)?.payment_id !== "undefined"
      ? String((bodyJson as any).payment_id)
      : null;

    const safeHeaders: Record<string, string> = {};
    const h = request.headers;
    if (h["content-type"]) safeHeaders["content-type"] = String(h["content-type"]);
    safeHeaders["x-nowpayments-sig"] = sig ? "[REDACTED]" : "[MISSING]";

    const webhookLog = await prisma.paymentWebhookLog.create({
      data: {
        provider: "nowpayments",
        externalEventId,
        headersJson: safeHeaders,
        bodyJson,
        signatureValid,
        processed: false
      }
    });

    const services = getServices();
    if (!services) {
      await prisma.paymentWebhookLog.update({
        where: { id: webhookLog.id },
        data: { processed: true, processingResult: "services_not_ready" }
      });
      logger.warn({ route: "/webhooks/payments/nowpayments" }, "NOWPayments webhook rejected: services not ready");
      reply.code(503);
      return { ok: false, error: "Services not ready" };
    }

    if (!signatureValid) {
      await prisma.paymentWebhookLog.update({
        where: { id: webhookLog.id },
        data: { processed: true, processingResult: "invalid_signature" }
      });
      logger.warn({ route: "/webhooks/payments/nowpayments" }, "NOWPayments webhook rejected: invalid signature");
      reply.code(400);
      return { ok: false, error: "invalid_signature" };
    }

    logger.info(
      { route: "/webhooks/payments/nowpayments", contentLength: request.headers["content-length"] ?? null },
      "NOWPayments webhook request received"
    );

    const result = await services.balance.processNowPaymentsIpn(rawBody, sig);

    const processingResult = !result.ok
      ? (result.error ?? "error")
      : result.credited
        ? "credited"
        : result.duplicate
          ? "duplicate"
          : `status:${result.status ?? "unknown"}`;

    await prisma.paymentWebhookLog.update({
      where: { id: webhookLog.id },
      data: { processed: true, processingResult }
    });

    if (!result.ok) {
      logger.warn(
        { route: "/webhooks/payments/nowpayments", error: result.error ?? "invalid_request" },
        "NOWPayments webhook request rejected"
      );
      reply.code(400);
      return { ok: false, error: result.error ?? "invalid_request" };
    }
    logger.info(
      { route: "/webhooks/payments/nowpayments", credited: Boolean(result.credited), duplicate: Boolean(result.duplicate) },
      "NOWPayments webhook request processed"
    );
    return { ok: true, credited: result.credited, duplicate: result.duplicate };
  });

  server.get("/webhooks/payments/owner-payout-trigger", async () => {
    const configured = Boolean(env.NOWPAYMENTS_PAYOUT_TRIGGER_SECRET?.trim());
    return {
      ok: true,
      route: "/webhooks/payments/owner-payout-trigger",
      message: "Use POST with ?secret=xxx to trigger payout",
      configured
    };
  });

  server.post<{
    Querystring: { secret?: string };
  }>("/webhooks/payments/owner-payout-trigger", async (request, reply) => {
    const triggerSecret = env.NOWPAYMENTS_PAYOUT_TRIGGER_SECRET?.trim();
    if (!triggerSecret) {
      reply.code(400);
      return { ok: false, error: "Payout trigger not configured (set NOWPAYMENTS_PAYOUT_TRIGGER_SECRET)" };
    }
    const provided = request.query?.secret ?? "";
    if (provided !== triggerSecret) {
      reply.code(401);
      return { ok: false, error: "Invalid secret" };
    }
    const services = getServices();
    if (!services) {
      reply.code(503);
      return { ok: false, error: "Services not ready" };
    }
    const runAt = new Date();
    const idempotencyKey = `owner-payout-manual-${runAt.getTime()}`;
    await services.scheduler.schedule(
      "PROCESS_OWNER_DAILY_PAYOUTS",
      {},
      runAt,
      idempotencyKey
    );
    logger.info({ route: "/webhooks/payments/owner-payout-trigger" }, "Owner payout job scheduled");
    return { ok: true, message: "Payout job scheduled" };
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
