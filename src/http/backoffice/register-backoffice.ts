import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import formBody from "@fastify/formbody";
import ExcelJS from "exceljs";
import { Telegraf } from "telegraf";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";

import { env } from "../../config/env";
import type { SupportedDictionaryLanguage } from "../../modules/i18n/static-dictionaries";
import { I18nService } from "../../modules/i18n/i18n.service";
import type { BotRuntimeManager } from "../../bot/bot-runtime-manager";
import { encryptTelegramBotToken, hashTelegramBotToken } from "../../common/telegram-token-encryption";

import type { BackofficeUserRole, PrismaClient } from "@prisma/client";
import { BotCloneService } from "../../modules/bots/bot-clone.service";
import { AuditService } from "../../modules/audit/audit.service";
import { PermissionService } from "../../modules/permissions/permission.service";
import { UserService } from "../../modules/users/user.service";
import { BotRoleAssignmentService } from "../../modules/bot-roles/bot-role-assignment.service";
import { UserDirectoryService } from "../../modules/users/user-directory.service";
import { logger } from "../../common/logger";
import { parseLinkedChatsFromForm } from "../../common/linked-chat-parser";
import { canPerform, canViewGlobalUserDirectory, type BackofficeAction } from "./backoffice-permissions";

const COOKIE_NAME = env.BACKOFFICE_COOKIE_NAME;
const i18n = new I18nService((env.DEFAULT_LANGUAGE || "ru") as SupportedDictionaryLanguage);

function getBackofficeLang(req: FastifyRequest): "ru" | "en" {
  const raw = req.headers["accept-language"];
  if (!raw) return "ru";
  const first = raw.split(",")[0]?.trim();
  const code = first?.split("-")[0]?.toLowerCase();
  return code === "en" ? "en" : "ru";
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function setBackofficeCookie(reply: FastifyReply, token: string): void {
  const maxAgeSeconds = 60 * 60 * 24 * 7; // 7 days
  const secure = process.env.NODE_ENV === "production";
  reply.header(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/backoffice; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds};${secure ? " Secure;" : ""}`
  );
}

function clearBackofficeCookie(reply: FastifyReply): void {
  reply.header(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/backoffice; HttpOnly; SameSite=Lax; Max-Age=0;${process.env.NODE_ENV === "production" ? " Secure;" : ""}`
  );
}

function signBackofficeSessionPayload(payloadB64: string, secret: string): string {
  const h = createHmac("sha256", secret);
  h.update(payloadB64);
  const sig = h.digest();
  return base64UrlEncode(sig);
}

function createBackofficeSessionToken(sub: string): string {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
  const payload = { sub, exp };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sigB64 = signBackofficeSessionPayload(payloadB64, env.BACKOFFICE_JWT_SECRET);
  return `${payloadB64}.${sigB64}`;
}

function verifyBackofficeSessionToken(token: string): string | null {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;

  const expectedSigB64 = signBackofficeSessionPayload(payloadB64, env.BACKOFFICE_JWT_SECRET);
  const a = base64UrlDecode(sigB64);
  const b = base64UrlDecode(expectedSigB64);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const payloadRaw = base64UrlDecode(payloadB64).toString("utf8");
  const payload = JSON.parse(payloadRaw) as { sub: string; exp: number };
  if (!payload?.sub || typeof payload.exp !== "number") return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  return payload.sub;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b1220; color: #e5e7eb; }
      a { color: #60a5fa; }
      .wrap { max-width: 980px; margin: 0 auto; padding: 28px 18px; }
      .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 18px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      .row > * { flex: 1 1 auto; }
      label { display: block; margin-bottom: 6px; font-size: 13px; color: #cbd5e1; }
      input, textarea, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.15); color: #e5e7eb; }
      button { padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: #2563eb; color: white; cursor: pointer; }
      button.secondary { background: rgba(255,255,255,0.08); }
      .small { font-size: 12px; color: #94a3b8; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
      .bot-card { padding: 14px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); }
      .bot-title { font-weight: 700; }
      .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.15); font-size: 12px; color: #cbd5e1; }
      .error { padding: 10px 12px; border-radius: 12px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.35); margin-top: 10px; }
      .success { padding: 10px 12px; border-radius: 12px; background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.35); margin-bottom: 12px; }
      .bot-card.created { border-color: rgba(34,197,94,0.5); box-shadow: 0 0 0 2px rgba(34,197,94,0.2); }
      .form-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
      .form-row label { margin-bottom: 0; }
      .form-row .field { flex: 0 1 auto; min-width: 0; }
      .form-row select.field { width: auto; min-width: 140px; max-width: 280px; }
      .product-form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px 20px; align-items: start; }
      .product-form-grid .field-wrap { min-width: 0; }
      .product-form-grid .field-wrap input,
      .product-form-grid .field-wrap select { width: 100%; box-sizing: border-box; }
      @media (max-width: 560px) { .product-form-grid { grid-template-columns: 1fr; } }
      .test-block { margin-top: 12px; padding: 12px; border-radius: 10px; border: 1px dashed rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .form-row .btn { flex-shrink: 0; }
      .mi-card { margin-top: 12px; padding: 14px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; }
      .mi-card:first-of-type { margin-top: 0; }
      .section-title { font-size: 14px; font-weight: 600; color: #cbd5e1; margin: 16px 0 8px 0; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .section-title:first-child { margin-top: 0; }
      .paid-table { width: 100%; border-collapse: collapse; font-size: 14px; }
      .paid-table th, .paid-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .paid-table th { color: #94a3b8; font-weight: 500; }
      .paid-table tr:last-child td { border-bottom: none; }
      .product-card { margin-top: 20px; padding: 18px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: rgba(0,0,0,0.12); }
      .product-card:first-of-type { margin-top: 12px; }
      .products-existing-block { margin-top: 28px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.15); }
      .product-card-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
      .test-badge { display: inline-block; padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; background: rgba(251,191,36,0.2); border: 1px solid rgba(251,191,36,0.5); color: #fbbf24; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">${body}</div>
    </div>
  </body>
</html>`;
}

function formatLinkedChatsForEdit(linkedChats: unknown): string {
  if (!Array.isArray(linkedChats)) return "";
  return (linkedChats as Array<{ link?: string; identifier?: string }>)
    .map((e) => e.link ?? e.identifier ?? "")
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** @internal Exported for testing */
export type CreateFormValues = { name?: string; telegramBotUsername?: string; ownerTelegramUsername?: string; baseLanguageCode?: string };

/** @internal Exported for testing */
export function buildCreateBotForm(opts: {
  createError?: string;
  formValues?: CreateFormValues;
  languageOptions?: Array<{ code: string; label: string }>;
}): string {
  const vals = opts.formValues ?? {};
  const name = escapeHtml(vals.name ?? "");
  const username = escapeHtml(vals.telegramBotUsername ?? "");
  const ownerUsername = escapeHtml(vals.ownerTelegramUsername ?? "");
  const langOpts = opts.languageOptions ?? [
    { code: "ru", label: "Русский" },
    { code: "en", label: "English" },
    { code: "de", label: "German" }
  ];
  const validCodes = new Set(langOpts.map((l) => l.code));
  const baseLang = vals.baseLanguageCode && validCodes.has(vals.baseLanguageCode) ? vals.baseLanguageCode : langOpts[0]?.code ?? "ru";
  const langSelectOptions = langOpts
    .map((l) => `<option value="${escapeHtml(l.code)}"${baseLang === l.code ? " selected" : ""}>${escapeHtml(l.label)}</option>`)
    .join("\n");
  const errorBlock = opts.createError
    ? `<div class="error" role="alert">${escapeHtml(opts.createError)}</div>`
    : "";
  return `${errorBlock}
            <form id="create-bot-form" method="POST" action="/backoffice/api/bots/create" style="margin-top:12px" onsubmit="var btn=this.querySelector('button[type=submit]');if(btn&&!btn.disabled){btn.disabled=true;btn.textContent='Создание…';}">
              <div style="margin-bottom:10px">
                <label>Название бота</label>
                <input name="name" type="text" required value="${name}" />
              </div>
              <div style="margin-bottom:10px">
                <label>Telegram Bot Token</label>
                <input name="telegramBotToken" type="text" required placeholder="Введите токен" autocomplete="off" />
              </div>
              <div style="margin-bottom:10px">
                <label>Telegram Username бота (опционально)</label>
                <input name="telegramBotUsername" type="text" placeholder="my_bot" value="${username}" />
              </div>
              <div style="margin-bottom:10px">
                <label>Username владельца (опционально)</label>
                <input name="ownerTelegramUsername" type="text" placeholder="@username клиента, создавшего токен" value="${ownerUsername}" />
                <div class="small" style="margin-top:2px; color:#94a3b8">Будущий владелец увидит пустой экран до активации роли в разделе «Роли».</div>
              </div>
              <div style="margin-bottom:10px">
                <label>Базовый язык</label>
                <select name="baseLanguageCode">
                  ${langSelectOptions}
                </select>
              </div>
              <button type="submit" id="create-bot-submit">Создать</button>
            </form>`;
}

/** @internal Exported for testing */
export type DashboardParams = {
  bots: Array<{ id: string; name: string; telegramBotUsername: string | null; status: string; createdAt: Date }>;
  role: BackofficeUserRole;
  email: string;
  lang: "ru" | "en";
  createdBotId?: string;
  createError?: string;
  formValues?: CreateFormValues;
  canViewAudience: boolean;
  languageOptions?: Array<{ code: string; label: string }>;
};

/** @internal Exported for testing */
export function renderDashboardBody(params: DashboardParams): string {
  const { bots, role, email, lang, createdBotId, createError, formValues, canViewAudience, languageOptions } = params;
  const createdBot = createdBotId ? bots.find((b) => b.id === createdBotId) : undefined;
  const cards = bots
    .map((b) => {
      const openUrl = b.telegramBotUsername ? `https://t.me/${b.telegramBotUsername}` : "#";
      const settingsBtn = canPerform(role, "bot_settings:write", email)
        ? `<a href="/backoffice/bots/${b.id}/settings" style="text-decoration:none"><button class="secondary" type="button">Настройки</button></a>`
        : ``;
      const rolesBtn = canPerform(role, "bot_roles:manage", email)
        ? `<a href="/backoffice/bots/${b.id}/roles" style="text-decoration:none"><button class="secondary" type="button">${i18n.t(lang, "bo_roles_btn")}</button></a>`
        : ``;
      const cloneBtn = canPerform(role, "bot_clone:create", email)
        ? `<a href="/backoffice/bots/${b.id}/clone" style="text-decoration:none"><button class="secondary" type="button">Клонировать шаблон</button></a>`
        : ``;
      const paidBtn = canPerform(role, "paid_access:manage", email)
        ? `<a href="/backoffice/bots/${b.id}/paid" style="text-decoration:none"><button class="secondary" type="button">Платные продукты</button></a>`
        : ``;
      const audienceBtn = canViewAudience
        ? `<a href="/backoffice/audience?bot=${encodeURIComponent(b.id)}" style="text-decoration:none"><button class="secondary" type="button">Аудитория</button></a>`
        : ``;
      const createdClass = b.id === createdBotId ? " created" : "";
      const cardId = b.id === createdBotId ? ` id="bot-${b.id}"` : "";
      return `<div class="bot-card${createdClass}"${cardId}>
          <div class="row" style="align-items:flex-start">
            <div style="min-width:220px">
              <div class="bot-title">${b.name}</div>
              <div class="small" style="margin-top:4px">@${b.telegramBotUsername ?? "—"}</div>
            </div>
            <div style="text-align:right">
              <span class="pill">${b.status}</span>
              <div class="small" style="margin-top:6px">${b.createdAt.toISOString().slice(0, 10)}</div>
            </div>
          </div>
          <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:8px; align-items:center">
            <a href="${openUrl}" target="_blank" style="text-decoration:none"><button class="secondary" type="button">Открыть</button></a>
            ${settingsBtn}
            ${audienceBtn}
            ${paidBtn}
            ${rolesBtn}
            ${cloneBtn}
          </div>
        </div>`;
    })
    .join("\n");
  const audienceLink = canViewAudience
    ? `<a href="/backoffice/audience" style="text-decoration:none"><button class="secondary" type="button">Аудитория</button></a>`
    : "";
  const databaseLink = canViewAudience
    ? `<a href="/backoffice/database" style="text-decoration:none"><button class="secondary" type="button">База данных</button></a>`
    : "";
  const successBanner =
    createdBot && createdBotId
      ? `<div class="success" role="status"><strong>Бот успешно создан</strong>: ${escapeHtml(createdBot.name)}${createdBot.telegramBotUsername ? ` (@${escapeHtml(createdBot.telegramBotUsername)})` : ""}. <a href="/backoffice/bots/${escapeHtml(createdBot.id)}/settings">Настройки</a> · <a href="${createdBot.telegramBotUsername ? `https://t.me/${createdBot.telegramBotUsername}` : "#"}" target="_blank">Открыть в Telegram</a></div>`
      : "";
  const createForm = buildCreateBotForm({ createError, formValues, languageOptions });
  const scrollScript = createdBotId ? `<script>document.getElementById("bot-${escapeHtml(createdBotId)}")?.scrollIntoView({behavior:"smooth",block:"nearest"});</script>` : "";
  return `<div class="row" style="justify-content:space-between">
          <div>
            <h2 style="margin:0">Back-office</h2>
            <div class="small" style="margin-top:4px">Мои bot instances</div>
          </div>
          <div class="row" style="flex:0 0 auto; gap:8px">
            ${audienceLink}
            ${databaseLink}
            <a href="/backoffice/logout" style="text-decoration:none"><button class="secondary" type="button">Logout</button></a>
          </div>
        </div>
        ${successBanner}
        <div style="margin-top:16px" class="grid">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
              <h3 style="margin:0">Список ботов</h3>
              <span class="small">${bots.length} шт</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:12px">${cards || `<div class="small">Пока нет созданных bot instances.</div>`}</div>
          </div>
          <div>
            <h3 style="margin-top:0">➕ Добавить бота</h3>
            <div class="small">Создаётся новый BotInstance + активный template (root/welcome + пустая структура).</div>
            ${createForm}
            <div class="small" style="margin-top:10px">
              В целях безопасности токен не отображается. Валидатор использует <code>getMe</code>.
            </div>
          </div>
        </div>
        ${scrollScript}`;
}

function requireAuth(authUserId: string | null, reply: FastifyReply): boolean {
  if (authUserId) return true;
  reply.redirect("/backoffice/login");
  return false;
}

const loginAttempts = new Map<string, { count: number; firstAt: number }>();

async function ensureSuperAdminTelegramUser(prisma: PrismaClient) {
  // Same logic as in src/index.ts (duplication is intentional to keep modules independent).
  // Creates a telegram OWNER user if missing.
  const telegramUserId = env.SUPER_ADMIN_TELEGRAM_ID;
  const existing = await prisma.user.findFirst({ where: { telegramUserId } });
  if (existing) {
    await prisma.adminPermission.upsert({
      where: { userId: existing.id },
      update: {
        canEditMenu: true,
        canSendBroadcasts: true,
        canScheduleMessages: true,
        canManageLanguages: true,
        canManagePayments: true,
        canManageSegments: true,
        canViewGlobalStats: true,
        canManageTemplates: true
      },
      create: {
        userId: existing.id,
        canEditMenu: true,
        canSendBroadcasts: true,
        canScheduleMessages: true,
        canManageLanguages: true,
        canManagePayments: true,
        canManageSegments: true,
        canViewGlobalStats: true,
        canManageTemplates: true
      }
    });

    // Ensure role mapping: SUPER_ADMIN_TELEGRAM_ID must become ALPHA_OWNER.
    if (existing.role !== "ALPHA_OWNER") {
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: "ALPHA_OWNER" }
      });
    }

    return existing;
  }

  const createReferralCode = (): string => randomBytes(5).toString("hex");
  let referralCode = createReferralCode();
  while (await prisma.user.findUnique({ where: { referralCode } })) {
    referralCode = createReferralCode();
  }

  const created = await prisma.user.create({
    data: {
      telegramUserId,
      username: undefined,
      firstName: "Super",
      lastName: "Admin",
      fullName: "Super Admin",
      selectedLanguage: env.DEFAULT_LANGUAGE,
      role: "ALPHA_OWNER",
      referralCode
    }
  });

  await prisma.adminPermission.create({
    data: {
      userId: created.id,
      canEditMenu: true,
      canSendBroadcasts: true,
      canScheduleMessages: true,
      canManageLanguages: true,
      canManagePayments: true,
      canManageSegments: true,
      canViewGlobalStats: true,
      canManageTemplates: true
    }
  });

  return created;
}

async function bootstrapDefaultBackofficeAdmin(prisma: PrismaClient) {
  if (!env.BACKOFFICE_ADMIN_EMAIL || !env.BACKOFFICE_ADMIN_PASSWORD) return null;

  const existing = await prisma.backofficeUser.findUnique({ where: { email: env.BACKOFFICE_ADMIN_EMAIL } });
  if (existing) return existing;

  const passwordHash = await argon2.hash(env.BACKOFFICE_ADMIN_PASSWORD);
  const isAlpha = env.BACKOFFICE_ALPHA_EMAIL && env.BACKOFFICE_ALPHA_EMAIL === env.BACKOFFICE_ADMIN_EMAIL;
  return prisma.backofficeUser.create({
    data: {
      email: env.BACKOFFICE_ADMIN_EMAIL,
      passwordHash,
      role: isAlpha ? "ALPHA_OWNER" : "OWNER"
    }
  });
}

async function tokenValidateViaTelegram(botToken: string, timeoutMs = 7_000): Promise<{ username?: string } > {
  const bot = new Telegraf(botToken);
  // Telegraf methods don't provide explicit timeout; rely on a simple AbortController-like wrapper via Promise.race.
  const p = bot.telegram.getMe();
  const t = new Promise((_, reject) => setTimeout(() => reject(new Error("Telegram timeout")), timeoutMs));
  const me = await Promise.race([p, t]) as any;
  return { username: me?.username };
}

export async function registerBackofficeRoutes(
  server: FastifyInstance,
  prisma: PrismaClient,
  runtimeManager: BotRuntimeManager
): Promise<void> {
  await server.register(formBody);
  await bootstrapDefaultBackofficeAdmin(prisma);

  const userDirectory = new UserDirectoryService(prisma);

  server.get("/backoffice/login", async (_req, reply) => {
    return reply.type("text/html").send(
      renderPage(
        "Backoffice login",
        `<h2 style="margin-top:0">Telegram Bot Konstruktor</h2>
         <p class="small">Вход в back-office по email/password</p>
         <form method="POST" action="/backoffice/login" style="margin-top:14px">
           <div class="grid">
             <div>
               <label>Email</label>
               <input name="email" type="email" autocomplete="username" required />
             </div>
             <div>
               <label>Пароль</label>
               <input name="password" type="password" autocomplete="current-password" required />
             </div>
           </div>
           <div style="margin-top:14px" class="row">
             <button type="submit">Войти</button>
             <a href="/backoffice">Перейти</a>
           </div>
           <div class="small" style="margin-top:10px">
             Подсказка: задайте <code>BACKOFFICE_ADMIN_EMAIL</code> и <code>BACKOFFICE_ADMIN_PASSWORD</code> в .env для initial-админа.
           </div>
         </form>`
      )
    );
  });

  server.post("/backoffice/login", async (req, reply) => {
    const ip = (req.headers["x-forwarded-for"] ?? req.ip) as string;
    const body = req.body as any;
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");

    const attemptKey = `${ip}:${email}`;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 6;

    const prev = loginAttempts.get(attemptKey);
    if (prev && now - prev.firstAt < windowMs && prev.count >= maxAttempts) {
      reply.code(429);
      return reply.type("text/html").send(renderPage("Backoffice login", `<div class="error">Слишком много попыток. Попробуйте позже.</div>`));
    }

    loginAttempts.set(attemptKey, {
      count: prev && now - prev.firstAt < windowMs ? prev.count + 1 : 1,
      firstAt: prev && now - prev.firstAt < windowMs ? prev.firstAt : now
    });

    const user = await prisma.backofficeUser.findUnique({ where: { email } });
    if (!user) {
      reply.code(401);
      return reply.type("text/html").send(renderPage("Backoffice login", `<div class="error">Неверный email или пароль.</div>`));
    }

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      reply.code(401);
      return reply.type("text/html").send(renderPage("Backoffice login", `<div class="error">Неверный email или пароль.</div>`));
    }

    const token = createBackofficeSessionToken(user.id);
    setBackofficeCookie(reply, token);
    return reply.redirect("/backoffice");
  });

  server.get("/backoffice/logout", async (_req, reply) => {
    clearBackofficeCookie(reply);
    return reply.redirect("/backoffice/login");
  });

  server.get("/backoffice", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const backofficeUser = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true, email: true }
    });
    const role = backofficeUser?.role ?? "ADMIN";
    const email = backofficeUser?.email ?? "";

    const bots = await prisma.botInstance.findMany({
      where: {
        OR: [{ ownerBackofficeUserId: backofficeUserId }, { ownerBackofficeUserId: null }]
      },
      orderBy: { createdAt: "desc" }
    });

    const query = req.query as Record<string, string | undefined>;
    const createdBotId = query.created?.trim() || undefined;
    const createError = query.createError ? decodeURIComponent(query.createError) : undefined;
    const lang = getBackofficeLang(req);

    const body = renderDashboardBody({
      bots,
      role,
      email,
      lang,
      createdBotId,
      createError,
      formValues: undefined,
      canViewAudience: canViewGlobalUserDirectory(role, email),
      languageOptions: i18n.availableLanguages()
    });
    return reply.type("text/html").send(renderPage("Backoffice", body));
  });

  server.get("/backoffice/audience", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const backofficeUser = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true, email: true }
    });
    const role = backofficeUser?.role ?? "ADMIN";
    const email = backofficeUser?.email ?? "";
    if (!canViewGlobalUserDirectory(role, email)) {
      return reply.code(403).send("Forbidden");
    }

    logger.info(
      { backofficeUserId, email, botId: (req.query as Record<string, string>)?.bot },
      "Global user directory accessed by ALPHA_OWNER"
    );

    const query = req.query as Record<string, string | undefined>;
    const botId = query.bot;
    const search = query.search?.trim() ?? "";
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const perPage = Math.min(100, Math.max(10, parseInt(query.perPage ?? "25", 10) || 25));

    const bots = await prisma.botInstance.findMany({
      where: { isArchived: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, telegramBotUsername: true }
    });

    const filters = {
      botInstanceIds: botId ? [botId] : undefined,
      search: search || undefined
    };
    const sort = { sortBy: "createdAt" as const, order: "desc" as const };
    const { rows, total } = await userDirectory.listUsersAcrossBots(filters, { page, perPage }, sort);
    const summary = await userDirectory.getDirectorySummary();

    const botOptions = bots
      .map(
        (b) =>
          `<option value="${escapeHtml(b.id)}" ${botId === b.id ? "selected" : ""}>${escapeHtml(b.name)} (@${escapeHtml(b.telegramBotUsername ?? "—")})</option>`
      )
      .join("");

    const tableRows = rows
      .map(
        (u) => `
    <tr>
      <td>${escapeHtml(u.id.slice(0, 8))}</td>
      <td>${u.username ? `<a href="https://t.me/${escapeHtml(u.username)}" target="_blank">@${escapeHtml(u.username)}</a>` : "—"}</td>
      <td>${escapeHtml(String(u.telegramUserId))}</td>
      <td>${escapeHtml(u.fullName || u.firstName || "—")}</td>
      <td>${u.botName ? escapeHtml(u.botName) : "—"}</td>
      <td>${escapeHtml(u.selectedLanguage)}</td>
      <td>${u.lastSeenAt ? escapeHtml(u.lastSeenAt.toISOString().slice(0, 19)) : "—"}</td>
      <td>${escapeHtml(u.createdAt.toISOString().slice(0, 19))}</td>
    </tr>`
      )
      .join("");

    const prevPage = page > 1 ? page - 1 : null;
    const totalPages = Math.ceil(total / perPage);
    const nextPage = page < totalPages ? page + 1 : null;
    const prevLink = prevPage
      ? `<a href="/backoffice/audience?page=${prevPage}&perPage=${perPage}${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}">← Назад</a>`
      : "";
    const nextLink = nextPage
      ? `<a href="/backoffice/audience?page=${nextPage}&perPage=${perPage}${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}">Вперёд →</a>`
      : "";

    const summaryCards = `
      <div class="row" style="gap:12px; margin-bottom:16px; flex-wrap:wrap">
        <div class="bot-card" style="min-width:120px"><strong>${summary.totalUsers}</strong><br><span class="small">Всего пользователей</span></div>
        <div class="bot-card" style="min-width:120px"><strong>${summary.totalBots}</strong><br><span class="small">Ботов</span></div>
        <div class="bot-card" style="min-width:120px"><strong>${summary.multiBotUserCount}</strong><br><span class="small">В нескольких ботах</span></div>
      </div>`;

    return reply.type("text/html").send(
      renderPage(
        "Платформа: Аудитория",
        `<div class="row" style="justify-content:space-between; align-items:center">
          <div>
            <h2 style="margin:0">Аудитория</h2>
            <div class="small" style="margin-top:4px">Централизованная база пользователей по всем ботам</div>
          </div>
          <a href="/backoffice" style="text-decoration:none"><button class="secondary" type="button">← На dashboard</button></a>
        </div>
        ${summaryCards}
        <form method="GET" action="/backoffice/audience" style="margin-bottom:16px" class="row">
          <div style="flex:1; min-width:140px">
            <label>Бот</label>
            <select name="bot">
              <option value="">— Все боты —</option>
              ${botOptions}
            </select>
          </div>
          <div style="flex:1; min-width:180px">
            <label>Поиск (username, id, имя)</label>
            <input name="search" type="text" value="${escapeHtml(search)}" placeholder="Поиск..." />
          </div>
          <div style="flex:0 0 auto; align-self:flex-end; display:flex; gap:8px; align-items:center; flex-wrap:wrap">
            <button type="submit">Применить</button>
            <span class="small" style="color:#94a3b8">Экспорт:</span>
            <a href="/backoffice/audience/export?format=html${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}" style="display:inline-block; text-decoration:none; padding:8px 12px; font-size:13px; border-radius:10px; border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.08); color:#e5e7eb">HTML</a>
            <a href="/backoffice/audience/export?format=xlsx${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}" style="display:inline-block; text-decoration:none; padding:8px 12px; font-size:13px; border-radius:10px; border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.08); color:#e5e7eb">Excel</a>
            <a href="/backoffice/audience/export?format=csv${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}" style="display:inline-block; text-decoration:none; padding:8px 12px; font-size:13px; border-radius:10px; border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.08); color:#e5e7eb">CSV</a>
          </div>
        </form>
        <div class="table-wrap" style="overflow-x:auto">
          <table style="width:100%; border-collapse:collapse">
            <thead>
              <tr>
                <th style="text-align:left; padding:8px">ID</th>
                <th style="text-align:left; padding:8px">Username</th>
                <th style="text-align:left; padding:8px">Telegram ID</th>
                <th style="text-align:left; padding:8px">Имя</th>
                <th style="text-align:left; padding:8px">Бот</th>
                <th style="text-align:left; padding:8px">Язык</th>
                <th style="text-align:left; padding:8px">Последняя активность</th>
                <th style="text-align:left; padding:8px">Регистрация</th>
              </tr>
            </thead>
            <tbody>${tableRows || "<tr><td colspan='8' class='small'>Нет пользователей</td></tr>"}
            </tbody>
          </table>
        </div>
        <div class="row" style="margin-top:12px; justify-content:space-between">
          <span class="small">Страница ${page} из ${totalPages || 1} · Всего: ${total}</span>
          <span>${prevLink} ${nextLink ? ` · ${nextLink}` : ""}</span>
        </div>`
      )
    );
  });

  server.get("/backoffice/audience/export", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const backofficeUser = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true, email: true }
    });
    const role = backofficeUser?.role ?? "ADMIN";
    const email = backofficeUser?.email ?? "";
    if (!canViewGlobalUserDirectory(role, email)) {
      return reply.code(403).send("Forbidden");
    }

    const query = req.query as Record<string, string | undefined>;
    const format = (query.format ?? "csv").toLowerCase();
    const botId = query.bot;
    const search = query.search?.trim() ?? "";

    if (!["html", "xlsx", "csv"].includes(format)) {
      return reply.code(400).send("Invalid format. Use html, xlsx or csv.");
    }

    const filters = {
      botInstanceIds: botId ? [botId] : undefined,
      search: search || undefined
    };
    const sort = { sortBy: "createdAt" as const, order: "desc" as const };
    const { rows } = await userDirectory.listUsersAcrossBots(filters, { page: 1, perPage: 50000 }, sort);

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `audience-${dateStr}.${format === "xlsx" ? "xlsx" : format}`;

    if (format === "csv") {
      const sep = ";";
      const header = ["ID", "Username", "Telegram ID", "Имя", "Бот", "Язык", "Последняя активность", "Регистрация"].join(sep);
      const lines = rows.map(
        (u) =>
          [
            u.id.slice(0, 8),
            u.username ? `@${u.username}` : "",
            String(u.telegramUserId),
            (u.fullName || u.firstName || "").replace(/"/g, '""'),
            u.botName ?? "",
            u.selectedLanguage,
            u.lastSeenAt ? u.lastSeenAt.toISOString().slice(0, 19) : "",
            u.createdAt.toISOString().slice(0, 19)
          ].join(sep)
      );
      const csv = [header, ...lines].join("\n");
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send("\uFEFF" + csv);
    }

    if (format === "html") {
      const rowsHtml = rows
        .map(
          (u) =>
            `<tr>
              <td>${escapeHtml(u.id.slice(0, 8))}</td>
              <td>${u.username ? `@${escapeHtml(u.username)}` : "—"}</td>
              <td>${escapeHtml(String(u.telegramUserId))}</td>
              <td>${escapeHtml(u.fullName || u.firstName || "—")}</td>
              <td>${u.botName ? escapeHtml(u.botName) : "—"}</td>
              <td>${escapeHtml(u.selectedLanguage)}</td>
              <td>${u.lastSeenAt ? escapeHtml(u.lastSeenAt.toISOString().slice(0, 19)) : "—"}</td>
              <td>${escapeHtml(u.createdAt.toISOString().slice(0, 19))}</td>
            </tr>`
        )
        .join("");
      const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Аудитория — ${dateStr}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
    th { background: #f0f0f0; }
  </style>
</head>
<body>
  <h1>Аудитория — ${dateStr}</h1>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Username</th><th>Telegram ID</th><th>Имя</th><th>Бот</th><th>Язык</th><th>Последняя активность</th><th>Регистрация</th>
      </tr>
    </thead>
    <tbody>${rowsHtml || "<tr><td colspan=\"8\">Нет данных</td></tr>"}
    </tbody>
  </table>
</body>
</html>`;
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(html);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Аудитория", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "ID", key: "id", width: 12 },
      { header: "Username", key: "username", width: 18 },
      { header: "Telegram ID", key: "telegramUserId", width: 14 },
      { header: "Имя", key: "fullName", width: 22 },
      { header: "Бот", key: "botName", width: 16 },
      { header: "Язык", key: "selectedLanguage", width: 8 },
      { header: "Последняя активность", key: "lastSeenAt", width: 22 },
      { header: "Регистрация", key: "createdAt", width: 22 }
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((u) => {
      ws.addRow({
        id: u.id.slice(0, 8),
        username: u.username ? `@${u.username}` : "",
        telegramUserId: String(u.telegramUserId),
        fullName: u.fullName || u.firstName || "",
        botName: u.botName ?? "",
        selectedLanguage: u.selectedLanguage,
        lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString().slice(0, 19) : "",
        createdAt: u.createdAt.toISOString().slice(0, 19)
      });
    });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buffer);
  });

  server.get("/backoffice/database", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const backofficeUser = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true, email: true }
    });
    const role = backofficeUser?.role ?? "ADMIN";
    const email = backofficeUser?.email ?? "";
    if (!canViewGlobalUserDirectory(role, email)) {
      return reply.code(403).send("Forbidden");
    }

    const bots = await prisma.botInstance.findMany({
      where: { isArchived: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, telegramBotUsername: true, status: true }
    });

    type BotStats = {
      users: number;
      broadcasts: number;
      dripCampaigns: number;
      payments: number;
      paidPayments: number;
      templates: number;
      menuItems: number;
    };

    const statsByBot: Array<{ botId: string; botName: string; username: string | null; stats: BotStats }> = [];

    for (const bot of bots) {
      const [users, broadcasts, dripCampaigns, payments, paidPayments, templates, menuItems] = await Promise.all([
        prisma.user.count({ where: { botInstanceId: bot.id } }),
        prisma.broadcast.count({ where: { botInstanceId: bot.id } }),
        prisma.dripCampaign.count({ where: { botInstanceId: bot.id } }),
        prisma.payment.count({ where: { botInstanceId: bot.id } }),
        prisma.payment.count({ where: { botInstanceId: bot.id, status: "PAID" } }),
        prisma.presentationTemplate.count({ where: { botInstanceId: bot.id, isActive: true } }),
        prisma.menuItem.count({
          where: {
            template: { botInstanceId: bot.id }
          }
        })
      ]);
      statsByBot.push({
        botId: bot.id,
        botName: bot.name,
        username: bot.telegramBotUsername,
        stats: {
          users,
          broadcasts,
          dripCampaigns,
          payments,
          paidPayments,
          templates,
          menuItems
        }
      });
    }

    const tableRows = statsByBot
      .map(
        (row) => `
    <tr>
      <td style="padding:10px 12px"><a href="/backoffice/audience?bot=${encodeURIComponent(row.botId)}">${escapeHtml(row.botName)}</a></td>
      <td style="padding:10px 12px"><span class="small">@${escapeHtml(row.username ?? "—")}</span></td>
      <td style="padding:10px 12px; text-align:right"><a href="/backoffice/audience?bot=${encodeURIComponent(row.botId)}">${row.stats.users}</a></td>
      <td style="padding:10px 12px; text-align:right">${row.stats.broadcasts}</td>
      <td style="padding:10px 12px; text-align:right">${row.stats.dripCampaigns}</td>
      <td style="padding:10px 12px; text-align:right">${row.stats.payments}</td>
      <td style="padding:10px 12px; text-align:right">${row.stats.paidPayments}</td>
      <td style="padding:10px 12px; text-align:right">${row.stats.templates}</td>
      <td style="padding:10px 12px; text-align:right">${row.stats.menuItems}</td>
    </tr>`
      )
      .join("");

    const totals = statsByBot.reduce(
      (acc, row) => ({
        users: acc.users + row.stats.users,
        broadcasts: acc.broadcasts + row.stats.broadcasts,
        dripCampaigns: acc.dripCampaigns + row.stats.dripCampaigns,
        payments: acc.payments + row.stats.payments,
        paidPayments: acc.paidPayments + row.stats.paidPayments,
        templates: acc.templates + row.stats.templates,
        menuItems: acc.menuItems + row.stats.menuItems
      }),
      { users: 0, broadcasts: 0, dripCampaigns: 0, payments: 0, paidPayments: 0, templates: 0, menuItems: 0 }
    );

    const totalsRow =
      statsByBot.length > 1
        ? `
    <tr style="border-top:2px solid rgba(255,255,255,0.2); font-weight:600">
      <td style="padding:10px 12px" colspan="2">Всего</td>
      <td style="padding:10px 12px; text-align:right">${totals.users}</td>
      <td style="padding:10px 12px; text-align:right">${totals.broadcasts}</td>
      <td style="padding:10px 12px; text-align:right">${totals.dripCampaigns}</td>
      <td style="padding:10px 12px; text-align:right">${totals.payments}</td>
      <td style="padding:10px 12px; text-align:right">${totals.paidPayments}</td>
      <td style="padding:10px 12px; text-align:right">${totals.templates}</td>
      <td style="padding:10px 12px; text-align:right">${totals.menuItems}</td>
    </tr>`
        : "";

    return reply.type("text/html").send(
      renderPage(
        "База данных по ботам",
        `<div class="row" style="justify-content:space-between; align-items:center">
          <div>
            <h2 style="margin:0">База данных</h2>
            <div class="small" style="margin-top:4px">Статистика по каждому боту</div>
          </div>
          <a href="/backoffice" style="text-decoration:none"><button class="secondary" type="button">← На dashboard</button></a>
        </div>
        <div class="table-wrap" style="overflow-x:auto; margin-top:20px">
          <table style="width:100%; border-collapse:collapse">
            <thead>
              <tr>
                <th style="text-align:left; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Бот</th>
                <th style="text-align:left; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Username</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Пользователи</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Рассылки</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Drip</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Платежи</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Оплачено</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Шаблоны</th>
                <th style="text-align:right; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.2)">Пункты меню</th>
              </tr>
            </thead>
            <tbody>${tableRows || "<tr><td colspan='9' class='small'>Нет ботов</td></tr>"}${totalsRow}
            </tbody>
          </table>
        </div>
        <div class="small" style="margin-top:12px; color:#94a3b8">
          Клик по числу пользователей — переход к списку аудитории с фильтром по боту.
        </div>`
      )
    );
  });

  server.post("/backoffice/api/bots/create", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const body = req.body as any;
    const name = String(body?.name ?? "").trim();
    const token = String(body?.telegramBotToken ?? "").trim();
    let telegramBotUsername = String(body?.telegramBotUsername ?? "").trim().replace(/^@/, "");
    const ownerTelegramUsername = String(body?.ownerTelegramUsername ?? "").trim().replace(/^@/, "");
    const baseLanguageCode = String(body?.baseLanguageCode ?? "ru").trim().toLowerCase();

    const formValues: CreateFormValues = {
      name: name || undefined,
      telegramBotUsername: telegramBotUsername || undefined,
      ownerTelegramUsername: ownerTelegramUsername || undefined,
      baseLanguageCode: baseLanguageCode || "ru"
    };

    const renderErrorDashboard = async (createError: string, statusCode = 400) => {
      const backofficeUser = await prisma.backofficeUser.findUnique({
        where: { id: backofficeUserId ?? undefined },
        select: { role: true, email: true }
      });
      const role = backofficeUser?.role ?? "ADMIN";
      const email = backofficeUser?.email ?? "";
      const bots = await prisma.botInstance.findMany({
        where: { OR: [{ ownerBackofficeUserId: backofficeUserId }, { ownerBackofficeUserId: null }] },
        orderBy: { createdAt: "desc" }
      });
      const lang = getBackofficeLang(req);
      const dashboardBody = renderDashboardBody({
        bots,
        role,
        email,
        lang,
        createError,
        formValues,
        canViewAudience: canViewGlobalUserDirectory(role, email),
        languageOptions: i18n.availableLanguages()
      });
      return reply.code(statusCode).type("text/html").send(renderPage("Backoffice", dashboardBody));
    };

    if (!name || !token) {
      return renderErrorDashboard("Заполните поля «Название бота» и «Telegram Bot Token».");
    }

    try {
      const me = await tokenValidateViaTelegram(token);
      if (!telegramBotUsername && me.username) {
        telegramBotUsername = me.username;
      }
    } catch (e) {
      return renderErrorDashboard(`Токен невалиден: ${(e as any)?.message ?? "unknown error"}`);
    }

    const tokenHash = hashTelegramBotToken(token);
    const existingByHash = await prisma.botInstance.findUnique({
      where: { telegramBotTokenHash: tokenHash }
    });
    if (existingByHash) {
      return renderErrorDashboard("Бот с таким токеном уже существует.", 409);
    }

    const encryptedToken = encryptTelegramBotToken(token, env.BOT_TOKEN_ENCRYPTION_KEY);
    const superAdmin = await ensureSuperAdminTelegramUser(prisma);

    let created: { bot: { id: string }; template: unknown };
    try {
      created = await prisma.$transaction(async (tx) => {
        const bot = await tx.botInstance.create({
          data: {
            ownerBackofficeUserId: backofficeUserId,
            name,
            telegramBotTokenEncrypted: encryptedToken,
            telegramBotTokenHash: tokenHash,
            telegramBotUsername: telegramBotUsername || null,
            status: "ACTIVE"
          }
        });

      const template = await tx.presentationTemplate.create({
        data: {
          title: `${name} Template`,
          ownerAdminId: superAdmin.id,
          botInstanceId: bot.id,
          baseLanguageCode: baseLanguageCode || "ru"
        }
      });

      await tx.presentationLocalization.createMany({
        data: [
          { templateId: template.id, languageCode: "ru", welcomeText: "Добро пожаловать, {{first_name}}! Выберите нужный раздел ниже." },
          { templateId: template.id, languageCode: "en", welcomeText: "Welcome, {{first_name}}! Choose a section below." },
          { templateId: template.id, languageCode: "de", welcomeText: "Willkommen, {{first_name}}! Wählen Sie unten einen Abschnitt." },
          { templateId: template.id, languageCode: "uk", welcomeText: "Ласкаво просимо, {{first_name}}! Оберіть потрібний розділ нижче." }
        ]
      });

        // Если указан username владельца — создаём PENDING назначение. До активации в «Роли» пользователь видит пустой экран.
        const ownerNorm = ownerTelegramUsername.toLowerCase();
        if (ownerNorm && /^[a-z0-9_]{5,32}$/.test(ownerNorm)) {
          await tx.botRoleAssignment.upsert({
            where: {
              botInstanceId_telegramUsernameNormalized: { botInstanceId: bot.id, telegramUsernameNormalized: ownerNorm }
            },
            create: {
              botInstanceId: bot.id,
              telegramUsernameRaw: ownerTelegramUsername,
              telegramUsernameNormalized: ownerNorm,
              role: "OWNER",
              status: "PENDING",
              grantedByUserId: superAdmin.id
            },
            update: {
              telegramUsernameRaw: ownerTelegramUsername,
              role: "OWNER",
              status: "PENDING",
              userId: null,
              revokedAt: null,
              activatedAt: null
            }
          });
        }

        return { bot, template };
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2002") {
        return renderErrorDashboard("Бот с таким токеном уже существует.", 409);
      }
      throw e;
    }

    await runtimeManager.startBotInstance(created.bot.id, { launch: true });

    return reply.redirect(`/backoffice?created=${encodeURIComponent(created.bot.id)}`, 303);
  });

  server.get("/backoffice/bots/:botId/settings", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";

    const botId = String((req.params as any)?.botId ?? "");
    if (!botId) return reply.code(400).send("Missing botId");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) {
      return reply.code(403).send("Forbidden");
    }

    const activeTemplate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id, isActive: true },
      select: { id: true, title: true, baseLanguageCode: true, isActive: true }
    });

    const canWrite = canPerform(role, "bot_settings:write");
    const canManageRoles = canPerform(role, "bot_roles:manage");
    const canPauseResume = canPerform(role, "bot_lifecycle:pause_resume");
    const canArchiveDelete = canPerform(role, "bot_lifecycle:archive_delete");
    const lang = getBackofficeLang(req);

    return reply.type("text/html").send(
      renderPage(
        "Bot settings",
        `<h2 style="margin-top:0">Настройки бота</h2>
         <div class="small">BotInstance ID: <code>${escapeHtml(bot.id)}</code></div>
         <div style="margin-top:8px" class="small">status: <code>${escapeHtml(bot.status)}</code> · archived: <code>${bot.isArchived ? "true" : "false"}</code></div>
         <div class="small" style="margin-top:2px">createdAt: ${bot.createdAt.toISOString()} · updatedAt: ${bot.updatedAt.toISOString()}</div>
         <div class="small" style="margin-top:2px">paidAccessEnabled: <code>${bot.paidAccessEnabled ? "true" : "false"}</code></div>
         
         <div style="margin-top:16px" class="card">
           <h3 style="margin-top:0">Техническая информация шаблона</h3>
           <div class="small">Active template:</div>
           <div class="small" style="margin-top:6px">
             ${activeTemplate ? `id: <code>${escapeHtml(activeTemplate.id)}</code> · baseLanguageCode: <code>${escapeHtml(activeTemplate.baseLanguageCode)}</code> · title: ${escapeHtml(activeTemplate.title)}` : "—"}
           </div>
         </div>

         <div style="margin-top:16px" class="card">
           <h3 style="margin-top:0">Основные параметры</h3>
           ${
             canWrite
               ? `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/settings/basic" style="margin-top:12px">
                    <div style="margin-bottom:10px">
                      <label>Название бота</label>
                      <input name="name" type="text" value="${escapeHtml(bot.name)}" required />
                    </div>
                    <div style="margin-bottom:10px">
                      <label>Telegram Username (опционально)</label>
                      <input name="telegramBotUsername" type="text" value="${escapeHtml(bot.telegramBotUsername ?? "")}" placeholder="my_bot" />
                    </div>
                    <div style="margin-bottom:10px">
                      <label>Базовый язык</label>
                      <select name="baseLanguageCode">
                        ${i18n.availableLanguages().map((l) => `<option value="${escapeHtml(l.code)}" ${activeTemplate?.baseLanguageCode === l.code ? "selected" : ""}>${escapeHtml(l.label)}</option>`).join("\n")}
                      </select>
                    </div>
                    <button type="submit">Сохранить</button>
                  </form>`
               : `<div class="error">Недостаточно прав для изменения настроек.</div>`
           }

           ${
             canWrite
               ? `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/settings/token" style="margin-top:16px">
                    <div style="margin-bottom:10px">
                      <label>Новый Telegram Bot Token</label>
                      <input name="telegramBotToken" type="text" required />
                    </div>
                    <div style="margin-bottom:10px">
                      <label>Telegram Username (опционально)</label>
                      <input name="telegramBotUsername" type="text" value="${escapeHtml(bot.telegramBotUsername ?? "")}" placeholder="my_bot" />
                    </div>
                    <button type="submit">Обновить токен</button>
                  </form>`
               : ""
           }
         </div>

         <div style="margin-top:16px" class="card">
           <h3 style="margin-top:0">Жизненный цикл</h3>
           ${
             canPauseResume
               ? `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/lifecycle/pause" style="margin-top:12px">
                    <button type="submit">Пауза (DISABLED)</button>
                  </form>
                  <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/lifecycle/resume" style="margin-top:12px">
                    <button type="submit">Включить (ACTIVE)</button>
                  </form>`
               : `<div class="error">Недостаточно прав для управления статусом.</div>`
           }

           ${
             canArchiveDelete
               ? `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/lifecycle/archive" style="margin-top:12px">
                    <div style="margin-bottom:10px">
                      <label>Подтвердите архивирование (введите ARCHIVE)</label>
                      <input name="confirmText" type="text" required />
                    </div>
                    <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45);">Архивировать</button>
                  </form>
                  <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/lifecycle/delete" style="margin-top:12px">
                    <div style="margin-bottom:10px">
                      <label>Подтвердите удаление (введите DELETE)</label>
                      <input name="confirmText" type="text" required />
                    </div>
                    <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45);">Удалить</button>
                  </form>`
               : ""
           }
           
          ${
            canManageRoles
              ? `<div style="margin-top:16px" class="small">
                   ${escapeHtml(i18n.t(lang, "bo_roles_manage_hint"))}
                   <a href="/backoffice/bots/${escapeHtml(bot.id)}/roles">/backoffice/bots/${escapeHtml(bot.id)}/roles</a>
                 </div>`
              : `<div style="margin-top:10px" class="error">${escapeHtml(i18n.t(lang, "bo_roles_manage_denied"))}</div>`
          }
           
           <div style="margin-top:16px" class="small">
             Paid access и блокировки контента настраиваются в разделе:
             <a href="/backoffice/bots/${escapeHtml(bot.id)}/paid">/backoffice/bots/${escapeHtml(bot.id)}/paid</a>
           </div>
         </div>
         
         <div style="margin-top:16px" class="row">
           <a href="/backoffice" style="text-decoration:none"><button class="secondary" type="button">Назад</button></a>
         </div>`
      )
    );
  });

  server.post("/backoffice/api/bots/:botId/settings/basic", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_settings:write")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const body = req.body as any;
    const name = String(body?.name ?? "").trim();
    const telegramBotUsername = String(body?.telegramBotUsername ?? "").trim().replace(/^@/, "");
    const baseLanguageCode = String(body?.baseLanguageCode ?? "ru").trim().toLowerCase();

    if (!botId || !name) return reply.code(400).send("Bad request");
    const allowedBaseCodes = new Set(i18n.availableLanguages().map((l) => l.code));
    if (!allowedBaseCodes.has(baseLanguageCode as SupportedDictionaryLanguage)) return reply.code(400).send("Unsupported baseLanguageCode");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const activeTemplate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id, isActive: true },
      select: { id: true }
    });
    if (!activeTemplate) return reply.code(409).send("Active template missing");

    await prisma.$transaction([
      prisma.botInstance.update({
        where: { id: bot.id },
        data: {
          name,
          telegramBotUsername: telegramBotUsername || null
        }
      }),
      prisma.presentationTemplate.update({
        where: { id: activeTemplate.id },
        data: { baseLanguageCode }
      })
    ]);

    return reply.redirect(`/backoffice/bots/${bot.id}/settings`);
  });

  server.post("/backoffice/api/bots/:botId/settings/token", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_settings:write")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const body = req.body as any;
    const token = String(body?.telegramBotToken ?? "").trim();
    let telegramBotUsername = String(body?.telegramBotUsername ?? "").trim().replace(/^@/, "");

    if (!botId || !token) return reply.code(400).send("Bad request");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    // Validate token via Telegram getMe first.
    try {
      const me = await tokenValidateViaTelegram(token);
      if (!telegramBotUsername && me.username) telegramBotUsername = me.username;
    } catch (e) {
      return reply.code(400).type("text/html").send(renderPage("Update token", `<div class="error">Токен невалиден: ${(e as any)?.message ?? "unknown error"}</div>`));
    }

    const encryptedToken = encryptTelegramBotToken(token, env.BOT_TOKEN_ENCRYPTION_KEY);

    await prisma.botInstance.update({
      where: { id: bot.id },
      data: {
        telegramBotTokenEncrypted: encryptedToken,
        telegramBotUsername: telegramBotUsername || null
      }
    });

    if (bot.status === "ACTIVE" && !bot.isArchived) {
      await runtimeManager.restartBotInstance(bot.id);
    }

    return reply.redirect(`/backoffice/bots/${bot.id}/settings`);
  });

  server.post("/backoffice/api/bots/:botId/lifecycle/pause", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_lifecycle:pause_resume")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    await prisma.botInstance.update({
      where: { id: bot.id },
      data: { status: "DISABLED" }
    });

    await runtimeManager.stopBotInstance(bot.id);
    return reply.redirect(`/backoffice/bots/${bot.id}/settings`);
  });

  server.post("/backoffice/api/bots/:botId/lifecycle/resume", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_lifecycle:pause_resume")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    await prisma.$transaction([
      prisma.botInstance.update({
        where: { id: bot.id },
        data: { status: "ACTIVE", isArchived: false }
      }),
      prisma.presentationTemplate.updateMany({
        where: { botInstanceId: bot.id },
        data: { isActive: false }
      })
    ]);

    const templateToActivate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id },
      orderBy: { createdAt: "desc" },
      select: { id: true }
    });
    if (templateToActivate) {
      await prisma.presentationTemplate.update({
        where: { id: templateToActivate.id },
        data: { isActive: true }
      });
    }

    await runtimeManager.startBotInstance(bot.id, { launch: true });
    return reply.redirect(`/backoffice/bots/${bot.id}/settings`);
  });

  server.post("/backoffice/api/bots/:botId/lifecycle/archive", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_lifecycle:archive_delete")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const body = req.body as any;
    const confirmText = String(body?.confirmText ?? "").trim();
    if (confirmText !== "ARCHIVE") return reply.code(400).send("Bad confirmation");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    await prisma.$transaction([
      prisma.botInstance.update({
        where: { id: bot.id },
        data: { isArchived: true, status: "DISABLED" }
      }),
      prisma.presentationTemplate.updateMany({
        where: { botInstanceId: bot.id },
        data: { isActive: false }
      })
    ]);

    await runtimeManager.stopBotInstance(bot.id);
    return reply.redirect(`/backoffice/bots/${bot.id}/settings`);
  });

  server.post("/backoffice/api/bots/:botId/lifecycle/delete", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_lifecycle:archive_delete")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const body = req.body as any;
    const confirmText = String(body?.confirmText ?? "").trim();
    if (confirmText !== "DELETE") return reply.code(400).send("Bad confirmation");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    await runtimeManager.stopBotInstance(bot.id);
    await prisma.botInstance.delete({ where: { id: bot.id } });

    return reply.redirect("/backoffice");
  });

  server.get("/backoffice/bots/:botId/clone", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_clone:create")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const sourceBot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!sourceBot) return reply.code(404).send("Bot not found");
    if (sourceBot.ownerBackofficeUserId && sourceBot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const activeTemplate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: sourceBot.id, isActive: true },
      select: { baseLanguageCode: true }
    });

    return reply.type("text/html").send(
      renderPage(
        "Clone bot",
        `<h2 style="margin-top:0">Клонировать шаблон</h2>
         <div class="small">Источник: BotInstance ID <code>${escapeHtml(sourceBot.id)}</code></div>
         <div class="small" style="margin-top:4px">baseLanguageCode: <code>${escapeHtml(activeTemplate?.baseLanguageCode ?? "ru")}</code></div>
         <form method="POST" action="/backoffice/api/bots/${escapeHtml(sourceBot.id)}/clone" style="margin-top:16px">
           <div style="margin-bottom:10px">
             <label>Название нового бота</label>
             <input name="name" type="text" required />
           </div>
           <div style="margin-bottom:10px">
             <label>Telegram Bot Token</label>
             <input name="telegramBotToken" type="text" required />
           </div>
           <div style="margin-bottom:10px">
             <label>Telegram Username (опционально)</label>
             <input name="telegramBotUsername" type="text" placeholder="my_bot" />
           </div>
           <div style="margin-bottom:10px">
             <label>Paid access enabled</label>
             <select name="paidAccessEnabled">
               <option value="true" ${sourceBot.paidAccessEnabled ? "selected" : ""}>true</option>
               <option value="false" ${!sourceBot.paidAccessEnabled ? "selected" : ""}>false</option>
             </select>
           </div>
           <button type="submit">Создать клон</button>
         </form>
         <div class="small" style="margin-top:10px">
           Токен не отображается после сохранения. Валидатор использует <code>getMe</code>.
         </div>
         <div style="margin-top:16px" class="row">
           <a href="/backoffice/bots/${escapeHtml(sourceBot.id)}/settings" style="text-decoration:none"><button class="secondary" type="button">Назад</button></a>
         </div>`
      )
    );
  });

  server.post("/backoffice/api/bots/:botId/clone", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "bot_clone:create")) return reply.code(403).send("Forbidden");

    const sourceBotId = String((req.params as any)?.botId ?? "");
    const body = req.body as any;
    const name = String(body?.name ?? "").trim();
    const token = String(body?.telegramBotToken ?? "").trim();
    let telegramBotUsername = String(body?.telegramBotUsername ?? "").trim().replace(/^@/, "");
    const paidAccessEnabled = String(body?.paidAccessEnabled ?? "true").trim() === "true";

    if (!sourceBotId || !name || !token) return reply.code(400).send("Bad request");

    const sourceBot = await prisma.botInstance.findUnique({ where: { id: sourceBotId } });
    if (!sourceBot) return reply.code(404).send("Bot not found");
    if (sourceBot.ownerBackofficeUserId && sourceBot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    try {
      const me = await tokenValidateViaTelegram(token);
      if (!telegramBotUsername && me.username) telegramBotUsername = me.username;
    } catch (e) {
      return reply.code(400).type("text/html").send(renderPage("Clone bot", `<div class="error">Токен невалиден: ${(e as any)?.message ?? "unknown error"}</div>`));
    }

    const tokenHash = hashTelegramBotToken(token);
    const existingByHash = await prisma.botInstance.findUnique({
      where: { telegramBotTokenHash: tokenHash }
    });
    if (existingByHash) {
      return reply.code(409).type("text/html").send(renderPage("Clone bot", `<div class="error">Бот с таким токеном уже существует.</div>`));
    }

    const encryptedToken = encryptTelegramBotToken(token, env.BOT_TOKEN_ENCRYPTION_KEY);

    const cloneSvc = new BotCloneService(prisma);
    let cloned: { newBotInstanceId: string; newTemplateId: string };
    try {
      cloned = await cloneSvc.cloneBot({
        sourceBotInstanceId: sourceBot.id,
        actorBackofficeUserId: backofficeUserId!,
        newBot: {
          name,
          telegramBotTokenEncrypted: encryptedToken,
          telegramBotTokenHash: tokenHash,
          telegramBotUsername: telegramBotUsername || null,
          paidAccessEnabled,
          isArchived: false
        }
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2002") {
        return reply.code(409).type("text/html").send(renderPage("Clone bot", `<div class="error">Бот с таким токеном уже существует.</div>`));
      }
      return reply.code(500).type("text/html").send(renderPage("Clone bot", `<div class="error">Clone failed: ${(e as any)?.message ?? "unknown error"}</div>`));
    }

    await runtimeManager.startBotInstance(cloned.newBotInstanceId, { launch: true });
    const clonedBot = await prisma.botInstance.findUnique({
      where: { id: cloned.newBotInstanceId },
      select: { telegramBotUsername: true }
    });
    const openUrl = clonedBot?.telegramBotUsername ? `https://t.me/${clonedBot.telegramBotUsername}` : "#";
    return reply.type("text/html").send(
      renderPage(
        "Bot cloned",
        `<h2 style="margin-top:0">Клон создан</h2>
         <div class="small">New bot instance: <code>${escapeHtml(cloned.newBotInstanceId)}</code></div>
         <div class="small" style="margin-top:10px">Дальше конфигурируйте структуру внутри Telegram через существующий конструктор.</div>
         <div style="margin-top:14px" class="row">
           <a href="${openUrl}" target="_blank" style="text-decoration:none"><button type="button">Открыть в Telegram</button></a>
           <a href="/backoffice" style="text-decoration:none"><button class="secondary" type="button">На dashboard</button></a>
         </div>`
      )
    );
  });

  // ------------------------------
  // Paid access back-office (per bot)
  // ------------------------------

  server.get("/backoffice/bots/:botId/paid", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const simulateOk = (req.query as any)?.simulateOk === "1";
    const simulateError = String((req.query as any)?.simulateError ?? "").trim();

    const template = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id, isActive: true },
      select: { id: true, baseLanguageCode: true }
    });
    if (!template) return reply.code(409).send("Active template missing");

    const baseLang = template.baseLanguageCode;

    const productRows = await prisma.menuItem.findMany({
      where: { templateId: template.id, productId: { not: null } },
      select: { productId: true },
      distinct: ["productId"]
    });
    const productIdSet = new Set(productRows.map((r) => String(r.productId)));

    const products = await prisma.product.findMany({
      where: productIdSet.size ? { id: { in: Array.from(productIdSet) }, isActive: true } : { isActive: true },
      include: {
        localizations: {
          where: { languageCode: baseLang },
          select: { title: true, description: true, payButtonText: true }
        }
      }
    });

    const productLabelById = new Map<string, string>();
    for (const p of products) {
      productLabelById.set(p.id, p.localizations[0]?.title ?? p.code);
    }

    const menuItems = await prisma.menuItem.findMany({
      where: { templateId: template.id, isActive: true },
      select: {
        id: true,
        key: true,
        productId: true,
        accessRuleId: true,
        visibilityMode: true,
        localizations: {
          where: { languageCode: baseLang },
          select: { title: true }
        }
      },
      orderBy: { sortOrder: "asc" }
    });

    const productSelectOptions = products.length
      ? products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(productLabelById.get(p.id) ?? p.code)}</option>`).join("")
      : `<option value="" disabled>— Сначала создайте продукт внизу —</option>`;

    const botUsers = await prisma.user.findMany({
      where: { botInstanceId: bot.id },
      select: { id: true, fullName: true, username: true, telegramUserId: true },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    const userSelectOptions = botUsers.map((u) => {
      const label = [u.fullName, u.username ? `@${u.username}` : ""].filter(Boolean).join(" ") || String(u.telegramUserId);
      return `<option value="${escapeHtml(u.id)}">${escapeHtml(label)}</option>`;
    }).join("");

    return reply.type("text/html").send(
      renderPage(
        "Платный доступ",
        `<h2 style="margin-top:0">Платный доступ</h2>
         <div class="small" style="margin-top:6px">Bot: <code>${escapeHtml(bot.id)}</code></div>
         ${simulateOk ? `<div class="success" style="margin-top:12px">Тест-оплата выполнена. Проверьте бота — пользователь получил доступ. Через N минут (если указали минуты) его исключат из чата/канала.</div>` : ""}
         ${simulateError ? `<div class="error" style="margin-top:12px">Ошибка тест-оплаты: ${escapeHtml(simulateError)}</div>` : ""}

         <div class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Глобальное включение</h3>
           <p class="small" style="margin:0 0 12px 0">Включить или выключить платные разделы для всего бота.</p>
           <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/toggle" class="form-row">
             <div class="field">
               <label class="small">Режим</label>
               <select name="paidAccessEnabled" class="field">
                 <option value="true" ${bot.paidAccessEnabled ? "selected" : ""}>Включено</option>
                 <option value="false" ${!bot.paidAccessEnabled ? "selected" : ""}>Выключено</option>
               </select>
             </div>
             <div class="btn"><button type="submit">Сохранить</button></div>
           </form>
         </div>

         <div class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Блокировка пунктов меню</h3>
           <p class="small" style="margin:0 0 12px 0">Привяжите продукт к разделу — доступ откроется только после оплаты.</p>
           ${
             menuItems.length
               ? `<table class="paid-table">
                   <thead><tr><th>Раздел</th><th>Продукт</th><th style="width:180px">Действие</th></tr></thead>
                   <tbody>
                   ${menuItems
                     .map((mi) => {
                       const title = mi.localizations[0]?.title ?? mi.key;
                       const locked = Boolean(mi.productId);
                       const productLabel = mi.productId ? productLabelById.get(mi.productId) ?? mi.productId : null;
                       return locked
                         ? `<tr>
                             <td><b>${escapeHtml(title)}</b></td>
                             <td><code>${escapeHtml(productLabel ?? "")}</code></td>
                             <td>
                               <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/menu-items/${escapeHtml(mi.id)}/unlock" style="display:inline">
                                 <button type="submit" class="secondary">Снять блокировку</button>
                               </form>
                             </td>
                           </tr>`
                         : `<tr>
                             <td><b>${escapeHtml(title)}</b></td>
                             <td>
                               <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/menu-items/${escapeHtml(mi.id)}/lock" class="form-row" style="margin:0; max-width:320px">
                                 <div class="field" style="flex:1; min-width:0">
                                   <select name="productId" required class="field" style="width:100%">
                                     ${productSelectOptions}
                                   </select>
                                 </div>
                                 <div class="btn"><button type="submit">Заблокировать</button></div>
                               </form>
                             </td>
                             <td>—</td>
                           </tr>`;
                     })
                     .join("")}
                   </tbody>
                 </table>`
               : `<div class="small">Нет пунктов меню.</div>`
           }
         </div>

         <div class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Продукты</h3>

           <div class="section-title">Создать продукт</div>
           <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/create">
             <div class="product-form-grid">
               <div class="field-wrap"><label class="small">Название (ru)</label><input name="titleRu" type="text" required /></div>
               <div class="field-wrap"><label class="small">Текст кнопки (ru)</label><input name="payButtonTextRu" type="text" required placeholder="Оплатить" /></div>
               <div class="field-wrap"><label class="small">Цена</label><input name="price" type="text" required value="10" /></div>
               <div class="field-wrap"><label class="small">Валюта</label><input name="currency" type="text" required value="USDT" /></div>
               <div class="field-wrap"><label class="small">Тип</label>
                 <select name="billingType" style="width:100%; box-sizing:border-box">
                   <option value="ONE_TIME">Разовая оплата</option>
                   <option value="TEMPORARY">Подписка (на N дней)</option>
                 </select>
               </div>
               <div class="field-wrap"><label class="small">Дней доступа</label><input name="durationDays" type="number" min="1" placeholder="30" style="width:100%; box-sizing:border-box" /></div>
             </div>
             <div class="test-block" style="margin-top:12px">
               <div class="small" style="margin-bottom:6px; color:rgba(251,191,36,0.9)">🧪 Тест: минуты вместо дней</div>
               <input name="durationMinutes" type="number" min="1" max="1440" placeholder="пусто = дни" style="max-width:120px; box-sizing:border-box" title="1–5 мин для быстрой проверки" />
             </div>
             <div style="margin-top:12px">
               <label class="small">Ссылки на чат/канал (каждая с новой строки)</label>
               <textarea name="linkedChatsRaw" rows="2" placeholder="https://t.me/channel" style="margin-top:4px"></textarea>
             </div>
             <div style="margin-top:10px">
               <label class="small">Описание (ru)</label>
               <textarea name="descriptionRu" rows="2" style="margin-top:4px"></textarea>
             </div>
             <button type="submit" style="margin-top:12px">Создать</button>
           </form>

           <div class="products-existing-block">
           <div class="section-title">Существующие продукты</div>
           ${products.length ? products.map((p) => {
                const ruLoc = p.localizations.find((l: any) => l.languageCode === "ru") ?? p.localizations[0];
                const durMin = (p as any).durationMinutes;
                const testActive = durMin != null && String(durMin).trim() !== "";
                return `<div class="product-card">
                <div class="product-card-header">
                  <span><b>${escapeHtml(ruLoc?.title ?? p.code)}</b></span>
                  <span class="small">${escapeHtml(String(p.price))} ${escapeHtml(p.currency)} · ${p.billingType === "TEMPORARY" ? (p.durationDays ? `${p.durationDays} дн.` : "") : "Разовая"}${testActive ? ` · ${durMin} мин` : ""}</span>
                  ${testActive ? '<span class="test-badge">🧪 ТЕСТ ВКЛ</span>' : ""}
                  <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(p.id)}/archive" style="margin-left:auto">
                    <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45);">Архивировать</button>
                  </form>
                </div>
                <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(p.id)}/update">
                  <div class="section-title">Основные параметры</div>
                  <div class="product-form-grid">
                    <div class="field-wrap"><label class="small">Название (ru)</label><input name="titleRu" type="text" required value="${escapeHtml(ruLoc?.title ?? "")}" style="width:100%; box-sizing:border-box" /></div>
                    <div class="field-wrap"><label class="small">Текст кнопки (ru)</label><input name="payButtonTextRu" type="text" required value="${escapeHtml(ruLoc?.payButtonText ?? "")}" style="width:100%; box-sizing:border-box" /></div>
                    <div class="field-wrap"><label class="small">Цена</label><input name="price" type="text" required value="${escapeHtml(String(p.price ?? ""))}" style="width:100%; box-sizing:border-box" /></div>
                    <div class="field-wrap"><label class="small">Валюта</label><input name="currency" type="text" required value="${escapeHtml(p.currency ?? "USDT")}" style="width:100%; box-sizing:border-box" /></div>
                    <div class="field-wrap"><label class="small">Тип</label>
                      <select name="billingType" style="width:100%; box-sizing:border-box">
                        <option value="ONE_TIME" ${p.billingType === "ONE_TIME" ? "selected" : ""}>Разовая</option>
                        <option value="TEMPORARY" ${p.billingType === "TEMPORARY" ? "selected" : ""}>Подписка</option>
                      </select>
                    </div>
                    <div class="field-wrap"><label class="small">Дней доступа</label><input name="durationDays" type="number" min="1" value="${p.durationDays ?? ""}" placeholder="30" style="width:100%; box-sizing:border-box" /></div>
                  </div>

                  <div class="section-title">🧪 Тестовый режим</div>
                  <div class="test-block">
                    <div class="field-wrap" style="max-width:200px">
                      <label class="small">Минуты вместо дней ${testActive ? '<span class="test-badge" style="margin-left:8px">ВКЛ</span>' : ""}</label>
                      <input name="durationMinutes" type="number" min="1" max="1440" value="${p.durationMinutes ?? ""}" placeholder="пусто = дни" style="width:100%; box-sizing:border-box" title="1–5 мин для быстрой проверки подписки" />
                    </div>
                    <div class="small" style="margin-top:6px">Укажите 1 или 5 — подписка истечёт через минуты. Напоминания (3/2/1 день) не отправятся.</div>
                  </div>

                  <div class="section-title">Ссылки на чат/канал</div>
                  <textarea name="linkedChatsRaw" rows="2" placeholder="https://t.me/channel&#10;https://t.me/joinchat/xxx" style="width:100%; box-sizing:border-box">${formatLinkedChatsForEdit(p.linkedChats)}</textarea>
                  <div class="small" style="margin-top:4px">t.me/channel, t.me/+invite или ID. После оплаты появятся кнопки перехода.</div>

                  <div class="section-title">Описание (ru)</div>
                  <textarea name="descriptionRu" rows="2" style="width:100%; box-sizing:border-box">${escapeHtml(ruLoc?.description ?? "")}</textarea>

                  <button type="submit" style="margin-top:16px">Сохранить</button>
                </form>

                <div class="section-title">Симуляция оплаты</div>
                <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(p.id)}/simulate-payment" class="form-row">
                  <div class="field" style="min-width:200px; max-width:300px">
                    <select name="userId" required style="width:100%; box-sizing:border-box">
                      <option value="">— Выберите пользователя —</option>
                      ${userSelectOptions}
                    </select>
                  </div>
                  <div class="btn"><button type="submit" class="secondary">Выполнить тест-оплату</button></div>
                </form>
                <div class="small" style="margin-top:4px">Без реального платежа: выдаст доступ, отправит в чат/канал, через N минут исключит.</div>
               </div>`;
             }).join("") : `<div class="small">Нет продуктов. Создайте первый в форме выше.</div>`}
           </div>
           </div>
         </div>

         <div style="margin-top:16px" class="row">
           <a href="/backoffice/bots/${escapeHtml(bot.id)}/settings" style="text-decoration:none"><button class="secondary" type="button">Назад</button></a>
         </div>
        `
      )
    );
  });

  server.post("/backoffice/api/bots/:botId/paid/toggle", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const paidAccessEnabled = String(body?.paidAccessEnabled ?? "true") === "true";

    await prisma.botInstance.update({ where: { id: bot.id }, data: { paidAccessEnabled } });

    if (bot.status === "ACTIVE" && !bot.isArchived) {
      await runtimeManager.restartBotInstance(bot.id);
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid`);
  });

  server.post("/backoffice/api/bots/:botId/paid/products/create", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const titleRu = String(body?.titleRu ?? "").trim();
    const descriptionRu = String(body?.descriptionRu ?? "").trim();
    const payButtonTextRu = String(body?.payButtonTextRu ?? "").trim();
    const price = String(body?.price ?? "").trim();
    const currency = String(body?.currency ?? "USDT").trim();
    const billingType = String(body?.billingType ?? "ONE_TIME").trim() as "ONE_TIME" | "TEMPORARY";
    const durationDaysRaw = body?.durationDays;
    const durationDays = durationDaysRaw != null && String(durationDaysRaw).trim() !== "" ? parseInt(String(durationDaysRaw), 10) : null;
    const durationMinutesRaw = body?.durationMinutes;
    const durationMinutes = durationMinutesRaw != null && String(durationMinutesRaw).trim() !== "" ? parseInt(String(durationMinutesRaw), 10) : null;
    const linkedChatsRaw = String(body?.linkedChatsRaw ?? "").trim();
    const linkedChats = linkedChatsRaw ? parseLinkedChatsFromForm(linkedChatsRaw) : [];

    if (!titleRu || !payButtonTextRu || !price || !currency) return reply.code(400).send("Bad request");

    const code = `bot_${bot.id.slice(0, 8)}_${randomBytes(4).toString("hex")}`;

    await prisma.product.create({
      data: {
        code,
        type: "SECTION",
        price,
        currency,
        billingType: billingType === "TEMPORARY" ? "TEMPORARY" : "ONE_TIME",
        durationDays: billingType === "TEMPORARY" && durationDays != null && durationDays > 0 ? durationDays : null,
        durationMinutes: durationMinutes != null && durationMinutes > 0 ? durationMinutes : null,
        linkedChats: linkedChats.length ? (linkedChats as any) : null,
        isActive: true,
        localizations: {
          createMany: {
            data: [
              { languageCode: "ru", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
              { languageCode: "en", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
              { languageCode: "de", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
              { languageCode: "uk", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu }
            ]
          }
        }
      }
    });

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid`);
  });

  server.post("/backoffice/api/bots/:botId/paid/products/:productId/archive", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const productId = String((req.params as any)?.productId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid`);
  });

  server.post("/backoffice/api/bots/:botId/paid/products/:productId/update", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const productId = String((req.params as any)?.productId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const titleRu = String(body?.titleRu ?? "").trim();
    const descriptionRu = String(body?.descriptionRu ?? "").trim();
    const payButtonTextRu = String(body?.payButtonTextRu ?? "").trim();
    const price = String(body?.price ?? "").trim();
    const currency = String(body?.currency ?? "").trim();
    const billingType = (String(body?.billingType ?? "ONE_TIME").trim() === "TEMPORARY" ? "TEMPORARY" : "ONE_TIME") as "ONE_TIME" | "TEMPORARY";
    const durationDaysRaw = body?.durationDays;
    const durationDays = durationDaysRaw != null && String(durationDaysRaw).trim() !== "" ? parseInt(String(durationDaysRaw), 10) : null;
    const durationMinutesRaw = body?.durationMinutes;
    const durationMinutes = durationMinutesRaw != null && String(durationMinutesRaw).trim() !== "" ? parseInt(String(durationMinutesRaw), 10) : null;
    const linkedChatsRaw = String(body?.linkedChatsRaw ?? "").trim();
    const linkedChats = linkedChatsRaw ? parseLinkedChatsFromForm(linkedChatsRaw) : [];

    if (!titleRu || !payButtonTextRu || !price || !currency) return reply.code(400).send("Bad request");

    const activeTemplate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id, isActive: true },
      select: { id: true }
    });
    if (!activeTemplate) return reply.code(409).send("Active template missing");

    const usesProduct = await prisma.menuItem.findFirst({
      where: { templateId: activeTemplate.id, productId }
    });
    if (!usesProduct) return reply.code(404).send("Product not attached to this bot");

    await prisma.$transaction([
      prisma.product.update({
        where: { id: productId },
        data: {
          price,
          currency,
          billingType,
          durationDays: billingType === "TEMPORARY" && durationDays != null && durationDays > 0 ? durationDays : null,
          durationMinutes: durationMinutes != null && durationMinutes > 0 ? durationMinutes : null,
          linkedChats: linkedChats.length ? (linkedChats as any) : null
        }
      }),
      prisma.productLocalization.upsert({
        where: { productId_languageCode: { productId, languageCode: "ru" } },
        update: { title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
        create: { productId, languageCode: "ru", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu }
      }),
      prisma.productLocalization.upsert({
        where: { productId_languageCode: { productId, languageCode: "en" } },
        update: { title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
        create: { productId, languageCode: "en", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu }
      }),
      prisma.productLocalization.upsert({
        where: { productId_languageCode: { productId, languageCode: "de" } },
        update: { title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
        create: { productId, languageCode: "de", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu }
      }),
      prisma.productLocalization.upsert({
        where: { productId_languageCode: { productId, languageCode: "uk" } },
        update: { title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu },
        create: { productId, languageCode: "uk", title: titleRu, description: descriptionRu, payButtonText: payButtonTextRu }
      })
    ]);

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid`);
  });

  server.post("/backoffice/api/bots/:botId/paid/products/:productId/simulate-payment", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const productId = String((req.params as any)?.productId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const userId = String(body?.userId ?? "").trim();
    if (!userId) return reply.code(400).send("Bad request: userId required");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);
    const runtime = await runtimeManager.startBotInstance(bot.id, { launch: false });

    try {
      await runtime.services.payments.simulatePaymentForTest(userId, productId, bot.id, superAdmin.id);
    } catch (e: any) {
      const msg = e?.message ?? "Error";
      return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid?simulateError=${encodeURIComponent(msg)}`);
    }
    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid?simulateOk=1`);
  });

  server.post("/backoffice/api/bots/:botId/paid/menu-items/:menuItemId/lock", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const menuItemId = String((req.params as any)?.menuItemId ?? "");
    const body = req.body as any;
    const productId = String(body?.productId ?? "");
    if (!productId) return reply.code(400).send("Bad request");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const activeTemplate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id, isActive: true },
      select: { id: true }
    });
    if (!activeTemplate) return reply.code(409).send("Active template missing");

    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, templateId: activeTemplate.id }
    });
    if (!menuItem) return reply.code(404).send("MenuItem not found");

    const purchaseRuleCode = `paid_purchase_${bot.id.slice(0, 8)}_${productId.slice(0, 8)}_${randomBytes(3).toString("hex")}`;
    const createdRule = await prisma.accessRule.create({
      data: {
        code: purchaseRuleCode,
        ruleType: "PRODUCT_PURCHASE",
        configJson: { productId },
        isActive: true
      }
    });

    await prisma.menuItem.update({
      where: { id: menuItem.id },
      data: {
        productId,
        accessRuleId: createdRule.id,
        visibilityMode: "SHOW"
      }
    });

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid`);
  });

  server.post("/backoffice/api/bots/:botId/paid/menu-items/:menuItemId/unlock", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "paid_access:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const menuItemId = String((req.params as any)?.menuItemId ?? "");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const activeTemplate = await prisma.presentationTemplate.findFirst({
      where: { botInstanceId: bot.id, isActive: true },
      select: { id: true }
    });
    if (!activeTemplate) return reply.code(409).send("Active template missing");

    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, templateId: activeTemplate.id }
    });
    if (!menuItem) return reply.code(404).send("MenuItem not found");

    await prisma.menuItem.update({
      where: { id: menuItem.id },
      data: {
        productId: null,
        accessRuleId: null,
        visibilityMode: "SHOW"
      }
    });

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid`);
  });

  // ------------------------------
  // Bot roles / team management (by Telegram username)
  // ------------------------------

  server.get("/backoffice/bots/:botId/roles", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    if (!botId) return reply.code(400).send("Missing botId");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const q = String((req.query as any)?.q ?? "").trim();
    const status = String((req.query as any)?.status ?? "").trim();
    const role = String((req.query as any)?.role ?? "").trim();
    const errorMsg = String((req.query as any)?.error ?? "").trim();

    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    const assignments = await roleSvc.listAssignments({
      q: q || undefined,
      status: status ? (status as any) : undefined,
      role: role ? (role as any) : undefined
    });

    const lang = getBackofficeLang(req);
    const t = (k: Parameters<typeof i18n.t>[1]) => i18n.t(lang, k);

    return reply.type("text/html").send(
      renderPage(
        "Bot roles / team",
        `<h2 style="margin-top:0">${escapeHtml(t("bo_roles_title"))}</h2>
         <div class="small">Bot: <code>${escapeHtml(bot.id)}</code></div>
         ${errorMsg ? `<div class="error" role="alert" style="margin-top:12px">${escapeHtml(errorMsg)}</div>` : ""}

         <div class="card" style="margin-top:16px">
           <h3 style="margin-top:0">${escapeHtml(t("bo_roles_assign_title"))}</h3>
           <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/roles/assign">
             <div style="margin-bottom:10px">
               <label>${escapeHtml(t("bo_roles_telegram_username_label"))}</label>
               <input name="telegramUsername" type="text" required placeholder="${escapeHtml(t("bo_roles_search_placeholder"))}" />
             </div>
             <div style="margin-bottom:10px">
               <label>${escapeHtml(t("bo_roles_role_label"))}</label>
               <select name="role" required>
                 <option value="OWNER">${escapeHtml(t("bo_roles_role_owner"))}</option>
                 <option value="ADMIN">${escapeHtml(t("bo_roles_role_admin"))}</option>
               </select>
             </div>
             <button type="submit">${escapeHtml(t("bo_roles_save"))}</button>
           </form>
           <div class="small" style="margin-top:10px">
             ${escapeHtml(t("bo_roles_pending_hint"))}
           </div>
         </div>

         <div class="card" style="margin-top:16px">
           <h3 style="margin-top:0">${escapeHtml(t("bo_roles_filters_title"))}</h3>
           <form method="GET" action="/backoffice/bots/${escapeHtml(bot.id)}/roles">
             <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px">
               <div>
                 <label class="small">${escapeHtml(t("bo_roles_search_label"))}</label>
                 <input name="q" type="text" value="${escapeHtml(q)}" placeholder="${escapeHtml(t("bo_roles_search_placeholder"))}" />
               </div>
               <div>
                 <label class="small">${escapeHtml(t("bo_roles_role_label"))}</label>
                 <select name="role">
                   <option value="" ${!role ? "selected" : ""}>${escapeHtml(t("bo_roles_filter_all"))}</option>
                   <option value="OWNER" ${role === "OWNER" ? "selected" : ""}>${escapeHtml(t("bo_roles_role_owner"))}</option>
                   <option value="ADMIN" ${role === "ADMIN" ? "selected" : ""}>${escapeHtml(t("bo_roles_role_admin"))}</option>
                 </select>
               </div>
               <div>
                 <label class="small">${escapeHtml(t("bo_roles_status_label"))}</label>
                 <select name="status">
                   <option value="" ${!status ? "selected" : ""}>${escapeHtml(t("bo_roles_filter_all"))}</option>
                   <option value="PENDING" ${status === "PENDING" ? "selected" : ""}>${escapeHtml(t("bo_roles_status_pending"))}</option>
                   <option value="ACTIVE" ${status === "ACTIVE" ? "selected" : ""}>${escapeHtml(t("bo_roles_status_active"))}</option>
                   <option value="REVOKED" ${status === "REVOKED" ? "selected" : ""}>${escapeHtml(t("bo_roles_status_revoked"))}</option>
                 </select>
               </div>
             </div>
             <button type="submit" style="margin-top:10px">${escapeHtml(t("bo_roles_apply"))}</button>
           </form>
         </div>

         <div class="card" style="margin-top:16px">
           <h3 style="margin-top:0">${escapeHtml(t("bo_roles_current_title"))}</h3>
           ${
             assignments.length
               ? assignments
                   .map((a) => {
                     const usernameLabel = `@${a.telegramUsernameNormalized}`;
                     const userIdLabel = a.userId ? a.userId : "—";
                     return `<div style="margin-top:12px; padding:12px; border:1px solid rgba(255,255,255,0.12); border-radius:12px; background:rgba(255,255,255,0.04)">
                       <div><b>${escapeHtml(usernameLabel)}</b></div>
                       <div class="small" style="margin-top:6px">role: <code>${escapeHtml(a.role)}</code> · status: <code>${escapeHtml(a.status)}</code></div>
                       <div class="small" style="margin-top:4px">userId: <code>${escapeHtml(userIdLabel)}</code></div>
                       <div class="small" style="margin-top:4px">updatedAt: <code>${escapeHtml(a.updatedAt.toISOString())}</code></div>

                       <div style="margin-top:10px">
                         <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/roles/${escapeHtml(a.id)}/role" style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap">
                           <div style="flex: 1 1 220px">
                             <label class="small">${escapeHtml(t("bo_roles_change_role"))}</label>
                             <select name="newRole" required>
                               <option value="OWNER" ${a.role === "OWNER" ? "selected" : ""}>${escapeHtml(t("bo_roles_role_owner"))}</option>
                               <option value="ADMIN" ${a.role === "ADMIN" ? "selected" : ""}>${escapeHtml(t("bo_roles_role_admin"))}</option>
                             </select>
                           </div>
                           <button type="submit" class="secondary" style="height:44px; margin-bottom:2px">${escapeHtml(t("bo_roles_change_btn"))}</button>
                         </form>
                       </div>

                       <div style="margin-top:10px">
                         <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/roles/${escapeHtml(a.id)}/recheck" style="display:inline">
                           ${
                             a.status === "PENDING"
                               ? `<button type="submit" class="secondary">${escapeHtml(t("bo_roles_recheck_btn"))}</button>`
                               : ""
                           }
                          </form>
                         ${
                           a.status === "PENDING"
                             ? `
                         <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/roles/${escapeHtml(a.id)}/activate-by-username" style="display:inline; margin-left:8px">
                           <input name="telegramUsername" type="text" placeholder="@username" required style="width:140px; padding:8px" />
                           <button type="submit" class="secondary" style="margin-left:4px">Активировать по username</button>
                         </form>
                         <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/roles/${escapeHtml(a.id)}/activate-by-telegram-id" style="display:inline; margin-left:8px">
                           <input name="telegramUserId" type="text" placeholder="Telegram ID" style="width:120px; padding:8px" />
                           <button type="submit" class="secondary" style="margin-left:4px">По ID</button>
                         </form>
                         <div class="small" style="margin-top:4px; color:#94a3b8">Если «Сверить» не сработало — введите @username или Telegram ID (из @userinfobot). Пользователь должен написать боту /start.</div>`
                             : ""
                         }
                       </div>

                       <div style="margin-top:10px">
                         <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/roles/${escapeHtml(a.id)}/revoke">
                           <div style="margin-bottom:8px">
                             <label class="small">${escapeHtml(t("bo_roles_confirm_revoke"))}</label>
                             <input name="confirmText" type="text" required />
                           </div>
                           <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45);">${escapeHtml(t("bo_roles_revoke_btn"))}</button>
                         </form>
                       </div>
                     </div>`;
                   })
                   .join("")
               : `<div class="small">${escapeHtml(t("bo_roles_no_assignments"))}</div>`
           }
         </div>

         <div style="margin-top:16px" class="row">
           <a href="/backoffice/bots/${escapeHtml(bot.id)}/settings" style="text-decoration:none"><button class="secondary" type="button">${escapeHtml(t("bo_roles_back"))}</button></a>
         </div>`
      )
    );
  });

  server.post("/backoffice/api/bots/:botId/roles/assign", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const telegramUsername = String(body?.telegramUsername ?? "").trim();
    const role = String(body?.role ?? "").trim();

    if (!telegramUsername || !["OWNER", "ADMIN"].includes(role)) return reply.code(400).send("Bad request");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);

    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    try {
      await roleSvc.assignRoleByTelegramUsername({
        actorUserId: superAdmin.id,
        telegramUsername,
        role: role as any
      });
    } catch (e: any) {
      const code = typeof e?.statusCode === "number" ? e.statusCode : 400;
      return reply.code(code).send(String(e?.message ?? "Error"));
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/roles`);
  });

  server.post("/backoffice/api/bots/:botId/roles/:assignmentId/role", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const assignmentId = String((req.params as any)?.assignmentId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const newRole = String(body?.newRole ?? "").trim();
    if (!["OWNER", "ADMIN"].includes(newRole)) return reply.code(400).send("Bad request");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);

    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    try {
      await roleSvc.changeRoleByAssignmentId({
        actorUserId: superAdmin.id,
        assignmentId,
        newRole: newRole as any
      });
    } catch (e: any) {
      const code = typeof e?.statusCode === "number" ? e.statusCode : 400;
      return reply.code(code).send(String(e?.message ?? "Error"));
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/roles`);
  });

  server.post("/backoffice/api/bots/:botId/roles/:assignmentId/revoke", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const assignmentId = String((req.params as any)?.assignmentId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const confirmText = String(body?.confirmText ?? "").trim();
    if (confirmText !== "REVOKE") return reply.code(400).send("Bad request");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);

    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    try {
      await roleSvc.revokeByAssignmentId({
        actorUserId: superAdmin.id,
        assignmentId
      });
    } catch (e: any) {
      const code = typeof e?.statusCode === "number" ? e.statusCode : 400;
      return reply.code(code).send(String(e?.message ?? "Error"));
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/roles`);
  });

  server.post("/backoffice/api/bots/:botId/roles/:assignmentId/recheck", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const assignmentId = String((req.params as any)?.assignmentId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);

    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    try {
      await roleSvc.recheckPendingByAssignmentId({
        actorUserId: superAdmin.id,
        assignmentId
      });
    } catch (e: any) {
      const code = typeof e?.statusCode === "number" ? e.statusCode : 400;
      return reply.code(code).send(String(e?.message ?? "Error"));
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/roles`);
  });

  server.post("/backoffice/api/bots/:botId/roles/:assignmentId/activate-by-username", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const assignmentId = String((req.params as any)?.assignmentId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const telegramUsername = String(body?.telegramUsername ?? "").trim();
    if (!telegramUsername) {
      return reply.redirect(`/backoffice/bots/${bot.id}/roles?error=${encodeURIComponent("Введите username")}`);
    }

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);
    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    try {
      await roleSvc.activatePendingByUsername({
        actorUserId: superAdmin.id,
        assignmentId,
        telegramUsername
      });
    } catch (e: any) {
      const msg = e?.message ?? "Error";
      return reply.redirect(`/backoffice/bots/${bot.id}/roles?error=${encodeURIComponent(msg)}`);
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/roles`);
  });

  server.post("/backoffice/api/bots/:botId/roles/:assignmentId/activate-by-telegram-id", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const backofficeRole = roleRow?.role ?? "ADMIN";
    if (!canPerform(backofficeRole, "bot_roles:manage")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const assignmentId = String((req.params as any)?.assignmentId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const body = req.body as any;
    const telegramUserId = String(body?.telegramUserId ?? "").trim();
    if (!telegramUserId || !/^\d+$/.test(telegramUserId)) {
      return reply.redirect(`/backoffice/bots/${bot.id}/roles?error=${encodeURIComponent("Введите числовой Telegram ID")}`);
    }

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);
    const audit = new AuditService(prisma);
    const users = new UserService(prisma, bot.id);
    const permissions = new PermissionService(prisma, users, audit, bot.id);
    const roleSvc = new BotRoleAssignmentService(prisma, bot.id, permissions, audit);

    try {
      await roleSvc.activatePendingByTelegramId({
        actorUserId: superAdmin.id,
        assignmentId,
        telegramUserId
      });
    } catch (e: any) {
      const msg = e?.message ?? "Error";
      return reply.redirect(`/backoffice/bots/${bot.id}/roles?error=${encodeURIComponent(msg)}`);
    }

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/roles`);
  });

  // ------------------------------
  // Manual payment confirmation (back-office)
  // ------------------------------

  server.get("/backoffice/bots/:botId/payments", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "payments:confirm_manual")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const payments = await prisma.payment.findMany({
      where: { botInstanceId: bot.id, status: { in: ["PENDING", "UNPAID"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        user: { select: { id: true, telegramUserId: true, selectedLanguage: true } },
        product: { select: { id: true, code: true, price: true, currency: true } }
      }
    });

    return reply.type("text/html").send(
      renderPage(
        "Payments (manual confirm)",
        `<h2 style="margin-top:0">Payments (manual confirm)</h2>
         <div class="small">Bot: <code>${escapeHtml(bot.id)}</code></div>
         <div class="small" style="margin-top:6px">${payments.length} payments pending</div>

         ${
           payments.length
             ? payments
                 .map((p) => {
                   return `<div style="margin-top:12px; padding:10px; border:1px solid rgba(255,255,255,0.12); border-radius:12px; background:rgba(255,255,255,0.04)">
                     <div><b>Payment</b> <code>${escapeHtml(p.id)}</code> · status <code>${escapeHtml(p.status)}</code></div>
                     <div class="small" style="margin-top:4px">user telegramUserId: <code>${escapeHtml(String(p.user.telegramUserId))}</code></div>
                     <div class="small" style="margin-top:4px">product: <code>${escapeHtml(p.product.code)}</code> · amount: <code>${escapeHtml(String(p.product.price))}</code> ${escapeHtml(p.product.currency)}</div>
                     <div class="small" style="margin-top:4px">referenceCode: <code>${escapeHtml(p.referenceCode)}</code></div>
                     <div style="margin-top:10px" class="row">
                       <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/payments/${escapeHtml(p.id)}/confirm" style="margin:0">
                         <button type="submit">Подтвердить</button>
                       </form>
                       <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/payments/${escapeHtml(p.id)}/reject" style="margin:0">
                         <input name="reason" type="text" placeholder="Причина (опционально)" />
                         <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45); margin-top:8px">Отклонить</button>
                       </form>
                     </div>
                   </div>`;
                 })
                 .join("")
             : `<div class="small" style="margin-top:10px">Нет ожидающих платежей.</div>`
         }

         <div style="margin-top:16px" class="row">
           <a href="/backoffice/bots/${escapeHtml(bot.id)}/paid" style="text-decoration:none"><button class="secondary" type="button">Назад</button></a>
         </div>`
      )
    );
  });

  server.post("/backoffice/api/bots/:botId/payments/:paymentId/confirm", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "payments:confirm_manual")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const paymentId = String((req.params as any)?.paymentId ?? "");

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);
    const runtime = await runtimeManager.startBotInstance(bot.id, { launch: false });
    await runtime.services.payments.confirmPayment(paymentId, superAdmin.id);
    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/payments`);
  });

  server.post("/backoffice/api/bots/:botId/payments/:paymentId/reject", async (req, reply) => {
    const cookie = readCookie(req, COOKIE_NAME);
    const backofficeUserId = cookie ? verifyBackofficeSessionToken(cookie) : null;
    if (!requireAuth(backofficeUserId, reply)) return;

    const roleRow = await prisma.backofficeUser.findUnique({
      where: { id: backofficeUserId ?? undefined },
      select: { role: true }
    });
    const role = roleRow?.role ?? "ADMIN";
    if (!canPerform(role, "payments:confirm_manual")) return reply.code(403).send("Forbidden");

    const botId = String((req.params as any)?.botId ?? "");
    const paymentId = String((req.params as any)?.paymentId ?? "");
    const body = req.body as any;
    const reason = String(body?.reason ?? "").trim();

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);
    const runtime = await runtimeManager.startBotInstance(bot.id, { launch: false });
    await runtime.services.payments.rejectPayment(paymentId, superAdmin.id, reason);
    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/payments`);
  });
}

