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
import { SubscriptionChannelService } from "../../modules/subscription-channel/subscription-channel.service";
import { logger } from "../../common/logger";
import { parseLinkedChatsFromForm } from "../../common/linked-chat-parser";
import { canPerform, canViewGlobalUserDirectory, type BackofficeAction } from "./backoffice-permissions";
import {
  getLinkedChatDiagnostics,
  getProductModeLabel,
  isTemporaryAccessProduct,
  isTestProduct,
  validateLinkedChatsForExpiringAccess
} from "../../modules/subscription-channel/subscription-access-policy";

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
      .wrap { width: 100%; max-width: none; margin: 0; padding: 14px 16px; box-sizing: border-box; }
      .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); overflow-x: auto; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      .row > * { flex: 1 1 auto; }
      label { display: block; margin-bottom: 6px; font-size: 13px; color: #cbd5e1; }
      input, textarea, select { width: 100%; max-width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(0,0,0,0.15); color: #e5e7eb; }
      button { padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: #2563eb; color: white; cursor: pointer; }
      button.secondary { background: rgba(255,255,255,0.08); }
      button.error { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.5); color: #fca5a5; }
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
      .linked-chat-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 8px; }
      .linked-chat-card { min-width: 0; padding: 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); }
      .linked-chat-card .title { font-size: 12px; font-weight: 700; color: #cbd5e1; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .02em; }
      .linked-chat-card .field-wrap { margin-bottom: 8px; }
      .linked-chat-card .field-wrap:last-child { margin-bottom: 0; }
      .linked-chat-card textarea { min-height: 74px; resize: vertical; }
      .nowpayments-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px 20px; margin-bottom: 16px; }
      .toggle-field { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 42px; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); }
      .toggle-field label { margin: 0; font-size: 12px; color: #cbd5e1; }
      .toggle-field input[type="checkbox"] { width: 16px; height: 16px; flex: 0 0 auto; padding: 0; margin: 0; accent-color: #2563eb; }
      @media (max-width: 560px) { .product-form-grid { grid-template-columns: 1fr; } }
      .test-block { margin-top: 12px; padding: 12px; border-radius: 10px; border: 1px dashed rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .form-row .btn { flex-shrink: 0; }
      .mi-card { margin-top: 12px; padding: 14px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; }
      .mi-card:first-of-type { margin-top: 0; }
      .section-title { font-size: 14px; font-weight: 600; color: #cbd5e1; margin: 16px 0 8px 0; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .section-title:first-child { margin-top: 0; }
      .paid-table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 13px; table-layout: auto; }
      .paid-table th, .paid-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); vertical-align: top; white-space: nowrap; }
      .paid-table th { color: #94a3b8; font-weight: 600; }
      .paid-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
      .paid-table tr:last-child td { border-bottom: none; }
      .paid-table td code { white-space: normal; word-break: break-word; overflow-wrap: anywhere; line-height: 1.2; display: inline-block; }
      .mono-wrap { min-width: 220px; max-width: 440px; }
      .wallet-col { min-width: 240px; max-width: 460px; }
      .events-scroll { max-height: 430px; overflow-y: auto; overflow-x: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; }
      .product-card { margin-top: 20px; padding: 18px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: rgba(0,0,0,0.12); }
      .product-card:first-of-type { margin-top: 12px; }
      .products-existing-block { margin-top: 40px; padding-top: 32px; border-top: 1px solid rgba(255,255,255,0.15); }
      .product-card-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
      .test-badge { display: inline-block; padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; background: rgba(251,191,36,0.2); border: 1px solid rgba(251,191,36,0.5); color: #fbbf24; }
      .paid-nav { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
      .paid-nav a { text-decoration:none; }
      .overview-grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; margin-top:16px; }
      .overview-card { padding:14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.04); }
      .overview-card .value { font-size:24px; font-weight:700; margin-top:4px; }
      .subgrid { display:grid; grid-template-columns: 1.2fr 0.8fr; gap:14px; }
      .status-badge { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid rgba(255,255,255,0.16); }
      .status-live { background: rgba(34,197,94,0.16); color:#86efac; border-color: rgba(34,197,94,0.45); }
      .status-test { background: rgba(251,191,36,0.16); color:#fde68a; border-color: rgba(251,191,36,0.45); }
      .status-active { background: rgba(59,130,246,0.16); color:#93c5fd; border-color: rgba(59,130,246,0.45); }
      .status-pending { background: rgba(250,204,21,0.14); color:#fde047; border-color: rgba(250,204,21,0.35); }
      .status-expiring { background: rgba(249,115,22,0.14); color:#fdba74; border-color: rgba(249,115,22,0.35); }
      .status-expired { background: rgba(239,68,68,0.14); color:#fca5a5; border-color: rgba(239,68,68,0.35); }
      .status-failed { background: rgba(239,68,68,0.18); color:#fca5a5; border-color: rgba(239,68,68,0.45); }
      .status-muted { background: rgba(148,163,184,0.14); color:#cbd5e1; border-color: rgba(148,163,184,0.25); }
      .flow-list { margin:0; padding-left:18px; color:#cbd5e1; }
      .flow-list li { margin:6px 0; }
      .warning-card { padding:12px; border-radius:12px; border:1px solid rgba(249,115,22,0.4); background:rgba(249,115,22,0.08); color:#fed7aa; }
      .danger-card { padding:12px; border-radius:12px; border:1px solid rgba(239,68,68,0.4); background:rgba(239,68,68,0.08); color:#fecaca; }
      .mono-list { margin:0; padding-left:18px; }
      .mono-list li code { color:#e2e8f0; }
      @media (max-width: 880px) { .overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .subgrid { grid-template-columns: 1fr; } }
      @media (max-width: 900px) {
        .wrap { padding: 10px; }
        .card { padding: 12px; }
        .paid-table { font-size: 12px; }
        .linked-chat-grid { grid-template-columns: 1fr; }
        .nowpayments-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 560px) { .overview-grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">${body}</div>
    </div>
    <script>
      (function () {
        function extractIdentifierFromPostLink(value) {
          if (!value) return "";
          var m = String(value).trim().match(/^https?:\/\/t\.me\/c\/(\d+)(?:\/\d+)?$/i);
          if (!m) return "";
          return "-100" + m[1];
        }

        document.addEventListener("input", function (event) {
          var target = event && event.target;
          if (!target || !target.name) return;
          if (!/^linkedChatLink[12]$/.test(target.name)) return;

          var idx = target.name.slice("linkedChatLink".length);
          var idInput = document.querySelector('input[name="linkedChatIdentifier' + idx + '"]');
          if (!idInput) return;
          if (String(idInput.value || "").trim()) return; // do not overwrite manual value

          var extracted = extractIdentifierFromPostLink(target.value);
          if (extracted) idInput.value = extracted;
        });
      })();
    </script>
  </body>
</html>`;
}

function formatLinkedChatsForEdit(linkedChats: unknown): string {
  if (!Array.isArray(linkedChats)) return "";
  return (linkedChats as Array<{ link?: string; identifier?: string; label?: string }>)
    .map((e) => {
      const prefix = e.label?.trim() ? `${e.label.trim()} | ` : "";
      if (e.link && e.identifier) return `${prefix}${e.link} | ${e.identifier}`;
      return `${prefix}${e.link ?? e.identifier ?? ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

function validatePrivateLinkedChatsOnly(linkedChats: Array<{ link?: string; identifier?: string; label?: string }>): string | null {
  for (let i = 0; i < linkedChats.length; i++) {
    const row = linkedChats[i] ?? {};
    const idx = i + 1;
    const identifier = String(row.identifier ?? "").trim();
    const link = String(row.link ?? "").trim();

    if (!identifier) {
      return `linkedChats: строка ${idx} — для приватного доступа обязателен identifier (chat/channel id вида -100...).`;
    }
    if (!/^-100\d{6,}$/.test(identifier)) {
      return `linkedChats: строка ${idx} — разрешен только приватный identifier вида -100... (публичные @username запрещены).`;
    }
    if (link && !/^https:\/\/t\.me\/(?:\+|joinchat\/)/i.test(link) && !/^https:\/\/t\.me\/c\/\d+(?:\/\d+)?$/i.test(link)) {
      return `linkedChats: строка ${idx} — разрешены invite-ссылки https://t.me/+... / joinchat/... или ссылка на пост вида https://t.me/c/...`;
    }
  }
  return null;
}

function readStructuredLinkedChatsFromBody(body: any): Array<{ link?: string; identifier?: string; label?: string }> {
  const rows: Array<{ link?: string; identifier?: string; label?: string }> = [];
  for (const i of [1, 2]) {
    const label = String(body?.[`linkedChatLabel${i}`] ?? "").trim();
    const link = String(body?.[`linkedChatLink${i}`] ?? "").trim();
    const rawIdentifier = String(body?.[`linkedChatIdentifier${i}`] ?? "").trim();
    const postLinkMatch = link.match(/^https?:\/\/t\.me\/c\/(\d+)(?:\/\d+)?$/i);
    const identifier = rawIdentifier || (postLinkMatch ? `-100${postLinkMatch[1]}` : "");
    const normalizedLink = postLinkMatch ? "" : link;
    if (!label && !link && !identifier) continue;
    rows.push({
      label: label || undefined,
      link: normalizedLink || undefined,
      identifier: identifier || undefined
    });
  }
  return rows;
}

function formatMoney(value: unknown): string {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toString() : "0";
}

function formatIsoDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function formatProductDuration(product: { billingType?: string | null; durationDays?: number | null; durationMinutes?: number | null }): string {
  if (Number(product.durationMinutes ?? 0) > 0) {
    return `${product.durationMinutes} мин`;
  }
  if (Number(product.durationDays ?? 0) > 0) {
    return `${product.durationDays} дн`;
  }
  return product.billingType === "ONE_TIME" ? "Без expiry" : "Без срока";
}

function renderStatusBadge(label: string, tone: "live" | "test" | "active" | "pending" | "expiring" | "expired" | "failed" | "muted" = "muted"): string {
  return `<span class="status-badge status-${tone}">${escapeHtml(label)}</span>`;
}

function renderProductModeBadge(product: { durationMinutes?: number | null }): string {
  return getProductModeLabel(product) === "TEST"
    ? renderStatusBadge("TEST", "test")
    : renderStatusBadge("LIVE", "live");
}

function renderLinkedChatReadiness(product: { linkedChats?: unknown; billingType?: string | null; durationDays?: number | null; durationMinutes?: number | null }): string {
  const diagnostics = getLinkedChatDiagnostics(product.linkedChats);
  if (!diagnostics.hasLinkedChats) {
    return renderStatusBadge("Нет linked chats", "muted");
  }
  if (!isTemporaryAccessProduct(product)) {
    return renderStatusBadge(`Ссылки: ${diagnostics.displayLinkCount}`, "active");
  }
  if (!diagnostics.removalReady) {
    return renderStatusBadge("REMOVAL UNAVAILABLE", "failed");
  }
  return renderStatusBadge(`Удаление готово (${diagnostics.banIdentifierCount})`, "active");
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
        ? `<a href="/backoffice/bots/${b.id}/paid" style="text-decoration:none"><button class="secondary" type="button">Оплаты и доступ</button></a>`
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

  server.get("/backoffice/", async (_req, reply) => {
    return reply.redirect("/backoffice", 302);
  });

  server.get("/backoffice/login/", async (_req, reply) => {
    return reply.redirect("/backoffice/login", 302);
  });

  server.get("/backoffice/logout/", async (_req, reply) => {
    return reply.redirect("/backoffice/logout", 302);
  });

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
      <td><a href="/backoffice/audience/user/${encodeURIComponent(u.id)}" style="color:var(--accent)">${escapeHtml(u.id.slice(0, 8))}</a></td>
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

  server.get("/backoffice/audience/user/:userId", async (req, reply) => {
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

    const userId = (req.params as { userId: string }).userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { botInstance: true }
    });
    if (!user) {
      return reply.code(404).send("User not found");
    }

    const activeRights = await prisma.userAccessRight.findMany({
      where: { userId, status: "ACTIVE" },
      include: { product: { include: { localizations: true } } }
    });
    const hasPaidAccess = activeRights.length > 0;

    const productLabels = activeRights
      .map((r) => r.product.localizations.find((l) => l.languageCode === "ru")?.title ?? r.product.code)
      .join(", ");

    const query = req.query as Record<string, string | undefined>;
    const revokedCount = query.revoked ? parseInt(query.revoked, 10) : undefined;
    const successMsg = revokedCount != null && !isNaN(revokedCount)
      ? `<div class="success">Платный доступ отозван (${revokedCount} продуктов)</div>`
      : "";

    const backLink = `/backoffice/audience${user.botInstanceId ? `?bot=${encodeURIComponent(user.botInstanceId)}` : ""}`;
    const revokeForm = hasPaidAccess
      ? `
        <form method="POST" action="/backoffice/audience/user/${encodeURIComponent(userId)}/revoke-access" style="display:inline; margin-right:8px">
          <button type="submit" class="secondary" onclick="return confirm('Отозвать платный доступ у пользователя? Он потеряет доступ к платным материалам и каналам.')">Отозвать платный доступ</button>
        </form>`
      : `<span class="small" style="color:#94a3b8">Платный доступ отсутствует</span>`;
    const deleteForm = `
        <form method="POST" action="/backoffice/audience/user/${encodeURIComponent(userId)}/delete" style="display:inline" onsubmit="return confirm('Удалить пользователя полностью? Он сможет заново зарегистрироваться по реферальной ссылке. Это действие необратимо.')">
          <button type="submit" class="error">Полностью удалить из базы</button>
        </form>`;

    const body = `
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:16px">
          <a href="${backLink}" style="text-decoration:none"><button class="secondary" type="button">← К списку</button></a>
        </div>
        ${successMsg}
        <div class="bot-card" style="max-width:600px">
          <h3 style="margin-top:0">Пользователь</h3>
          <p><strong>ID:</strong> ${escapeHtml(user.id)}</p>
          <p><strong>Telegram ID:</strong> ${escapeHtml(String(user.telegramUserId))}</p>
          <p><strong>Username:</strong> ${user.username ? `<a href="https://t.me/${escapeHtml(user.username)}" target="_blank">@${escapeHtml(user.username)}</a>` : "—"}</p>
          <p><strong>Имя:</strong> ${escapeHtml(user.fullName || user.firstName || "—")}</p>
          <p><strong>Бот:</strong> ${user.botInstance ? escapeHtml(user.botInstance.name) : "—"}</p>
          <p><strong>Регистрация:</strong> ${escapeHtml(user.createdAt.toISOString().slice(0, 19))}</p>
          <p><strong>Платный доступ:</strong> ${hasPaidAccess ? `✅ ${escapeHtml(productLabels)}` : "—"}</p>
          <hr style="border:none; border-top:1px solid rgba(255,255,255,0.16); margin:16px 0" />
          <h4 style="margin-top:0">Действия</h4>
          <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center">
            ${revokeForm}
            ${deleteForm}
          </div>
        </div>`;
    return reply.type("text/html").send(renderPage("Пользователь", body));
  });

  server.post("/backoffice/audience/user/:userId/revoke-access", async (req, reply) => {
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

    const userId = (req.params as { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send("User not found");
    }

    const runtime = user.botInstanceId ? runtimeManager.getRuntime(user.botInstanceId) : undefined;
    const subChannel = runtime
      ? runtime.services.subscriptionChannel
      : new SubscriptionChannelService(prisma);
    const { revokedCount } = await subChannel.revokeAllAccessForUser(userId);
    logger.info({ backofficeUserId, userId, revokedCount }, "Backoffice: revoked paid access");
    return reply.redirect(`/backoffice/audience/user/${encodeURIComponent(userId)}?revoked=${revokedCount}`);
  });

  server.post("/backoffice/audience/user/:userId/delete", async (req, reply) => {
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

    const userId = (req.params as { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send("User not found");
    }
    const botInstanceId = user.botInstanceId;

    await prisma.user.delete({ where: { id: userId } });
    logger.info({ backofficeUserId, userId, telegramUserId: String(user.telegramUserId) }, "Backoffice: deleted user from bot base");
    const redirect = botInstanceId
      ? `/backoffice/audience?bot=${encodeURIComponent(botInstanceId)}&deleted=1`
      : "/backoffice/audience?deleted=1";
    return reply.redirect(redirect);
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
    const runtime = await runtimeManager.startBotInstance(bot.id, { launch: false });
    const balanceFlowEnabled = runtime.services.balance.isNowPaymentsEnabled();

    const productRows = await prisma.menuItem.findMany({
      where: { templateId: template.id, productId: { not: null } },
      select: { productId: true },
      distinct: ["productId"]
    });
    const productIdSet = new Set(productRows.map((r) => String(r.productId)));
    const botCodePrefix = `bot_${bot.id.slice(0, 8)}_`;

    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { code: { startsWith: botCodePrefix } },
          ...(productIdSet.size ? [{ id: { in: Array.from(productIdSet) } }] : [])
        ]
      },
      include: {
        localizations: {
          select: { languageCode: true, title: true, description: true, payButtonText: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });
    const productIds = products.map((p) => p.id);

    const productLabelById = new Map<string, string>();
    for (const p of products) {
      const loc =
        p.localizations.find((item) => item.languageCode === baseLang) ??
        p.localizations.find((item) => item.languageCode === "ru") ??
        p.localizations[0];
      productLabelById.set(p.id, loc?.title ?? p.code);
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
    const boundSectionsByProduct = new Map<string, string[]>();
    for (const item of menuItems) {
      if (!item.productId) continue;
      const title = item.localizations[0]?.title ?? item.key;
      const current = boundSectionsByProduct.get(item.productId) ?? [];
      current.push(title);
      boundSectionsByProduct.set(item.productId, current);
    }

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

    const liveProducts = products.filter((product) => !isTestProduct(product));
    const testProducts = products.filter((product) => isTestProduct(product));

    const [activeAccessCount, expiringSoonCount, recentAccessRights, recentPayments, recentDeposits, recentPurchases, recentNotifications, nowPaymentsConfig, settlementAgg, payoutBatches, settlementEntries, webhookLogs] =
      await Promise.all([
        productIds.length
          ? prisma.userAccessRight.count({
              where: {
                productId: { in: productIds },
                status: "ACTIVE",
                user: { botInstanceId: bot.id }
              }
            })
          : Promise.resolve(0),
        productIds.length
          ? prisma.userAccessRight.count({
              where: {
                productId: { in: productIds },
                status: "ACTIVE",
                activeUntil: {
                  gt: new Date(),
                  lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
                },
                user: { botInstanceId: bot.id }
              }
            })
          : Promise.resolve(0),
        productIds.length
          ? prisma.userAccessRight.findMany({
              where: {
                productId: { in: productIds },
                user: { botInstanceId: bot.id }
              },
              include: {
                user: { select: { id: true, username: true, fullName: true, telegramUserId: true, selectedLanguage: true } },
                product: { include: { localizations: true } }
              },
              orderBy: [{ createdAt: "desc" }],
              take: 20
            })
          : Promise.resolve([]),
        prisma.payment.findMany({
          where: { botInstanceId: bot.id },
          include: {
            user: { select: { id: true, username: true, fullName: true, telegramUserId: true } },
            product: { include: { localizations: true } }
          },
          orderBy: { createdAt: "desc" },
          take: 12
        }),
        prisma.depositTransaction.findMany({
          where: { user: { botInstanceId: bot.id } },
          include: {
            user: { select: { id: true, username: true, fullName: true, telegramUserId: true } }
          },
          orderBy: { createdAt: "desc" },
          take: 12
        }),
        prisma.productPurchase.findMany({
          where: { user: { botInstanceId: bot.id } },
          include: {
            user: { select: { id: true, username: true, fullName: true, telegramUserId: true } },
            product: { include: { localizations: true } }
          },
          orderBy: { createdAt: "desc" },
          take: 12
        }),
        prisma.notification.findMany({
          where: {
            user: { botInstanceId: bot.id },
            type: { in: ["PAYMENT_CONFIRMED", "ACCESS_GRANTED", "ACCESS_EXPIRING", "SYSTEM_ALERT"] }
          },
          include: {
            user: { select: { id: true, username: true, fullName: true, telegramUserId: true } }
          },
          orderBy: { createdAt: "desc" },
          take: 20
        }),
        prisma.botPaymentProviderConfig.findUnique({
          where: { botInstanceId: bot.id }
        }),
        prisma.ownerSettlementEntry
          .aggregate({
            where: { botInstanceId: bot.id, status: "PENDING" },
            _count: true,
            _sum: { netAmountBeforePayoutFee: true }
          }),
        prisma.ownerPayoutBatch.findMany({
          where: { botInstanceId: bot.id },
          orderBy: { createdAt: "desc" },
          take: 10
        }),
        prisma.ownerSettlementEntry.findMany({
          where: { botInstanceId: bot.id },
          include: { depositTransaction: { select: { orderId: true } } },
          orderBy: { createdAt: "desc" },
          take: 20
        }),
        prisma.paymentWebhookLog
          .findMany({
            where: { provider: "nowpayments" },
            orderBy: { createdAt: "desc" },
            take: 50
          })
          .then((logs) =>
            logs.filter((w) => {
              const orderId = String((w.bodyJson as Record<string, unknown>)?.order_id ?? "");
              if (!orderId.startsWith("bot:")) return false;
              const match = orderId.match(/^bot:([^:]+):/);
              return match ? match[1] === bot.id : false;
            })
          )
          .then((filtered) => filtered.slice(0, 20))
      ]);

    const accessRightIdSet = new Set(recentAccessRights.map((item) => item.id));
    const recentJobs = accessRightIdSet.size
      ? (
          await prisma.scheduledJob.findMany({
            where: { jobType: { in: ["SEND_SUBSCRIPTION_REMINDER", "PROCESS_ACCESS_EXPIRY"] } },
            orderBy: { createdAt: "desc" },
            take: 250
          })
        ).filter((job) => accessRightIdSet.has(String(((job.payloadJson as any)?.accessRightId ?? ""))))
      : [];
    const reminderJobsByAccessId = new Map<string, typeof recentJobs>();
    const expiryJobByAccessId = new Map<string, (typeof recentJobs)[number]>();
    for (const job of recentJobs) {
      const accessRightId = String(((job.payloadJson as any)?.accessRightId ?? ""));
      if (!accessRightId) continue;
      if (job.jobType === "SEND_SUBSCRIPTION_REMINDER") {
        const current = reminderJobsByAccessId.get(accessRightId) ?? [];
        current.push(job);
        reminderJobsByAccessId.set(accessRightId, current);
        continue;
      }
      if (!expiryJobByAccessId.has(accessRightId)) {
        expiryJobByAccessId.set(accessRightId, job);
      }
    }

    const misconfiguredProducts = products.filter((product) => validateLinkedChatsForExpiringAccess(product));
    const pendingPaymentsCount = recentPayments.filter((payment) => payment.status === "PENDING" || payment.status === "UNPAID").length;
    const pendingDepositsCount = recentDeposits.filter((deposit) => deposit.status === "PENDING").length;
    const failedExpiryJobsCount = recentJobs.filter((job) => job.jobType === "PROCESS_ACCESS_EXPIRY" && job.status === "FAILED").length;

    const productLoc = (product: (typeof products)[number]) =>
      product.localizations.find((item) => item.languageCode === baseLang) ??
      product.localizations.find((item) => item.languageCode === "ru") ??
      product.localizations[0];

    const renderUserLabel = (user: { username: string | null; fullName: string; telegramUserId: bigint }) =>
      user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.fullName || String(user.telegramUserId));

    const renderPaymentStatus = (status: string) => {
      switch (status) {
        case "PAID":
        case "CONFIRMED":
        case "COMPLETED":
        case "ACTIVE":
          return renderStatusBadge(status, "active");
        case "PENDING":
        case "UNPAID":
          return renderStatusBadge(status, "pending");
        case "FAILED":
        case "CANCELLED":
        case "REJECTED":
          return renderStatusBadge(status, "failed");
        case "EXPIRED":
        case "REVOKED":
          return renderStatusBadge(status, "expired");
        default:
          return renderStatusBadge(status, "muted");
      }
    };

    const renderAccessStatus = (right: (typeof recentAccessRights)[number]) => {
      if (right.status === "EXPIRED") return renderStatusBadge("EXPIRED", "expired");
      if (right.status === "REVOKED") return renderStatusBadge("REVOKED", "failed");
      if (!right.activeUntil) return renderStatusBadge("ACTIVE", "active");
      const msLeft = right.activeUntil.getTime() - Date.now();
      if (msLeft <= 0) return renderStatusBadge("EXPIRED", "expired");
      if (msLeft <= 3 * 24 * 60 * 60 * 1000) return renderStatusBadge("EXPIRES SOON", "expiring");
      return renderStatusBadge("ACTIVE", "active");
    };

    const renderReminderSummary = (accessRightId: string) => {
      const jobs = reminderJobsByAccessId.get(accessRightId) ?? [];
      if (jobs.length === 0) return `<span class="small">—</span>`;
      const sent = jobs.filter((job) => job.status === "COMPLETED").length;
      const failed = jobs.filter((job) => job.status === "FAILED").length;
      const pending = jobs.filter((job) => job.status === "PENDING").length;
      const chunks: string[] = [];
      if (sent) chunks.push(`sent ${sent}`);
      if (pending) chunks.push(`pending ${pending}`);
      if (failed) chunks.push(`failed ${failed}`);
      return `${renderStatusBadge(chunks.join(" · "), failed ? "failed" : pending ? "pending" : "active")}`;
    };

    const renderExpirySummary = (accessRightId: string) => {
      const job = expiryJobByAccessId.get(accessRightId);
      if (!job) return `<span class="small">—</span>`;
      if (job.status === "FAILED") {
        return `${renderStatusBadge("REMOVAL FAILED", "failed")}<div class="small" style="margin-top:4px">${escapeHtml(job.errorMessage ?? "unknown error")}</div>`;
      }
      return `${renderPaymentStatus(job.status)}<div class="small" style="margin-top:4px">${formatIsoDate(job.runAt)}</div>`;
    };

    const renderProductCard = (product: (typeof products)[number], opts: { allowSimulate: boolean }) => {
      const loc = productLoc(product);
      const diagnostics = getLinkedChatDiagnostics(product.linkedChats);
      const linkedEntries = Array.isArray(product.linkedChats)
        ? (product.linkedChats as Array<{ label?: string; link?: string; identifier?: string }>)
        : [];
      const chat1 = linkedEntries[0] ?? {};
      const chat2 = linkedEntries[1] ?? {};
      const sections = boundSectionsByProduct.get(product.id) ?? [];
      const removalWarning = isTemporaryAccessProduct(product) ? diagnostics.issue : null;

      return `<div class="product-card">
        <div class="product-card-header">
          <span><b>${escapeHtml(loc?.title ?? product.code)}</b></span>
          ${renderProductModeBadge(product)}
          ${renderStatusBadge(product.billingType === "TEMPORARY" || Number(product.durationMinutes ?? 0) > 0 ? "EXPIRING ACCESS" : "LIFETIME", product.billingType === "TEMPORARY" || Number(product.durationMinutes ?? 0) > 0 ? "pending" : "active")}
          <span class="small">${escapeHtml(formatMoney(product.price))} ${escapeHtml(product.currency)} · ${escapeHtml(formatProductDuration(product))}</span>
          <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(product.id)}/archive" style="margin-left:auto">
            <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45);">Архивировать</button>
          </form>
        </div>

        <div class="row" style="margin-bottom:12px">
          <div class="small">Привязан к разделам: ${sections.length ? sections.map((item) => `<code>${escapeHtml(item)}</code>`).join(", ") : "— пока не привязан"}</div>
          <div class="small">CTA в боте: <code>${escapeHtml(loc?.payButtonText ?? "Оплатить")}</code></div>
          <div>${renderLinkedChatReadiness(product)}</div>
        </div>
        ${removalWarning ? `<div class="warning-card" style="margin-bottom:12px">${escapeHtml(removalWarning)}</div>` : ""}
        ${diagnostics.hasLinkedChats ? `<div class="small" style="margin-bottom:12px">linked chats: ссылки ${diagnostics.displayLinkCount} · chat identifiers ${diagnostics.banIdentifierCount}</div>` : ""}

        <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(product.id)}/update">
          <div class="section-title">Basic</div>
          <div class="product-form-grid">
            <div class="field-wrap"><label class="small">Название продукта в инвойсе (ru)</label><input name="titleRu" type="text" required value="${escapeHtml(loc?.title ?? "")}" /></div>
            <div class="field-wrap"><label class="small">Кнопка в разделе (ru)</label><input name="payButtonTextRu" type="text" required value="${escapeHtml(loc?.payButtonText ?? "")}" /></div>
            <div class="field-wrap"><label class="small">Цена</label><input name="price" type="text" required value="${escapeHtml(String(product.price ?? ""))}" /></div>
            <div class="field-wrap"><label class="small">Валюта</label><input name="currency" type="text" required value="${escapeHtml(product.currency ?? "USDT")}" /></div>
            <div class="field-wrap"><label class="small">Тип</label>
              <select name="billingType">
                <option value="ONE_TIME" ${product.billingType === "ONE_TIME" ? "selected" : ""}>Разовая</option>
                <option value="TEMPORARY" ${product.billingType === "TEMPORARY" ? "selected" : ""}>Временный доступ (подписка)</option>
              </select>
            </div>
            <div class="field-wrap"><label class="small">Дней доступа (LIVE)</label><input name="durationDays" type="number" min="1" value="${product.durationDays ?? ""}" placeholder="30" /></div>
          </div>

          <div class="section-title">Платежи и доступ</div>
          <div class="product-form-grid">
            <div class="field-wrap"><label class="small">Минуты доступа для TEST</label><input name="durationMinutes" type="number" min="1" max="1440" value="${product.durationMinutes ?? ""}" placeholder="пусто = live" /></div>
          </div>
          <div style="margin-top:12px">
            <label class="small">Ссылки доступа в чат / канал</label>
            <div class="linked-chat-grid">
              <div class="linked-chat-card">
                <div class="title">Кнопка 1</div>
                <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel1" type="text" placeholder="Чат" value="${escapeHtml(String(chat1.label ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Invite link или post link</label><input name="linkedChatLink1" type="text" placeholder="https://t.me/+inviteHashChat или https://t.me/c/1234567890/1" value="${escapeHtml(String(chat1.link ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Identifier</label><input name="linkedChatIdentifier1" type="text" placeholder="-1001234567890" value="${escapeHtml(String(chat1.identifier ?? ""))}" /></div>
              </div>
              <div class="linked-chat-card">
                <div class="title">Кнопка 2</div>
                <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel2" type="text" placeholder="Канал" value="${escapeHtml(String(chat2.label ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Invite link или post link</label><input name="linkedChatLink2" type="text" placeholder="https://t.me/+inviteHashChannel или https://t.me/c/2234567890/1" value="${escapeHtml(String(chat2.link ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Identifier</label><input name="linkedChatIdentifier2" type="text" placeholder="-1002234567890" value="${escapeHtml(String(chat2.identifier ?? ""))}" /></div>
              </div>
            </div>
            <textarea name="linkedChatsRaw" rows="3" placeholder="Чат | https://t.me/+inviteHashChat | -1001234567890&#10;Канал | https://t.me/+inviteHashChannel | -1002234567890">${formatLinkedChatsForEdit(product.linkedChats)}</textarea>
            <div class="small" style="margin-top:6px">Можно не указывать identifier вручную: если вставите post-link вида <code>https://t.me/c/.../...</code>, identifier <code>-100...</code> будет извлечен автоматически.</div>
            <div class="small" style="margin-top:4px">Для приватного чата можно хранить и ссылку для входа, и identifier для ban/unban в одной строке: <code>https://t.me/+inviteHash | -1001234567890</code> или <code>https://t.me/+inviteHash | https://t.me/c/1234567890/1</code>. Тогда пользователь войдёт по invite-link, а бот сможет удалить его по expiry.</div>
          </div>
          <div style="margin-top:12px">
            <label class="small">Описание на экране оплаты / тарифы (ru)</label>
            <textarea name="descriptionRu" rows="2">${escapeHtml(loc?.description ?? "")}</textarea>
            <div class="small" style="margin-top:4px">Показывается пользователю в едином инвойсе сразу под названием продукта. Сюда пишите оффер, тарифы, бонусы и что откроется после оплаты.</div>
          </div>
          <button type="submit" style="margin-top:16px">Сохранить</button>
        </form>

        ${
          opts.allowSimulate
            ? `<div class="section-title">Быстрый ручной тест</div>
               <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(product.id)}/simulate-payment" class="form-row">
                 <div class="field" style="min-width:220px; max-width:320px">
                   <select name="userId" required>
                     <option value="">— Выберите пользователя —</option>
                     ${userSelectOptions}
                   </select>
                 </div>
                 <div class="btn"><button type="submit" class="secondary">Выдать тестовый доступ</button></div>
               </form>
               <div class="small" style="margin-top:6px">Проверит grant → invite links → reminders → expiry → removal в ускоренном режиме.</div>`
            : ""
        }
      </div>`;
    };

    const paymentEvents = [
      ...recentPayments.map((payment) => ({
        createdAt: payment.createdAt,
        kind: "invoice",
        status: payment.status,
        user: payment.user,
        productLabel:
          payment.product.localizations.find((item) => item.languageCode === baseLang)?.title ??
          payment.product.localizations.find((item) => item.languageCode === "ru")?.title ??
          payment.product.code,
        amount: `${formatMoney(payment.amount)} ${payment.currency}`,
        note: payment.referenceCode,
        walletAddress: null as string | null
      })),
      ...recentDeposits.map((deposit) => ({
        createdAt: deposit.createdAt,
        kind: "deposit",
        status: deposit.status,
        user: deposit.user,
        productLabel: "Balance top-up",
        amount: `${formatMoney(deposit.amount)} ${deposit.currency}`,
        note: deposit.orderId,
        walletAddress: deposit.providerPayAddress ?? null
      })),
      ...recentPurchases.map((purchase) => ({
        createdAt: purchase.createdAt,
        kind: "balance_purchase",
        status: purchase.status,
        user: purchase.user,
        productLabel:
          purchase.product.localizations.find((item) => item.languageCode === baseLang)?.title ??
          purchase.product.localizations.find((item) => item.languageCode === "ru")?.title ??
          purchase.product.code,
        amount: `${formatMoney(purchase.amount)} USDT`,
        note: purchase.idempotencyKey,
        walletAddress: null as string | null
      }))
    ]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, 10);

    const readRequestedProductId = (rawPayload: unknown): string | null => {
      if (!rawPayload || typeof rawPayload !== "object") return null;
      const value = (rawPayload as Record<string, unknown>).requestedProductId;
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed || null;
    };
    const diagnoseDepositReason = (deposit: (typeof recentDeposits)[number]): string => {
      if (deposit.status === "CONFIRMED") return "credited";
      if (deposit.status === "FAILED") return "failed_by_provider";
      if (!deposit.providerPaymentId) return "create_payment_failed_or_not_created";
      if (!deposit.providerPayAddress) return "provider_pay_address_missing";
      return "waiting_provider_or_ipn";
    };
    const depositDiagnosticsRows = recentDeposits.slice(0, 12).map((deposit) => {
      const requested = Number(deposit.requestedAmountUsd ?? deposit.amount ?? 0);
      const minAccepted = requested * 0.98;
      const outcome = deposit.actualOutcomeAmount != null ? Number(deposit.actualOutcomeAmount) : null;
      const tolerance =
        outcome == null
          ? "n/a"
          : outcome >= minAccepted
            ? "pass"
            : "fail";

      return {
        createdAt: deposit.createdAt,
        orderId: deposit.orderId,
        providerPaymentId: deposit.providerPaymentId,
        providerStatus: deposit.providerStatus,
        providerPayAddress: deposit.providerPayAddress,
        requestedAmountUsd: deposit.requestedAmountUsd,
        actualOutcomeAmount: deposit.actualOutcomeAmount,
        creditedBalanceAmount: deposit.creditedBalanceAmount,
        status: deposit.status,
        botInstanceId: deposit.botInstanceId,
        productId: readRequestedProductId(deposit.rawPayload),
        reason: diagnoseDepositReason(deposit),
        minAccepted,
        tolerance
      };
    });

    return reply.type("text/html").send(
      renderPage(
        "Платный доступ",
        `<h2 style="margin-top:0">Оплаты и доступ</h2>
         <div class="small" style="margin-top:6px">Bot: <code>${escapeHtml(bot.id)}</code></div>
         ${simulateOk ? `<div class="success" style="margin-top:12px">Тестовый сценарий запущен: доступ выдан, reminders и expiry/removal будут отработаны по policy продукта.</div>` : ""}
         ${simulateError ? `<div class="error" style="margin-top:12px">Ошибка тестового сценария: ${escapeHtml(simulateError)}</div>` : ""}
         ${misconfiguredProducts.length ? `<div class="warning-card" style="margin-top:12px">Найдены expiring-продукты без ban-capable linked chats. Они смогут показать invite buttons, но не смогут гарантированно удалить пользователя из чата/канала по expiry: ${misconfiguredProducts.map((product) => `<code>${escapeHtml(productLabelById.get(product.id) ?? product.code)}</code>`).join(", ")}</div>` : ""}

         <div class="paid-nav">
           <a href="#overview"><button class="secondary" type="button">Обзор</button></a>
           <a href="#bindings"><button class="secondary" type="button">Контент и доступ</button></a>
           <a href="#live-products"><button class="secondary" type="button">Live products</button></a>
           <a href="#test-lab"><button class="secondary" type="button">Test Lab</button></a>
           <a href="#payments-balance"><button class="secondary" type="button">Платежи / баланс</button></a>
           <a href="#nowpayments"><button class="secondary" type="button">NOWPayments / Payouts</button></a>
           <a href="#access-audit"><button class="secondary" type="button">Аудит доступа</button></a>
         </div>

         <div id="overview" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Dashboard / Обзор</h3>
           <div class="small">Один экран для alpha-owner: сколько продуктов активны, какие разделы locked, где ближайшие истечения и есть ли ошибки в removal pipeline.</div>
           <div class="overview-grid">
             <div class="overview-card"><div class="small">Paid access</div><div class="value">${bot.paidAccessEnabled ? "ON" : "OFF"}</div><div style="margin-top:6px">${bot.paidAccessEnabled ? renderStatusBadge("ACTIVE", "active") : renderStatusBadge("DISABLED", "failed")}</div></div>
             <div class="overview-card"><div class="small">Locked sections</div><div class="value">${menuItems.filter((item) => Boolean(item.productId)).length}</div><div class="small" style="margin-top:6px">${menuItems.length} всего разделов</div></div>
             <div class="overview-card"><div class="small">Products</div><div class="value">${products.length}</div><div class="small" style="margin-top:6px">${renderStatusBadge(`LIVE ${liveProducts.length}`, "live")} ${renderStatusBadge(`TEST ${testProducts.length}`, "test")}</div></div>
             <div class="overview-card"><div class="small">Active accesses</div><div class="value">${activeAccessCount}</div><div class="small" style="margin-top:6px">${renderStatusBadge(`Expiring soon ${expiringSoonCount}`, expiringSoonCount ? "expiring" : "muted")}</div></div>
             <div class="overview-card"><div class="small">Pending payments</div><div class="value">${pendingPaymentsCount}</div><div class="small" style="margin-top:6px">${renderStatusBadge(`Deposits pending ${pendingDepositsCount}`, pendingDepositsCount ? "pending" : "muted")}</div></div>
             <div class="overview-card"><div class="small">Expiry issues</div><div class="value">${failedExpiryJobsCount}</div><div class="small" style="margin-top:6px">${failedExpiryJobsCount ? renderStatusBadge("Removal failures require review", "failed") : renderStatusBadge("No detected failures", "active")}</div></div>
           </div>
           <div class="subgrid" style="margin-top:16px">
             <div class="card" style="padding:14px">
               <div class="section-title">Quick flow</div>
               <ol class="flow-list">
                 <li>Создайте live- или test-продукт.</li>
                 <li>Привяжите продукт к разделу в блоке “Контент и доступ”.</li>
                 <li>Проверьте CTA-кнопку оплаты и linked chat readiness.</li>
                 <li>Для TEST используйте “Выдать тестовый доступ”, чтобы прогнать весь lifecycle за минуты.</li>
                 <li>Следите за reminders / expiry / removal в “Аудит доступа”.</li>
               </ol>
             </div>
             <div class="card" style="padding:14px">
               <div class="section-title">Checkout mode</div>
               <div>${balanceFlowEnabled ? renderStatusBadge("TOP-UP + PAY FROM BALANCE", "active") : renderStatusBadge("DIRECT / MANUAL PAYMENT REQUEST", "pending")}</div>
               <div class="small" style="margin-top:8px">Оплата работает автоматически через NOWPayments. Сеть: USDT (BEP20). Владелец получает выплаты на указанный кошелёк owner.</div>
             </div>
           </div>
         </div>

         <div id="bindings" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Контент и доступ</h3>
           <div class="small" style="margin-bottom:12px">Здесь находится business-flow alpha-owner: раздел → привязка продукта → страница-витрина раздела → CTA-кнопка оплаты в боте.</div>
           <div class="card" style="padding:14px; margin-bottom:14px">
             <h4 style="margin-top:0">Глобальное включение</h4>
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
           ${
             menuItems.length
               ? `<table class="paid-table">
                   <thead><tr><th>Раздел</th><th>Статус</th><th>Продукт</th><th>CTA в боте</th><th style="width:260px">Действие</th></tr></thead>
                   <tbody>
                     ${menuItems.map((mi) => {
                       const title = mi.localizations[0]?.title ?? mi.key;
                       const product = mi.productId ? products.find((item) => item.id === mi.productId) : null;
                       const productLabel = mi.productId ? productLabelById.get(mi.productId) ?? mi.productId : null;
                       const productButtonText = product ? (productLoc(product)?.payButtonText ?? "Оплатить") : "—";
                       return mi.productId
                         ? `<tr>
                              <td><b>${escapeHtml(title)}</b></td>
                              <td>${renderStatusBadge("LOCKED", "pending")}</td>
                              <td><code>${escapeHtml(productLabel ?? "")}</code> ${product ? renderProductModeBadge(product) : ""}</td>
                              <td><code>${escapeHtml(productButtonText)}</code></td>
                              <td>
                                <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/menu-items/${escapeHtml(mi.id)}/unlock" style="display:inline">
                                  <button type="submit" class="secondary">Снять блокировку</button>
                                </form>
                              </td>
                            </tr>`
                         : `<tr>
                              <td><b>${escapeHtml(title)}</b></td>
                              <td>${renderStatusBadge("FREE", "active")}</td>
                              <td>
                                <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/menu-items/${escapeHtml(mi.id)}/lock" style="margin:0; display:flex; flex-wrap:wrap; gap:8px; align-items:center; max-width:560px">
                                  <div class="field" style="min-width:220px; flex:1 1 260px">
                                    <select name="productId" required class="field" style="width:100%">
                                      ${productSelectOptions}
                                    </select>
                                  </div>
                                  <div class="btn" style="flex:0 0 auto"><button type="submit">Привязать продукт</button></div>
                                </form>
                              </td>
                              <td>—</td>
                              <td><span class="small">После привязки появится CTA оплаты</span></td>
                            </tr>`;
                     }).join("")}
                   </tbody>
                 </table>`
               : `<div class="small">Нет пунктов меню.</div>`
           }
         </div>

         <div id="live-products" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Продукты · LIVE</h3>
           <div class="small">Live-продукты — это реальные продукты для продажи. Здесь только production-настройка без тестовых минут.</div>
           <div class="card" style="padding:14px; margin-top:12px">
             <h4 style="margin-top:0">Создать live-product</h4>
             <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/create">
               <div class="product-form-grid">
                 <div class="field-wrap"><label class="small">Название продукта в инвойсе (ru)</label><input name="titleRu" type="text" required placeholder="Обучение / VIP доступ" /></div>
                 <div class="field-wrap"><label class="small">Кнопка в разделе (ru)</label><input name="payButtonTextRu" type="text" required placeholder="Оплатить обучение" /></div>
                 <div class="field-wrap"><label class="small">Цена</label><input name="price" type="text" required value="10" /></div>
                 <div class="field-wrap"><label class="small">Валюта</label><input name="currency" type="text" required value="USDT" /></div>
                <div class="field-wrap"><label class="small">Тип</label>
                  <select name="billingType">
                    <option value="ONE_TIME">Разовая продажа</option>
                    <option value="TEMPORARY" selected>Временный доступ (подписка)</option>
                  </select>
                </div>
                 <div class="field-wrap"><label class="small">Дней доступа</label><input name="durationDays" type="number" min="1" placeholder="30" /></div>
               </div>
              <details style="margin-top:12px">
                 <summary class="small" style="cursor:pointer">Платежи и доступ</summary>
                 <div style="margin-top:12px">
                  <label class="small">Ссылки доступа в чат / канал</label>
                  <div class="linked-chat-grid">
                    <div class="linked-chat-card">
                      <div class="title">Кнопка 1</div>
                      <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel1" type="text" placeholder="Чат" /></div>
                      <div class="field-wrap"><label class="small">Invite link или post link</label><input name="linkedChatLink1" type="text" placeholder="https://t.me/+inviteHashChat или https://t.me/c/1234567890/1" /></div>
                      <div class="field-wrap"><label class="small">Identifier</label><input name="linkedChatIdentifier1" type="text" placeholder="-1001234567890" /></div>
                    </div>
                    <div class="linked-chat-card">
                      <div class="title">Кнопка 2</div>
                      <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel2" type="text" placeholder="Канал" /></div>
                      <div class="field-wrap"><label class="small">Invite link или post link</label><input name="linkedChatLink2" type="text" placeholder="https://t.me/+inviteHashChannel или https://t.me/c/2234567890/1" /></div>
                      <div class="field-wrap"><label class="small">Identifier</label><input name="linkedChatIdentifier2" type="text" placeholder="-1002234567890" /></div>
                    </div>
                  </div>
                   <textarea name="linkedChatsRaw" rows="3" placeholder="Чат | https://t.me/+inviteHashChat | -1001234567890&#10;Канал | https://t.me/+inviteHashChannel | -1002234567890"></textarea>
                   <div class="small" style="margin-top:6px">Можно не указывать identifier вручную: если вставите post-link вида <code>https://t.me/c/.../...</code>, identifier <code>-100...</code> будет извлечен автоматически.</div>
                   <div class="small" style="margin-top:4px">Для приватного чата можно сохранить invite-link и identifier в одной строке: <code>https://t.me/+inviteHash | -1001234567890</code> или <code>https://t.me/+inviteHash | https://t.me/c/1234567890/1</code>. Тогда кнопка доступа будет вести по invite-link, а бот сможет удалить пользователя по expiry.</div>
                </div>
                <div style="margin-top:12px">
                  <label class="small">Описание на экране оплаты / тарифы (ru)</label>
                  <textarea name="descriptionRu" rows="2"></textarea>
                  <div class="small" style="margin-top:4px">Показывается пользователю в едином инвойсе сразу под названием продукта. Сюда удобно писать тарифы и то, что человек получит после оплаты.</div>
                </div>
              </details>
               <button type="submit" style="margin-top:12px">Создать live-product</button>
             </form>
           </div>
           <div class="products-existing-block">
             <div class="section-title">Существующие live-products</div>
             ${liveProducts.length ? liveProducts.map((product) => renderProductCard(product, { allowSimulate: false })).join("") : `<div class="small">Пока нет live-продуктов.</div>`}
           </div>
         </div>

         <div id="test-lab" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Test Lab</h3>
           <div class="small">Отдельное пространство для ручной проверки полного lifecycle доступа без ожидания днями. TEST-продукты используют reminders за 3/2/1 минуты и истекают в минутах, но идут по тому же grant / invite / expiry / removal pipeline.</div>
           <div class="card test-block" style="margin-top:12px">
             <h4 style="margin-top:0">Создать тестовый продукт</h4>
             <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/create">
               <input type="hidden" name="billingType" value="TEMPORARY" />
               <input type="hidden" name="currency" value="USDT" />
               <div class="product-form-grid">
                 <div class="field-wrap"><label class="small">Название продукта в инвойсе (ru)</label><input name="titleRu" type="text" required placeholder="Тест: обучение 5 мин" /></div>
                 <div class="field-wrap"><label class="small">Кнопка в разделе (ru)</label><input name="payButtonTextRu" type="text" required value="Оплатить тест" /></div>
                 <div class="field-wrap"><label class="small">Цена</label><input name="price" type="text" required value="1" /></div>
                 <div class="field-wrap"><label class="small">Срок в минутах</label><input name="durationMinutes" type="number" required min="1" max="1440" value="5" /></div>
               </div>
               <div style="margin-top:12px">
                 <label class="small">Ссылки доступа в чат / канал</label>
                <div class="linked-chat-grid">
                  <div class="linked-chat-card">
                    <div class="title">Кнопка 1</div>
                    <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel1" type="text" placeholder="Чат" /></div>
                    <div class="field-wrap"><label class="small">Invite link или post link</label><input name="linkedChatLink1" type="text" placeholder="https://t.me/+inviteHashChat или https://t.me/c/1234567890/1" /></div>
                    <div class="field-wrap"><label class="small">Identifier</label><input name="linkedChatIdentifier1" type="text" placeholder="-1001234567890" /></div>
                  </div>
                  <div class="linked-chat-card">
                    <div class="title">Кнопка 2</div>
                    <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel2" type="text" placeholder="Канал" /></div>
                    <div class="field-wrap"><label class="small">Invite link или post link</label><input name="linkedChatLink2" type="text" placeholder="https://t.me/+inviteHashChannel или https://t.me/c/2234567890/1" /></div>
                    <div class="field-wrap"><label class="small">Identifier</label><input name="linkedChatIdentifier2" type="text" placeholder="-1002234567890" /></div>
                  </div>
                </div>
                 <textarea name="linkedChatsRaw" rows="3" placeholder="Чат | https://t.me/+inviteHashChat | -1001234567890&#10;Канал | https://t.me/+inviteHashChannel | -1002234567890"></textarea>
                 <div class="small" style="margin-top:6px">Можно не указывать identifier вручную: если вставите post-link вида <code>https://t.me/c/.../...</code>, identifier <code>-100...</code> будет извлечен автоматически.</div>
               </div>
               <div style="margin-top:12px">
                 <label class="small">Описание на экране оплаты / тарифы (ru)</label>
                 <textarea name="descriptionRu" rows="2" placeholder="Тестовый продукт для прогона access lifecycle"></textarea>
                 <div class="small" style="margin-top:4px">Показывается в едином инвойсе тестового продукта сразу под названием. Здесь удобно описать оффер, тариф и что откроется после оплаты.</div>
               </div>
               <button type="submit" style="margin-top:12px">Создать тестовый продукт</button>
             </form>
             <div class="small" style="margin-top:8px">Ожидаемое поведение: reminder за 3/2/1 минуты → expiry → попытка удаления из linked chats. Для приватного чата используйте либо <code>https://t.me/c/1234567890/1</code>, либо комбинированный формат <code>https://t.me/+inviteHash | -1001234567890</code>. Тогда пользователь войдёт по invite-link, а бан/unban пойдёт по identifier.</div>
           </div>
           <div class="products-existing-block">
             <div class="section-title">Тестовые продукты</div>
             ${testProducts.length ? testProducts.map((product) => renderProductCard(product, { allowSimulate: true })).join("") : `<div class="small">Пока нет тестовых продуктов. Создайте первый, чтобы быстро прогонять весь сценарий руками.</div>`}
           </div>
         </div>

         <div id="payments-balance" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Платежи / баланс</h3>
           <div class="subgrid">
             <div class="card" style="padding:14px">
               <div class="section-title">Режим оплаты</div>
               <div>${balanceFlowEnabled ? renderStatusBadge("NOWPayments active (USDT BEP20)", "active") : renderStatusBadge("NOWPayments не настроен", "pending")}</div>
               <ul class="mono-list" style="margin-top:10px">
                 <li><code>invoice/pending</code>: пользователь открыл оплату, ждём подтверждение.</li>
                 <li><code>deposit/confirmed</code>: баланс пополнен через NOWPayments.</li>
                 <li><code>balance purchase/completed</code>: продукт куплен с баланса.</li>
                 <li><code>NOWPayments IPN</code>: автоматическое подтверждение после оплаты.</li>
               </ul>
             </div>
             <div class="card" style="padding:14px">
               <div class="section-title">Последние уведомления</div>
               ${
                 recentNotifications.length
                   ? recentNotifications.map((notification) => `<div style="margin-top:8px"><div>${renderPaymentStatus(notification.status)} <code>${escapeHtml(notification.type)}</code></div><div class="small">${renderUserLabel(notification.user)} · ${formatIsoDate(notification.createdAt)}</div></div>`).join("")
                   : `<div class="small">Пока нет notification events.</div>`
               }
             </div>
           </div>
           <div class="section-title">События платежей</div>
           ${
             paymentEvents.length
              ? `<div class="events-scroll"><table class="paid-table">
                  <thead><tr><th>Когда</th><th>Событие</th><th>Пользователь</th><th>Продукт</th><th>Сумма</th><th>Статус</th><th>Ref / Order</th><th>Wallet</th></tr></thead>
                   <tbody>
                     ${paymentEvents.map((event) => `<tr>
                       <td>${formatIsoDate(event.createdAt)}</td>
                       <td><code>${escapeHtml(event.kind)}</code></td>
                       <td>${renderUserLabel(event.user)}</td>
                       <td>${escapeHtml(event.productLabel)}</td>
                       <td>${escapeHtml(event.amount)}</td>
                       <td>${renderPaymentStatus(event.status)}</td>
                      <td class="mono-wrap"><code>${escapeHtml(event.note)}</code></td>
                      <td class="wallet-col"><code>${escapeHtml(event.walletAddress ?? "-")}</code></td>
                     </tr>`).join("")}
                  </tbody>
                </table></div>`
               : `<div class="small">Пока нет событий платежей.</div>`
           }
         </div>

         <div id="nowpayments" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">NOWPayments / Owner Payouts</h3>
           <div class="small" style="margin-bottom:12px">Конфигурация для пополнения баланса и ежедневных выплат owner'у бота.</div>
           <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/nowpayments-config">
            <div class="nowpayments-grid">
              <div class="toggle-field"><label class="small" for="np-enabled">Включить NOWPayments</label><input id="np-enabled" type="checkbox" name="enabled" value="1" ${nowPaymentsConfig?.enabled ? "checked" : ""} /></div>
              <div class="toggle-field"><label class="small" for="np-owner-payout">Owner payout включён</label><input id="np-owner-payout" type="checkbox" name="ownerPayoutEnabled" value="1" ${nowPaymentsConfig?.ownerPayoutEnabled ? "checked" : ""} /></div>
              <div class="toggle-field"><label class="small" for="np-daily-payout">Ежедневные выплаты</label><input id="np-daily-payout" type="checkbox" name="dailyPayoutEnabled" value="1" ${nowPaymentsConfig?.dailyPayoutEnabled !== false ? "checked" : ""} /></div>
               <div class="field-wrap"><label class="small">Кошелёк owner (USDT BEP20)</label><input name="ownerWalletAddress" type="text" placeholder="0x..." value="${escapeHtml(nowPaymentsConfig?.ownerWalletAddress ?? "")}" style="width:100%" /></div>
               <input type="hidden" name="settlementCurrency" value="usdtbep20" />
               <div class="field-wrap"><label class="small">Минимум для выплаты (USDT)</label><input name="dailyPayoutMinAmount" type="text" value="${escapeHtml(String(nowPaymentsConfig?.dailyPayoutMinAmount ?? 0))}" /></div>
             </div>
             <button type="submit">Сохранить конфиг</button>
           </form>
           <div class="subgrid" style="margin-top:16px">
             <div class="card" style="padding:14px">
               <div class="section-title">Settlement summary</div>
               <div class="overview-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">
                 <div><div class="small">Pending entries</div><div class="value">${settlementAgg._count}</div></div>
                 <div><div class="small">Pending net (USDT)</div><div class="value">${Number(settlementAgg._sum.netAmountBeforePayoutFee ?? 0).toFixed(2)}</div></div>
               </div>
             </div>
             <div class="card" style="padding:14px">
               <div class="section-title">Payout batches</div>
               ${payoutBatches.length ? payoutBatches.slice(0, 5).map((b) => `<div class="small" style="margin-top:6px">${formatIsoDate(b.runDate)} · ${b.status} · ${Number(b.netTotal).toFixed(2)} USDT</div>`).join("") : `<div class="small">Нет батчей</div>`}
             </div>
           </div>
           <div class="section-title" style="margin-top:16px">Settlement entries (последние)</div>
           ${settlementEntries.length ? `<table class="paid-table"><thead><tr><th>Когда</th><th>Order</th><th>Gross</th><th>Net</th><th>Статус</th></tr></thead><tbody>${settlementEntries.map((e) => `<tr><td>${formatIsoDate(e.createdAt)}</td><td><code>${escapeHtml(e.depositTransaction?.orderId ?? "-")}</code></td><td>${Number(e.grossAmount).toFixed(2)}</td><td>${Number(e.netAmountBeforePayoutFee).toFixed(2)}</td><td>${renderPaymentStatus(e.status)}</td></tr>`).join("")}</tbody></table>` : `<div class="small">Нет записей</div>`}
<details style="margin-top:16px">
            <summary class="small" style="cursor:pointer">Webhook logs (NOWPayments, this bot only)</summary>
             ${webhookLogs.length ? `<table class="paid-table" style="margin-top:8px"><thead><tr><th>Когда</th><th>Event</th><th>Sig</th><th>Result</th></tr></thead><tbody>${webhookLogs.map((w) => `<tr><td>${formatIsoDate(w.createdAt)}</td><td><code>${escapeHtml(String((w.bodyJson as any)?.payment_id ?? "-"))}</code></td><td>${w.signatureValid ? "✓" : "✗"}</td><td>${escapeHtml(w.processingResult ?? "-")}</td></tr>`).join("")}</tbody></table>` : `<div class="small" style="margin-top:8px">Нет логов</div>`}
           </details>
          <details style="margin-top:12px">
            <summary class="small" style="cursor:pointer">Deposit diagnostics (this bot only)</summary>
            ${depositDiagnosticsRows.length
              ? `<table class="paid-table" style="margin-top:8px"><thead><tr><th>Когда</th><th>Order</th><th>PaymentId</th><th>Provider status</th><th>Wallet</th><th>Req</th><th>Min 98%</th><th>Outcome</th><th>Tolerance</th><th>Credited</th><th>Deposit status</th><th>Product</th><th>Reason</th><th>Support</th></tr></thead><tbody>${depositDiagnosticsRows.map((d) => `<tr><td>${formatIsoDate(d.createdAt)}</td><td class="mono-wrap"><code>${escapeHtml(d.orderId)}</code></td><td class="mono-wrap"><code>${escapeHtml(d.providerPaymentId ?? "-")}</code></td><td><code>${escapeHtml(d.providerStatus ?? "-")}</code></td><td class="wallet-col"><code>${escapeHtml(d.providerPayAddress ?? "-")}</code></td><td>${escapeHtml(Number(d.requestedAmountUsd ?? 0).toFixed(2))}</td><td>${escapeHtml(Number(d.minAccepted ?? 0).toFixed(2))}</td><td>${escapeHtml(d.actualOutcomeAmount == null ? "-" : Number(d.actualOutcomeAmount).toFixed(8))}</td><td><code>${escapeHtml(String(d.tolerance))}</code></td><td>${escapeHtml(Number(d.creditedBalanceAmount ?? 0).toFixed(8))}</td><td>${renderPaymentStatus(d.status)}</td><td class="mono-wrap"><code>${escapeHtml(d.productId ?? "-")}</code></td><td><code>${escapeHtml(d.reason)}</code></td><td>${d.status === "CONFIRMED" ? `<span class="small">—</span>` : `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/deposits/${escapeHtml(d.orderId)}/emergency-confirm" style="margin:0"><input name="reason" type="text" placeholder="Support reason" style="min-width:180px" /><button type="submit" class="secondary" style="margin-top:6px;background:rgba(34,197,94,0.18);border-color:rgba(34,197,94,0.45);">Emergency confirm</button></form>`}</td></tr>`).join("")}</tbody></table>`
              : `<div class="small" style="margin-top:8px">Нет deposit rows</div>`}
          </details>
         </div>

         <div id="access-audit" class="card" style="margin-top:16px">
           <h3 style="margin-top:0">Аудит / события доступа</h3>
           <div class="small">Здесь видно, кому выдали доступ, когда он истекает, как отработали reminders и что произошло с expiry/removal pipeline.</div>
           ${
             recentAccessRights.length
               ? `<table class="paid-table" style="margin-top:12px">
                   <thead><tr><th>Пользователь</th><th>Продукт</th><th>Mode</th><th>Статус</th><th>Expires</th><th>linked chats</th><th>Reminders</th><th>Expiry / removal</th></tr></thead>
                   <tbody>
                     ${recentAccessRights.map((right) => {
                       const loc =
                         right.product.localizations.find((item) => item.languageCode === baseLang) ??
                         right.product.localizations.find((item) => item.languageCode === "ru") ??
                         right.product.localizations[0];
                       return `<tr>
                         <td>${renderUserLabel(right.user)}</td>
                         <td>${escapeHtml(loc?.title ?? right.product.code)}</td>
                         <td>${renderProductModeBadge(right.product)}</td>
                         <td>${renderAccessStatus(right)}</td>
                         <td>${formatIsoDate(right.activeUntil)}</td>
                         <td>${renderLinkedChatReadiness(right.product)}</td>
                         <td>${renderReminderSummary(right.id)}</td>
                         <td>${renderExpirySummary(right.id)}</td>
                       </tr>`;
                     }).join("")}
                   </tbody>
                 </table>`
               : `<div class="small" style="margin-top:10px">Пока нет access events для этого бота.</div>`
           }
         </div>

         <div style="margin-top:16px" class="row">
           <a href="/backoffice/bots/${escapeHtml(bot.id)}/settings" style="text-decoration:none"><button class="secondary" type="button">Назад</button></a>
         </div>`
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

  server.post("/backoffice/api/bots/:botId/paid/nowpayments-config", async (req, reply) => {
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
    const enabled = body?.enabled === "1" || body?.enabled === true;
    const ownerPayoutEnabled = body?.ownerPayoutEnabled === "1" || body?.ownerPayoutEnabled === true;
    const dailyPayoutEnabled = body?.dailyPayoutEnabled !== "0" && body?.dailyPayoutEnabled !== false;
    const ownerWalletAddress = String(body?.ownerWalletAddress ?? "").trim() || null;
    const settlementCurrency = "usdtbep20";
    const dailyPayoutMinAmount = Math.max(0, Number(body?.dailyPayoutMinAmount) || 0);

    await prisma.botPaymentProviderConfig.upsert({
      where: { botInstanceId: bot.id },
      create: {
        botInstanceId: bot.id,
        provider: "NOWPAYMENTS",
        enabled,
        ownerPayoutEnabled,
        dailyPayoutEnabled,
        ownerWalletAddress,
        settlementCurrency,
        dailyPayoutMinAmount
      },
      update: {
        enabled,
        ownerPayoutEnabled,
        dailyPayoutEnabled,
        ownerWalletAddress,
        settlementCurrency,
        dailyPayoutMinAmount
      }
    });

    return reply.redirect(`/backoffice/bots/${escapeHtml(bot.id)}/paid#nowpayments`);
  });

  server.post("/backoffice/api/bots/:botId/paid/paywall-message", async (req, reply) => {
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
    const paywallMessage = String(body?.paywallMessage ?? "").trim() || null;

    await prisma.botInstance.update({ where: { id: bot.id }, data: { paywallMessage } });

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
    const structuredLinkedChats = readStructuredLinkedChatsFromBody(body);
    const linkedChatsRaw = String(body?.linkedChatsRaw ?? "").trim();
    const linkedChats =
      structuredLinkedChats.length > 0
        ? structuredLinkedChats
        : linkedChatsRaw
          ? parseLinkedChatsFromForm(linkedChatsRaw)
          : [];
    const walletBep20 = String(body?.walletBep20 ?? "").trim() || null;
    const effectiveBillingType = durationMinutes != null && durationMinutes > 0 ? "TEMPORARY" : billingType === "TEMPORARY" ? "TEMPORARY" : "ONE_TIME";
    const linkedChatsValidationError = validateLinkedChatsForExpiringAccess({
      billingType: effectiveBillingType,
      durationDays,
      durationMinutes,
      linkedChats
    });
    const privateLinkedChatsError = validatePrivateLinkedChatsOnly(linkedChats);

    if (!titleRu || !payButtonTextRu || !price || !currency) return reply.code(400).send("Bad request");
    if (linkedChatsValidationError) {
      return reply.code(400).type("text/html").send(renderPage("Ошибка", `<div class="error">${escapeHtml(linkedChatsValidationError)}</div><a href="/backoffice/bots/${escapeHtml(bot.id)}/paid">← Назад</a>`));
    }
    if (privateLinkedChatsError) {
      return reply.code(400).type("text/html").send(renderPage("Ошибка", `<div class="error">${escapeHtml(privateLinkedChatsError)}</div><a href="/backoffice/bots/${escapeHtml(bot.id)}/paid">← Назад</a>`));
    }

    const code = `bot_${bot.id.slice(0, 8)}_${randomBytes(4).toString("hex")}`;

    await prisma.product.create({
      data: {
        code,
        type: "SECTION",
        price,
        currency,
        billingType: effectiveBillingType,
        durationDays: effectiveBillingType === "TEMPORARY" && durationMinutes == null && durationDays != null && durationDays > 0 ? durationDays : null,
        durationMinutes: durationMinutes != null && durationMinutes > 0 ? durationMinutes : null,
        linkedChats: linkedChats.length ? (linkedChats as any) : null,
        walletBep20,
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
    const structuredLinkedChats = readStructuredLinkedChatsFromBody(body);
    const linkedChatsRaw = String(body?.linkedChatsRaw ?? "").trim();
    const linkedChats =
      structuredLinkedChats.length > 0
        ? structuredLinkedChats
        : linkedChatsRaw
          ? parseLinkedChatsFromForm(linkedChatsRaw)
          : [];
    const walletBep20 = String(body?.walletBep20 ?? "").trim() || null;
    const effectiveBillingType = durationMinutes != null && durationMinutes > 0 ? "TEMPORARY" : billingType;
    const linkedChatsValidationError = validateLinkedChatsForExpiringAccess({
      billingType: effectiveBillingType,
      durationDays,
      durationMinutes,
      linkedChats
    });
    const privateLinkedChatsError = validatePrivateLinkedChatsOnly(linkedChats);

    if (!titleRu || !payButtonTextRu || !price || !currency) return reply.code(400).send("Bad request");
    if (linkedChatsValidationError) {
      return reply.code(400).type("text/html").send(renderPage("Ошибка", `<div class="error">${escapeHtml(linkedChatsValidationError)}</div><a href="/backoffice/bots/${escapeHtml(bot.id)}/paid">← Назад</a>`));
    }
    if (privateLinkedChatsError) {
      return reply.code(400).type("text/html").send(renderPage("Ошибка", `<div class="error">${escapeHtml(privateLinkedChatsError)}</div><a href="/backoffice/bots/${escapeHtml(bot.id)}/paid">← Назад</a>`));
    }

    const productExists = await prisma.product.findUnique({
      where: { id: productId }
    });
    if (!productExists) return reply.code(404).send("Product not found");

    await prisma.$transaction([
      prisma.product.update({
        where: { id: productId },
        data: {
          price,
          currency,
          billingType: effectiveBillingType,
          durationDays: effectiveBillingType === "TEMPORARY" && durationMinutes == null && durationDays != null && durationDays > 0 ? durationDays : null,
          durationMinutes: durationMinutes != null && durationMinutes > 0 ? durationMinutes : null,
          linkedChats: linkedChats.length ? (linkedChats as any) : null,
          walletBep20
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

  server.post("/backoffice/api/bots/:botId/deposits/:depositId/emergency-confirm", async (req, reply) => {
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
    const depositId = String((req.params as any)?.depositId ?? "");
    const body = req.body as any;
    const reason = String(body?.reason ?? "").trim();
    if (!reason) {
      return reply.redirect(
        `/backoffice/bots/${encodeURIComponent(botId)}/paid?error=${encodeURIComponent("Укажите причину emergency confirm")}`
      );
    }

    const bot = await prisma.botInstance.findUnique({ where: { id: botId } });
    if (!bot) return reply.code(404).send("Bot not found");
    if (bot.ownerBackofficeUserId && bot.ownerBackofficeUserId !== backofficeUserId) return reply.code(403).send("Forbidden");

    const superAdmin = await ensureSuperAdminTelegramUser(prisma);
    const runtime = await runtimeManager.startBotInstance(bot.id, { launch: false });
    const result = await runtime.services.balance.emergencyConfirmDeposit(depositId, superAdmin.id, reason);
    if (!result.ok && result.error === "not_found") {
      return reply.redirect(
        `/backoffice/bots/${encodeURIComponent(bot.id)}/paid?error=${encodeURIComponent("Deposit не найден")}`
      );
    }
    if (!result.ok) {
      return reply.redirect(
        `/backoffice/bots/${encodeURIComponent(bot.id)}/paid?error=${encodeURIComponent("Emergency confirm не выполнен")}`
      );
    }
    const msg = result.alreadyConfirmed
      ? "Deposit уже подтвержден ранее"
      : `Deposit подтвержден вручную, credited=${Number(result.creditedAmount ?? 0).toFixed(2)}`;
    return reply.redirect(`/backoffice/bots/${encodeURIComponent(bot.id)}/paid?ok=${encodeURIComponent(msg)}`);
  });
}
