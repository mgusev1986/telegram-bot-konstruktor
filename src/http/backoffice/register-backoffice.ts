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
import { readStructuredLinkedChatsFromBody } from "../../common/backoffice-linked-chat-form";
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

function getBackofficeLang(_req: FastifyRequest): "ru" | "en" {
  // Интерфейс backoffice всегда на русском (см. требования владельца).
  return "ru";
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
      :root {
        color-scheme: dark;
        --bg: #0b1119;
        --bg-deep: #101827;
        --shell: #182130;
        --surface: #202a3a;
        --surface-raised: #283549;
        --surface-utility: #1c2737;
        --surface-diagnostic: #152031;
        --surface-table: #141e2c;
        --surface-soft: rgba(255,255,255,0.03);
        --surface-inline: rgba(255,255,255,0.055);
        --border: rgba(226,232,240,0.11);
        --border-soft: rgba(226,232,240,0.075);
        --border-strong: rgba(226,232,240,0.18);
        --text: #f6f8fc;
        --text-soft: #e7edf6;
        --muted: #a0b0c5;
        --muted-strong: #d2dceb;
        --link: #d3e0ff;
        --accent: #d5bfa0;
        --accent-strong: #eddec2;
        --accent-ink: #11161d;
        --success: #9fcab0;
        --warning: #ddc183;
        --danger: #f0a5a5;
        --danger-soft: rgba(240,165,165,0.1);
        --info: #adc5ff;
        --shadow-lg: 0 24px 56px rgba(3,7,14,0.28);
        --shadow-md: 0 12px 28px rgba(5,10,18,0.18);
        --shadow-sm: 0 8px 18px rgba(5,10,18,0.12);
        --radius-xl: 28px;
        --radius-lg: 22px;
        --radius-md: 18px;
        --radius-sm: 14px;
        --radius-xs: 10px;
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      section[id] { scroll-margin-top: 90px; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(173,197,255,0.11), transparent 38%),
          radial-gradient(circle at top right, rgba(216,195,162,0.08), transparent 30%),
          linear-gradient(180deg, #0a1119 0%, var(--bg) 24%, var(--bg-deep) 100%);
        color: var(--text);
        letter-spacing: 0.01em;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.012) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.01) 1px, transparent 1px);
        background-size: 120px 120px;
        mask-image: radial-gradient(circle at center, black 4%, transparent 72%);
        opacity: 0.2;
      }
      a { color: var(--link); text-decoration: none; }
      a:hover { color: #ffffff; }
      .wrap {
        width: 100%;
        max-width: 1540px;
        margin: 0 auto;
        padding: 24px 20px 56px;
        position: relative;
        z-index: 1;
      }
      .card, .bo-panel, .bo-hero {
        position: relative;
        overflow: hidden;
        border-radius: var(--radius-xl);
        border: 1px solid var(--border);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.012)),
          linear-gradient(180deg, rgba(27,37,53,0.98), rgba(20,29,42,0.98));
        box-shadow: var(--shadow-md);
        backdrop-filter: blur(18px);
      }
      .card {
        padding: 22px;
        overflow: visible;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.01)),
          linear-gradient(180deg, rgba(28,39,57,0.98), rgba(21,30,43,0.98));
        box-shadow: var(--shadow-lg);
      }
      .bo-panel { padding: 20px; }
      .bo-panel--raised {
        background:
          linear-gradient(180deg, rgba(40,54,74,0.98), rgba(28,38,53,0.98));
      }
      .bo-panel--utility {
        background:
          linear-gradient(180deg, rgba(31,43,60,0.98), rgba(22,31,44,0.98));
      }
      .bo-panel--diagnostic {
        background:
          linear-gradient(180deg, rgba(22,32,48,0.98), rgba(16,24,37,0.98));
        border-color: rgba(173,197,255,0.14);
      }
      .bo-page { display: flex; flex-direction: column; gap: 22px; }
      .bo-stage {
        padding: 20px;
        border-radius: var(--radius-xl);
        border: 1px solid var(--border-soft);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.018), rgba(255,255,255,0.008)),
          rgba(17,24,36,0.68);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.03), var(--shadow-sm);
      }
      .bo-stage--primary {
        background:
          linear-gradient(180deg, rgba(255,255,255,0.022), rgba(255,255,255,0.008)),
          rgba(20,29,42,0.78);
        border-color: rgba(226,232,240,0.11);
      }
      .bo-stage--utility {
        background:
          linear-gradient(180deg, rgba(255,255,255,0.016), rgba(255,255,255,0.006)),
          rgba(16,24,36,0.66);
      }
      .bo-stage--diagnostic {
        background:
          linear-gradient(180deg, rgba(173,197,255,0.035), rgba(255,255,255,0.004)),
          rgba(14,21,33,0.76);
        border-color: rgba(173,197,255,0.12);
      }
      .bo-stage-head {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        align-items: flex-start;
        flex-wrap: wrap;
        margin-bottom: 14px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border-soft);
      }
      .bo-stage-title {
        margin: 0;
        font-size: 22px;
        line-height: 1.08;
        letter-spacing: -0.04em;
      }
      .bo-stage-copy {
        margin-top: 8px;
        max-width: 78ch;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.65;
      }
      .bo-stage-body {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .bo-split-utility {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
        gap: 18px;
      }
      .bo-stage-grid-2 {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      .bo-stage-grid-rail {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
        gap: 18px;
      }
      .top-nav {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        margin-bottom: 14px;
        padding: 4px 2px;
      }
      .top-nav__meta {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        color: rgba(210,220,235,0.54);
      }
      .top-nav__actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .row, .bo-cluster {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }
      .row > * { flex: 1 1 auto; }
      .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 0.92fr); gap: 18px; }
      .subgrid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(300px, 0.9fr); gap: 18px; }
      .bo-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
      .bo-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
      .bo-grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
      .bo-stack { display: flex; flex-direction: column; gap: 16px; }
      .bo-stack--dense { gap: 12px; }
      .bo-stack--loose { gap: 24px; }
      .bo-hero {
        padding: 18px 22px;
        background:
          linear-gradient(180deg, rgba(40,54,75,0.96), rgba(26,37,53,0.98));
      }
      .bo-page-header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 18px;
        align-items: start;
      }
      .bo-page-overline {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        color: var(--accent-strong);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.18em;
      }
      .top-nav a,
      .top-nav button {
        padding: 9px 12px;
        min-height: 40px;
        background: var(--surface-inline);
        color: var(--muted-strong);
        border-color: var(--border-soft);
        font-size: 12px;
        font-weight: 600;
        box-shadow: none;
      }
      .bo-page-title {
        margin: 0;
        font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
        font-size: clamp(26px, 2.35vw, 36px);
        line-height: 1.05;
        letter-spacing: -0.04em;
      }
      .bo-page-subtitle {
        margin-top: 8px;
        max-width: 74ch;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.65;
      }
      .bo-context-list {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      .bo-context-chip, .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid var(--border-soft);
        background: var(--surface-inline);
        color: var(--muted-strong);
        font-size: 12px;
      }
      .bo-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
        align-items: center;
      }
      label {
        display: block;
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      input, textarea, select {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        border-radius: var(--radius-sm);
        border: 1px solid rgba(255,255,255,0.13);
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025));
        color: var(--text);
        padding: 12px 14px;
        min-height: 46px;
        outline: none;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
        transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
      }
      input::placeholder, textarea::placeholder { color: #6f7f98; }
      input:focus, textarea:focus, select:focus {
        border-color: rgba(216,195,162,0.46);
        box-shadow: 0 0 0 3px rgba(216,195,162,0.12);
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025));
      }
      textarea {
        min-height: 120px;
        resize: vertical;
        line-height: 1.55;
      }
      button,
      a.bo-btn,
      .top-nav a,
      .paid-nav a,
      .bo-link-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 11px 16px;
        border-radius: var(--radius-sm);
        border: 1px solid rgba(255,255,255,0.1);
        background: linear-gradient(180deg, rgba(226,232,240,0.94), rgba(196,204,216,0.88));
        color: var(--accent-ink);
        cursor: pointer;
        font-weight: 700;
        letter-spacing: 0.01em;
        transition: transform 0.18s ease, border-color 0.18s ease, filter 0.18s ease, background 0.18s ease;
        text-decoration: none;
      }
      button:hover,
      a.bo-btn:hover,
      .top-nav a:hover,
      .paid-nav a:hover,
      .bo-link-btn:hover {
        transform: translateY(-1px);
        filter: brightness(1.03);
      }
      button.secondary,
      a.bo-btn--secondary,
      .bo-link-btn--secondary,
      .paid-nav a,
      .top-nav a {
        background: rgba(255,255,255,0.05);
        color: var(--text-soft);
        border-color: rgba(255,255,255,0.1);
      }
      button.error,
      a.bo-btn--danger,
      .bo-link-btn--danger {
        background: rgba(240,165,165,0.14);
        border-color: rgba(240,165,165,0.28);
        color: #ffd6d6;
      }
      button.ghost,
      a.bo-btn--ghost,
      .bo-link-btn--ghost {
        background: transparent;
        color: var(--muted-strong);
        border-color: rgba(255,255,255,0.08);
      }
      button:disabled {
        opacity: 0.7;
        cursor: wait;
        transform: none;
      }
      a[aria-disabled="true"] {
        pointer-events: none;
        opacity: 0.55;
      }
      .small {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.55;
      }
      .muted { color: var(--muted); }
      .mono-wrap { min-width: 220px; max-width: 440px; }
      .wallet-col { min-width: 240px; max-width: 460px; }
      code,
      .bo-code {
        display: inline-block;
        max-width: 100%;
        padding: 3px 8px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.035);
        color: #e8edf6;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 12px;
        line-height: 1.5;
        word-break: break-word;
      }
      .error,
      .success,
      .warning-card,
      .danger-card,
      .bo-note {
        padding: 14px 16px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-soft);
        line-height: 1.6;
      }
      .error { background: rgba(240,165,165,0.1); border-color: rgba(240,165,165,0.24); color: #ffd1d1; }
      .success { background: rgba(159,202,176,0.12); border-color: rgba(159,202,176,0.24); color: #ddf7e6; }
      .warning-card { background: rgba(221,193,131,0.1); border-color: rgba(221,193,131,0.24); color: #f7e7bf; }
      .danger-card { background: rgba(240,165,165,0.1); border-color: rgba(240,165,165,0.24); color: #ffd1d1; }
      .bo-note--info { background: rgba(173,197,255,0.1); border-color: rgba(173,197,255,0.22); color: #d9e5ff; }
      .bo-note--warning { background: rgba(221,193,131,0.1); border-color: rgba(221,193,131,0.24); color: #f7e7bf; }
      .bo-note--danger { background: rgba(240,165,165,0.1); border-color: rgba(240,165,165,0.24); color: #ffd1d1; }
      .bo-note--success { background: rgba(159,202,176,0.12); border-color: rgba(159,202,176,0.24); color: #ddf7e6; }
      .bo-kpi-grid,
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
      }
      .bo-kpi-card,
      .overview-card,
      .bot-card,
      .mi-card,
      .product-card,
      .linked-chat-card {
        position: relative;
        min-width: 0;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-soft);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.016)),
          rgba(29,40,57,0.84);
        box-shadow: none;
      }
      .bo-kpi-card,
      .overview-card { padding: 18px; }
      .bo-kpi-card {
        display: flex;
        flex-direction: column;
        min-height: 124px;
      }
      .bo-kpi-label {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .bo-kpi-value,
      .overview-card .value {
        margin-top: 8px;
        font-size: clamp(24px, 2.5vw, 34px);
        line-height: 1.05;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.04em;
      }
      .bo-kpi-helper { margin-top: 10px; color: var(--muted-strong); font-size: 13px; line-height: 1.55; }
      .bo-kpi-card .bo-kpi-helper { margin-top: auto; padding-top: 10px; }
      .bo-kpi-card--compact .bo-kpi-value {
        font-size: 24px;
      }
      .bo-panel-header,
      .bo-section-head,
      .product-card-header,
      .bo-subsection-head {
        display: flex;
        gap: 14px;
        justify-content: space-between;
        align-items: flex-start;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .bo-section-title {
        margin: 0;
        font-size: 20px;
        font-weight: 700;
        line-height: 1.15;
        letter-spacing: -0.03em;
      }
      .bo-section-text { margin-top: 6px; color: var(--muted); font-size: 14px; line-height: 1.65; }
      .bo-subsection {
        padding: 16px 18px;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.018);
      }
      .bo-subsection--raised {
        background: linear-gradient(180deg, rgba(37,50,69,0.95), rgba(27,37,53,0.96));
      }
      .bo-subsection--utility {
        background: linear-gradient(180deg, rgba(31,42,58,0.95), rgba(23,32,45,0.96));
      }
      .bo-subsection--diagnostic {
        background: linear-gradient(180deg, rgba(24,34,49,0.96), rgba(18,27,40,0.96));
        border-color: rgba(173,197,255,0.12);
      }
      .bo-subsection-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }
      .bo-subsection-copy {
        margin-top: 5px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
        max-width: 72ch;
      }
      .bo-subsection + .bo-subsection {
        margin-top: 16px;
      }
      .bo-stage .bo-subsection + .bo-subsection {
        margin-top: 14px;
      }
      .bot-card {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        box-shadow: var(--shadow-sm);
      }
      .bo-inline-meta {
        display: flex;
        gap: 10px 18px;
        flex-wrap: wrap;
        align-items: center;
      }
      .bo-inline-meta-item {
        display: inline-flex;
        gap: 8px;
        align-items: baseline;
        min-width: 0;
      }
      .bo-inline-meta-label {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .bo-inline-meta-value {
        color: var(--text-soft);
        font-size: 13px;
        line-height: 1.5;
        min-width: 0;
        word-break: break-word;
      }
      .bot-card.created {
        border-color: rgba(159,202,176,0.42);
        box-shadow: 0 0 0 1px rgba(159,202,176,0.25), var(--shadow-md);
      }
      .bot-title {
        font-size: 19px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .bo-stateline {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .bo-meta-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .bo-meta-tile {
        padding: 13px 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-soft);
        background: var(--surface-inline);
      }
      .bo-meta-label {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .bo-meta-value {
        margin-top: 7px;
        color: var(--text-soft);
        font-size: 14px;
        line-height: 1.55;
        word-break: break-word;
      }
      .bo-action-groups {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .bo-action-group {
        padding: 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-soft);
        background: var(--surface-soft);
      }
      .bo-action-group--muted {
        background: rgba(255,255,255,0.018);
      }
      .bo-action-label {
        margin-bottom: 10px;
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .status-live { background: rgba(159,202,176,0.12); color: #d8f1e1; border-color: rgba(159,202,176,0.26); }
      .status-test { background: rgba(221,193,131,0.12); color: #f4e3b7; border-color: rgba(221,193,131,0.28); }
      .status-active { background: rgba(173,197,255,0.12); color: #dbe7ff; border-color: rgba(173,197,255,0.28); }
      .status-pending { background: rgba(221,193,131,0.12); color: #f4e3b7; border-color: rgba(221,193,131,0.28); }
      .status-expiring { background: rgba(237,154,106,0.12); color: #ffd7bb; border-color: rgba(237,154,106,0.28); }
      .status-expired { background: rgba(240,165,165,0.1); color: #ffd2d2; border-color: rgba(240,165,165,0.24); }
      .status-failed { background: rgba(240,165,165,0.12); color: #ffd5d5; border-color: rgba(240,165,165,0.3); }
      .status-muted { background: rgba(148,163,184,0.1); color: #d3dbe7; border-color: rgba(148,163,184,0.2); }
      .form-row {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        flex-wrap: wrap;
      }
      .form-row label { margin-bottom: 8px; }
      .form-row .field,
      .field-wrap {
        flex: 1 1 220px;
        min-width: 0;
      }
      .form-row select.field { width: auto; min-width: 140px; max-width: 280px; }
      .bo-form-cluster {
        padding: 16px;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.022);
      }
      .bo-form-cluster-head {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      .bo-form-cluster-title {
        margin: 0;
        color: var(--muted-strong);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .bo-form-cluster-copy {
        margin-top: 6px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .product-form-grid,
      .nowpayments-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px 18px;
        align-items: start;
      }
      .product-form-grid .field-wrap input,
      .product-form-grid .field-wrap select,
      .product-form-grid .field-wrap textarea,
      .nowpayments-grid .field-wrap input {
        width: 100%;
      }
      .linked-chat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        margin-top: 10px;
      }
      .linked-chat-card {
        padding: 16px;
      }
      .linked-chat-card .title {
        margin-bottom: 10px;
        color: var(--muted-strong);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.16em;
      }
      .linked-chat-card .field-wrap { margin-bottom: 10px; }
      .linked-chat-card .field-wrap:last-child { margin-bottom: 0; }
      .toggle-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 50px;
        padding: 10px 14px;
        border-radius: var(--radius-md);
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
      }
      .toggle-field label {
        margin: 0;
        font-size: 12px;
        color: var(--muted-strong);
      }
      .toggle-field input[type="checkbox"] {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        padding: 0;
        margin: 0;
        accent-color: #d8c3a2;
      }
      .mini-btn {
        padding: 8px 10px;
        min-height: auto;
        font-size: 12px;
        border-radius: 12px;
      }
      .field-inline { display: flex; gap: 8px; align-items: center; }
      .field-inline input { flex: 1 1 auto; min-width: 0; }
      .id-hint { margin-top: 6px; font-size: 11px; color: var(--muted); min-height: 16px; }
      .id-hint.ok { color: #bce8cd; }
      .id-hint.err { color: #ffc2c2; }
      .test-block {
        padding: 16px;
        border-radius: var(--radius-lg);
        border: 1px dashed rgba(221,193,131,0.32);
        background: rgba(221,193,131,0.05);
      }
      .section-title {
        margin: 16px 0 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border-soft);
        color: var(--muted-strong);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .section-title:first-child { margin-top: 0; }
      .bo-toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px;
        padding: 18px;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-soft);
        background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02));
      }
      .bo-toolbar-main {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
      }
      .bo-toolbar-side {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: flex-end;
        justify-content: flex-end;
      }
      .bo-export-list {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .bo-data-caption {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .bo-table-shell,
      .events-scroll,
      .table-wrap {
        overflow: auto;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-soft);
        background: linear-gradient(180deg, rgba(26,36,51,0.96), rgba(20,29,43,0.98));
      }
      .bo-table-shell { padding: 0; }
      .events-scroll { max-height: 460px; }
      table,
      .paid-table {
        width: 100%;
        min-width: 100%;
        border-collapse: collapse;
        table-layout: auto;
      }
      table thead th,
      .paid-table th {
        padding: 12px 14px;
        text-align: left;
        vertical-align: bottom;
        color: #b6c5d8;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        background: rgba(255,255,255,0.05);
        border-bottom: 1px solid var(--border-soft);
        position: sticky;
        top: 0;
        z-index: 2;
        backdrop-filter: blur(16px);
      }
      table tbody td,
      .paid-table td {
        padding: 14px;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      table tbody td {
        white-space: normal;
      }
      .paid-table td {
        white-space: normal;
      }
      .paid-table td.table-nowrap { white-space: nowrap; }
      table tbody tr:hover,
      .paid-table tbody tr:hover {
        background: rgba(255,255,255,0.03);
      }
      table tbody tr:nth-child(even),
      .paid-table tbody tr:nth-child(even) {
        background: rgba(255,255,255,0.018);
      }
      table tbody tr:last-child td,
      .paid-table tr:last-child td {
        border-bottom: none;
      }
      .paid-table td code,
      table td code {
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .table-title {
        font-size: 14px;
        font-weight: 700;
        line-height: 1.4;
        color: var(--text-soft);
      }
      .table-meta {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .table-nowrap {
        white-space: nowrap;
      }
      .table-total-row td {
        border-top: 2px solid var(--border-strong);
        font-weight: 700;
        background: rgba(255,255,255,0.04);
      }
      .table-number { text-align: right; font-variant-numeric: tabular-nums; }
      .overview-card,
      .product-card,
      .mi-card {
        padding: 18px;
      }
      .products-existing-block {
        margin-top: 26px;
        padding-top: 20px;
        border-top: 1px solid var(--border-soft);
      }
      .bo-workspace-nav {
        position: sticky;
        top: 12px;
        z-index: 8;
      }
      .bo-workspace-nav .bo-section-head {
        margin-bottom: 12px;
      }
      .paid-nav {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .paid-nav a {
        padding: 8px 12px;
        border-radius: 999px;
        border-color: var(--border-soft);
        background: var(--surface-inline);
        color: var(--muted-strong);
        font-size: 12px;
        font-weight: 600;
      }
      .flow-list {
        margin: 0;
        padding-left: 18px;
        color: var(--muted-strong);
      }
      .flow-list li { margin: 8px 0; }
      .flow-list li strong { color: var(--text-soft); }
      .mono-list {
        margin: 0;
        padding-left: 18px;
        color: var(--muted-strong);
      }
      .mono-list li { margin: 8px 0; }
      .mono-list li code { color: #eef2f9; }
      details {
        border-radius: var(--radius-lg);
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.02);
        padding: 0 16px 16px;
      }
      details > summary {
        list-style: none;
        cursor: pointer;
        padding: 14px 0;
      }
      details > summary::-webkit-details-marker { display: none; }
      @media (max-width: 1080px) {
        .grid,
        .subgrid,
        .bo-grid-3,
        .bo-grid-4 {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 900px) {
        .wrap { padding: 16px 12px 36px; }
        .card,
        .bo-hero { padding: 18px; }
        .top-nav { align-items: flex-start; }
        .top-nav__actions { width: 100%; }
        .bo-page-header,
        .bo-toolbar {
          grid-template-columns: 1fr;
        }
        .product-form-grid,
        .linked-chat-grid,
        .nowpayments-grid,
        .bo-grid-2,
        .bo-stage-grid-2,
        .bo-stage-grid-rail,
        .bo-meta-grid,
        .bo-action-groups,
        .bo-split-utility {
          grid-template-columns: 1fr;
        }
        table,
        .paid-table {
          font-size: 12px;
        }
      }
      @media (max-width: 640px) {
        .top-nav { flex-direction: column; align-items: stretch; }
        .top-nav__actions { justify-content: stretch; }
        .top-nav__actions > * { flex: 1 1 auto; }
        button,
        a.bo-btn,
        .paid-nav a,
        .top-nav a {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top-nav">
        <div class="top-nav__meta">Telegram Bot Konstruktor · Backoffice</div>
        <div class="top-nav__actions">
          <button class="secondary" type="button" onclick="history.back()">← Назад</button>
          <a href="/backoffice" class="bo-btn bo-btn--secondary">Главная backoffice</a>
        </div>
      </div>
      <div class="card">
        <div class="bo-page">
          ${body}
        </div>
      </div>
    </div>
    <script>
      (function () {
        function __extractIdFromPostLink(value) {
          if (!value) return "";
          var text = String(value).trim();
          var match = text.match(/t\\.me\\/(c|o)\\/(\\d+)/i);
          if (match && match[2]) return "-100" + match[2];
          return "";
        }

        function __setIdHint(form, idx, mode, text) {
          var hint = form.querySelector('[data-id-hint="' + idx + '"]');
          if (!hint) return;
          hint.textContent = text || "";
          hint.className = "id-hint" + (mode ? " " + mode : "");
        }

        function __fillIdentifier(form, idx, showError) {
          var postInput = form.querySelector('input[name="linkedChatPostLink' + idx + '"]');
          var linkInput = form.querySelector('input[name="linkedChatLink' + idx + '"]');
          var idInput = form.querySelector('input[name="linkedChatIdentifier' + idx + '"]');
          if (!idInput) return false;
          var extracted =
            __extractIdFromPostLink((postInput && postInput.value) || "") ||
            __extractIdFromPostLink((linkInput && linkInput.value) || "") ||
            __extractIdFromPostLink(idInput.value || "");
          if (!extracted) {
            if (showError) __setIdHint(form, idx, "err", "Не удалось распознать post-link");
            return false;
          }
          idInput.value = extracted;
          __setIdHint(form, idx, "ok", "ID извлечен");
          return true;
        }

        document.addEventListener(
          "click",
          function (ev) {
            var t = ev.target;
            while (t && t.nodeType !== 1) t = t.parentNode;
            while (t && !t.getAttribute("data-linked-chat-extract")) t = t.parentNode;
            if (!t) return;
            var idx = t.getAttribute("data-linked-chat-extract");
            if (!idx) return;
            ev.preventDefault();
            var form = t;
            while (form && form.nodeName !== "FORM") form = form.parentNode;
            if (!form) return;
            __fillIdentifier(form, String(idx), true);
          },
          false
        );
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
  const normalizePrivateIdentifier = (value: string): string => {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const linkMatch = raw.match(/t\.me\/(?:c|o)\/(\d+)/i);
    if (linkMatch) return `-100${linkMatch[1]}`;
    if (/^-100\d{6,}$/.test(raw)) return raw;
    if (/^100\d{6,}$/.test(raw)) return `-${raw}`;
    if (/^\d{6,}$/.test(raw)) return `-100${raw}`;
    return raw;
  };

  for (let i = 0; i < linkedChats.length; i++) {
    const row = linkedChats[i] ?? {};
    const idx = i + 1;
    const identifier = normalizePrivateIdentifier(String(row.identifier ?? "").trim());
    const link = String(row.link ?? "").trim();

    if (!identifier) {
      return `linkedChats: строка ${idx} — для приватного доступа обязателен identifier (chat/channel id вида -100...).`;
    }
    if (!/^-100\d{6,}$/.test(identifier)) {
      return `linkedChats: строка ${idx} — разрешен только приватный identifier вида -100... (публичные @username запрещены).`;
    }
    if (link && !/^https:\/\/t\.me\/(?:\+|joinchat\/)/i.test(link) && !/^https:\/\/t\.me\/(?:c|o)\/\d+(?:\/\d+)?\/?(?:\?.*)?$/i.test(link)) {
      return `linkedChats: строка ${idx} — разрешены invite-ссылки https://t.me/+... / joinchat/... или ссылка на пост вида https://t.me/c/...`;
    }
  }
  return null;
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

/** YYYY-MM-DD in a given IANA time zone (for «сегодня» / «вчера» в таймзоне выплат). */
function calendarDateInTimeZone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function parseYmd(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T12:00:00.000Z`);
  if (Number.isNaN(t)) return null;
  return s;
}

/** Subtract N calendar days from a Y-M-D string (Gregorian, UTC date math). */
function subtractCalendarDaysFromYmd(ymd: string, days: number): string {
  const parts = ymd.split("-").map((v) => Number(v));
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

function ymdInInclusiveRange(ymd: string, fromInc: string, toInc: string): boolean {
  return ymd >= fromInc && ymd <= toInc;
}

function normalizeOwnerReportRange(fromRaw: string | null, toRaw: string | null, payoutTz: string): { from: string; to: string } {
  const defaultTo = calendarDateInTimeZone(new Date(), payoutTz);
  const defaultFrom = subtractCalendarDaysFromYmd(defaultTo, 30);
  let from = fromRaw ?? defaultFrom;
  let to = toRaw ?? defaultTo;
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  return { from, to };
}

function csvEscapeCell(value: string): string {
  if (/[;"\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
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
    ? renderStatusBadge("ТЕСТ", "test")
    : renderStatusBadge("БОЕВОЙ", "live");
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

type ActionTone = "primary" | "secondary" | "ghost" | "danger";

function renderActionLink(label: string, href: string, tone: ActionTone = "secondary", attrs = ""): string {
  const toneClass =
    tone === "danger"
      ? "bo-link-btn bo-link-btn--danger"
      : tone === "ghost"
        ? "bo-link-btn bo-link-btn--ghost"
        : tone === "secondary"
          ? "bo-link-btn bo-link-btn--secondary"
          : "bo-link-btn";
  return `<a href="${escapeHtml(href)}" class="${toneClass}"${attrs ? ` ${attrs}` : ""}>${escapeHtml(label)}</a>`;
}

function renderMetricCard(label: string, value: string, helper = "", extraClass = ""): string {
  return `<div class="bo-kpi-card${extraClass ? ` ${extraClass}` : ""}">
    <div class="bo-kpi-label">${escapeHtml(label)}</div>
    <div class="bo-kpi-value">${value}</div>
    ${helper ? `<div class="bo-kpi-helper">${helper}</div>` : ""}
  </div>`;
}

function renderPageHeader(params: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  context?: string[];
  actions?: string;
}): string {
  return `<section class="bo-hero">
    <div class="bo-page-header">
      <div>
        ${params.eyebrow ? `<div class="bo-page-overline">${escapeHtml(params.eyebrow)}</div>` : ""}
        <h1 class="bo-page-title">${escapeHtml(params.title)}</h1>
        ${params.subtitle ? `<div class="bo-page-subtitle">${params.subtitle}</div>` : ""}
        ${
          params.context?.length
            ? `<div class="bo-context-list">${params.context.map((item) => `<span class="bo-context-chip">${item}</span>`).join("")}</div>`
            : ""
        }
      </div>
      ${params.actions ? `<div class="bo-actions">${params.actions}</div>` : ""}
    </div>
  </section>`;
}

function renderSubsection(params: {
  id?: string;
  title: string;
  subtitle?: string;
  actions?: string;
  body: string;
  tone?: "default" | "raised" | "utility" | "diagnostic";
}): string {
  const toneClass =
    params.tone === "raised"
      ? " bo-subsection--raised"
      : params.tone === "utility"
        ? " bo-subsection--utility"
        : params.tone === "diagnostic"
          ? " bo-subsection--diagnostic"
          : "";
  return `<section${params.id ? ` id="${escapeHtml(params.id)}"` : ""} class="bo-subsection${toneClass}">
    <div class="bo-subsection-head">
      <div>
        <h3 class="bo-subsection-title">${escapeHtml(params.title)}</h3>
        ${params.subtitle ? `<div class="bo-subsection-copy">${params.subtitle}</div>` : ""}
      </div>
      ${params.actions ? `<div class="bo-actions">${params.actions}</div>` : ""}
    </div>
    ${params.body}
  </section>`;
}

function renderStageBlock(params: {
  id?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: string;
  body: string;
  tone?: "default" | "primary" | "utility" | "diagnostic";
}): string {
  const toneClass =
    params.tone === "primary"
      ? " bo-stage--primary"
      : params.tone === "utility"
        ? " bo-stage--utility"
        : params.tone === "diagnostic"
          ? " bo-stage--diagnostic"
          : "";
  return `<section${params.id ? ` id="${escapeHtml(params.id)}"` : ""} class="bo-stage${toneClass}">
    <div class="bo-stage-head">
      <div>
        ${params.eyebrow ? `<div class="bo-page-overline">${escapeHtml(params.eyebrow)}</div>` : ""}
        <h2 class="bo-stage-title">${escapeHtml(params.title)}</h2>
        ${params.subtitle ? `<div class="bo-stage-copy">${params.subtitle}</div>` : ""}
      </div>
      ${params.actions ? `<div class="bo-actions">${params.actions}</div>` : ""}
    </div>
    <div class="bo-stage-body">
      ${params.body}
    </div>
  </section>`;
}

function renderNote(
  tone: "info" | "warning" | "danger" | "success",
  body: string,
  title?: string
): string {
  return `<div class="bo-note bo-note--${tone}">${title ? `<strong>${escapeHtml(title)}</strong><br>` : ""}${body}</div>`;
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
            <form id="create-bot-form" method="POST" action="/backoffice/api/bots/create" class="bo-stack" style="margin-top:12px" onsubmit="var btn=this.querySelector('button[type=submit]');if(btn&&!btn.disabled){btn.disabled=true;btn.textContent='Создание…';}">
              ${renderNote("info", `После создания появится новый <code>BotInstance</code> и активный template с базовой структурой. Токен не сохраняется в открытом виде.`)}
              <div class="bo-form-cluster">
                <div class="bo-form-cluster-head">
                  <div>
                    <div class="bo-form-cluster-title">Идентификация и запуск</div>
                    <div class="bo-form-cluster-copy">Запускающий блок для нового экземпляра бота: название, токен, username и базовый язык собраны в одном рабочем модуле.</div>
                  </div>
                </div>
                <div class="bo-grid-2">
                  <div>
                    <label>Название бота</label>
                    <input name="name" type="text" required value="${name}" />
                  </div>
                  <div>
                    <label>Telegram Bot Token</label>
                    <input name="telegramBotToken" type="text" required placeholder="Введите токен" autocomplete="off" />
                  </div>
                </div>
                <div class="bo-grid-2" style="margin-top:14px">
                  <div>
                    <label>Telegram Username бота (опционально)</label>
                    <input name="telegramBotUsername" type="text" placeholder="my_bot" value="${username}" />
                  </div>
                  <div>
                    <label>Базовый язык</label>
                    <select name="baseLanguageCode">
                      ${langSelectOptions}
                    </select>
                  </div>
                </div>
              </div>
              <div class="bo-form-cluster">
                <div class="bo-form-cluster-head">
                  <div>
                    <div class="bo-form-cluster-title">Владелец и сопровождение</div>
                    <div class="bo-form-cluster-copy">Опциональная привязка будущего owner-пользователя. Permission flow и активация ролей остаются прежними.</div>
                  </div>
                </div>
                <div>
                  <label>Username владельца (опционально)</label>
                  <input name="ownerTelegramUsername" type="text" placeholder="@username клиента, создавшего токен" value="${ownerUsername}" />
                  <div class="small" style="margin-top:6px">Будущий владелец увидит пустой экран до активации роли в разделе «Роли».</div>
                </div>
              </div>
              <div class="bo-actions" style="justify-content:flex-start">
                <button type="submit" id="create-bot-submit">Создать бота</button>
              </div>
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
  const totalBots = bots.length;
  const activeBots = bots.filter((b) => b.status === "ACTIVE").length;
  const disabledBots = bots.filter((b) => b.status === "DISABLED").length;
  const newestBot = bots[0];
  const cards = bots
    .map((b) => {
      const openUrl = b.telegramBotUsername ? `https://t.me/${b.telegramBotUsername}` : "#";
      const settingsBtn = canPerform(role, "bot_settings:write", email)
        ? renderActionLink("Настройки", `/backoffice/bots/${b.id}/settings`, "primary")
        : ``;
      const rolesBtn = canPerform(role, "bot_roles:manage", email)
        ? renderActionLink(i18n.t(lang, "bo_roles_btn"), `/backoffice/bots/${b.id}/roles`, "secondary")
        : ``;
      const cloneBtn = canPerform(role, "bot_clone:create", email)
        ? renderActionLink("Клонировать шаблон", `/backoffice/bots/${b.id}/clone`, "ghost")
        : ``;
      const paidBtn = canPerform(role, "paid_access:manage", email)
        ? renderActionLink("Оплаты и доступ", `/backoffice/bots/${b.id}/paid`, "secondary")
        : ``;
      const audienceBtn = canViewAudience
        ? renderActionLink("Аудитория", `/backoffice/audience?bot=${encodeURIComponent(b.id)}`, "secondary")
        : ``;
      const openBtn = renderActionLink(
        "Открыть",
        openUrl,
        "ghost",
        b.telegramBotUsername ? `target="_blank" rel="noopener noreferrer"` : `aria-disabled="true"`
      );
      const primaryActions = [settingsBtn, paidBtn, audienceBtn].filter(Boolean);
      const secondaryActions = [rolesBtn, cloneBtn, openBtn].filter(Boolean);
      const createdClass = b.id === createdBotId ? " created" : "";
      const cardId = b.id === createdBotId ? ` id="bot-${b.id}"` : "";
      return `<div class="bot-card${createdClass}"${cardId}>
          <div class="bo-panel-header">
            <div style="min-width:220px">
              <div class="bo-stateline">
                <span class="pill">${escapeHtml(b.status === "ACTIVE" ? "Активен" : b.status === "DISABLED" ? "Отключён" : b.status)}</span>
                <span class="small">Создан ${formatIsoDate(b.createdAt).slice(0, 10)}</span>
              </div>
              <div class="bot-title" style="margin-top:10px">${escapeHtml(b.name)}</div>
              <div class="small" style="margin-top:6px">@${escapeHtml(b.telegramBotUsername ?? "—")}</div>
            </div>
            ${primaryActions.length ? `<div class="bo-actions">${primaryActions.join("")}</div>` : ""}
          </div>
          <div class="bo-inline-meta">
            <div class="bo-inline-meta-item">
              <span class="bo-inline-meta-label">ID</span>
              <span class="bo-inline-meta-value"><code>${escapeHtml(b.id)}</code></span>
            </div>
            <div class="bo-inline-meta-item">
              <span class="bo-inline-meta-label">Telegram</span>
              <span class="bo-inline-meta-value">${b.telegramBotUsername ? `@${escapeHtml(b.telegramBotUsername)}` : "Username не задан"}</span>
            </div>
            <div class="bo-inline-meta-item">
              <span class="bo-inline-meta-label">Контур</span>
              <span class="bo-inline-meta-value">${primaryActions.length ? `Доступно ${primaryActions.length} основных действия.` : "Набор действий определяется ролью."}</span>
            </div>
          </div>
          <div class="bo-action-group bo-action-group--muted">
            <div class="bo-action-label">Управление и утилиты</div>
            <div class="bo-actions" style="justify-content:flex-start">
              ${secondaryActions.join("") || `<span class="small">Дополнительные действия станут доступны по роли или после настройки username.</span>`}
            </div>
          </div>
        </div>`;
    })
    .join("\n");
  const audienceLink = canViewAudience
    ? renderActionLink("Аудитория", "/backoffice/audience", "secondary")
    : "";
  const databaseLink = canViewAudience
    ? renderActionLink("База данных", "/backoffice/database", "secondary")
    : "";
  const successBanner =
    createdBot && createdBotId
      ? `<div class="success" role="status"><strong>Бот успешно создан</strong>: ${escapeHtml(createdBot.name)}${createdBot.telegramBotUsername ? ` (@${escapeHtml(createdBot.telegramBotUsername)})` : ""}. <a href="/backoffice/bots/${escapeHtml(createdBot.id)}/settings">Настройки</a> · <a href="${createdBot.telegramBotUsername ? `https://t.me/${createdBot.telegramBotUsername}` : "#"}" target="_blank">Открыть в Telegram</a></div>`
      : "";
  const createForm = buildCreateBotForm({ createError, formValues, languageOptions });
  const scrollScript = createdBotId
    ? `<script>(function(){var el=document.getElementById("bot-${escapeHtml(createdBotId)}");if(el&&el.scrollIntoView)el.scrollIntoView({behavior:"smooth",block:"nearest"});})();</script>`
    : "";
  const actionCards = [
    canViewAudience
      ? renderSubsection({
          title: "Аудитория",
          subtitle: "Платформенный каталог пользователей, фильтры и экспорт по всем ботам.",
          body: `<div class="bo-actions" style="justify-content:flex-start">${audienceLink}</div>`,
          tone: "utility"
        })
      : "",
    canViewAudience
      ? renderSubsection({
          title: "База данных",
          subtitle: "Компактная аналитика по ботам: пользователи, рассылки, платежи и структура.",
          body: `<div class="bo-actions" style="justify-content:flex-start">${databaseLink}</div>`,
          tone: "utility"
        })
      : "",
    renderSubsection({
      title: "Сессия и навигация",
      subtitle: "Создание нового бота вынесено в отдельный модуль ниже, а выход из backoffice оставлен тихим системным действием.",
      body: `<div class="bo-actions" style="justify-content:flex-start">
          ${renderActionLink("Создать бота", "#create-bot-panel", "primary")}
          ${renderActionLink("Выйти", "/backoffice/logout", "ghost")}
        </div>`,
      tone: "raised"
    })
  ]
    .filter(Boolean)
    .join("");
  return `${renderPageHeader({
    eyebrow: "Операционный центр",
    title: "Панель управления",
    subtitle:
      "Backoffice собран вокруг существующих экземпляров ботов: быстрый переход в настройки, оплату и доступ, аудиторию и платформенную аналитику без изменения бизнес-логики.",
    context: [
      `<span>Роль: <strong>${escapeHtml(role)}</strong></span>`,
      `<span>Email: <strong>${escapeHtml(email)}</strong></span>`,
      newestBot ? `<span>Последний созданный: <strong>${escapeHtml(newestBot.name)}</strong></span>` : `<span>Боты ещё не созданы</span>`
    ],
    actions: [
      renderActionLink("Создать бота", "#create-bot-panel", "primary"),
      audienceLink,
      databaseLink,
      renderActionLink("Выйти", "/backoffice/logout", "ghost")
    ]
      .filter(Boolean)
      .join("")
  })}
        <div class="bo-kpi-grid">
          ${renderMetricCard("Всего ботов", String(totalBots), newestBot ? `Последний: <strong>${escapeHtml(newestBot.name)}</strong>` : `Создайте первый экземпляр бота`)}
          ${renderMetricCard("Активные", String(activeBots), activeBots ? `${renderStatusBadge("Готовы к работе", "active")}` : `${renderStatusBadge("Нет активных", "muted")}`)}
          ${renderMetricCard("Отключённые", String(disabledBots), disabledBots ? `${renderStatusBadge("Требуют внимания", "failed")}` : `${renderStatusBadge("Без отключений", "active")}`)}
          ${renderMetricCard("Навигация", canViewAudience ? "3" : "1", canViewAudience ? `Dashboard · Аудитория · База данных` : `Доступен только dashboard`)}
        </div>
        ${successBanner}
        ${renderStageBlock({
          eyebrow: "Навигация",
          title: "Системные действия и платформенные переходы",
          subtitle:
            "Глобальные действия вынесены из списка ботов в отдельную управляющую зону, чтобы сами экземпляры ботов перестали конкурировать с платформенной навигацией.",
          body: `<div class="bo-grid-3">${actionCards}</div>`,
          tone: "utility"
        })}
        ${renderStageBlock({
          eyebrow: "Рабочие контуры",
          title: "Экземпляры ботов",
          subtitle:
            "Карточки показывают состояние, контекст и приоритет действий быстрее, а сеточная композиция убирает ощущение длинного однотипного списка.",
          actions: `<span class="bo-context-chip">${bots.length} шт.</span>`,
          body:
            cards
              ? `<div class="bo-grid-2">${cards}</div>`
              : renderNote("warning", `Пока нет созданных <code>экземпляров ботов</code>. Используйте модуль запуска ниже, чтобы подготовить первый рабочий контур.`),
          tone: "primary"
        })}
        ${renderStageBlock({
          eyebrow: "Запуск нового экземпляра",
          title: "Создать нового бота",
          subtitle:
            "Создание вынесено в самостоятельный полноширинный модуль и больше не выглядит как побочная форма рядом со списком. Это отдельный операционный шаг с чётким контекстом и безопасными подсказками.",
          body: `${renderSubsection({
            id: "create-bot-panel",
            title: "Новый экземпляр бота",
            subtitle:
              "Заполняйте поля как launch-панель: имя, токен, username, владелец и базовый язык. Логика создания и проверка через getMe не менялись.",
            body: `${createForm}
              <div class="small">В целях безопасности токен не отображается после отправки. Проверка выполняется через <code>getMe</code>, а успешный бот автоматически подсвечивается в списке.`,
            tone: "raised"
          })}`,
          tone: "utility"
        })}
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
        "Вход в панель",
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
      return reply.type("text/html").send(renderPage("Вход в панель", `<div class="error">Слишком много попыток. Попробуйте позже.</div>`));
    }

    loginAttempts.set(attemptKey, {
      count: prev && now - prev.firstAt < windowMs ? prev.count + 1 : 1,
      firstAt: prev && now - prev.firstAt < windowMs ? prev.firstAt : now
    });

    const user = await prisma.backofficeUser.findUnique({ where: { email } });
    if (!user) {
      reply.code(401);
      return reply.type("text/html").send(renderPage("Вход в панель", `<div class="error">Неверный email или пароль.</div>`));
    }

    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      reply.code(401);
      return reply.type("text/html").send(renderPage("Вход в панель", `<div class="error">Неверный email или пароль.</div>`));
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
    return reply.type("text/html").send(renderPage("Панель управления", body));
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
      <td>
        <div class="table-title"><a href="/backoffice/audience/user/${encodeURIComponent(u.id)}"><strong>${escapeHtml(u.fullName || u.firstName || u.username ? `${u.fullName || u.firstName || `@${u.username}`}` : u.id.slice(0, 8))}</strong></a></div>
        <div class="table-meta">${u.username ? `<a href="https://t.me/${escapeHtml(u.username)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(u.username)}</a>` : `Без username`}</div>
      </td>
      <td>
        <div class="table-title"><code>${escapeHtml(String(u.telegramUserId))}</code></div>
        <div class="table-meta"><code>${escapeHtml(u.id)}</code></div>
      </td>
      <td>${u.botName ? `<div class="table-title">${escapeHtml(u.botName)}</div>` : `<span class="small">—</span>`}</td>
      <td><div class="table-title">${escapeHtml(u.selectedLanguage)}</div></td>
      <td class="table-nowrap">${u.lastSeenAt ? `<div>${escapeHtml(u.lastSeenAt.toISOString().slice(0, 19).replace("T", " "))}</div>` : `<span class="small">—</span>`}</td>
      <td class="table-nowrap"><div>${escapeHtml(u.createdAt.toISOString().slice(0, 19).replace("T", " "))}</div></td>
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

    const exportLinks = `
      ${renderActionLink("HTML", `/backoffice/audience/export?format=html${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`, "ghost")}
      ${renderActionLink("Excel", `/backoffice/audience/export?format=xlsx${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`, "ghost")}
      ${renderActionLink("CSV", `/backoffice/audience/export?format=csv${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`, "ghost")}`;
    const hasActiveFilters = Boolean(botId || search);

    return reply.type("text/html").send(
      renderPage(
        "Платформа: Аудитория",
        `${renderPageHeader({
          eyebrow: "Глобальный каталог",
          title: "Аудитория",
          subtitle:
            "Централизованная база пользователей по всем ботам. Фильтры и поиск остаются основным рабочим контуром, а экспорт вынесен в отдельный вторичный блок рядом с сегментацией.",
          context: [
            `<span>Всего в каталоге: <strong>${summary.totalUsers}</strong></span>`,
            `<span>Ботов в выборке: <strong>${summary.totalBots}</strong></span>`,
            botId ? `<span>Фильтр по боту активен</span>` : `<span>Показываются все боты</span>`
          ],
          actions: renderActionLink("← К списку ботов", "/backoffice", "secondary")
        })}
        <div class="bo-kpi-grid">
          ${renderMetricCard("Всего пользователей", String(summary.totalUsers), `Текущая выборка: <strong>${total}</strong>`)}
          ${renderMetricCard("Ботов", String(summary.totalBots), botId ? `Фильтр применён к одному боту` : `Покрытие всей платформы`)}
          ${renderMetricCard("Мультибот-пользователи", String(summary.multiBotUserCount), `Пересечение аудиторий между ботами`)}
          ${renderMetricCard("Страница", `${page}/${totalPages || 1}`, `По ${perPage} строк на экран`)}
        </div>
        ${renderStageBlock({
          eyebrow: "Сегментация",
          title: "Поиск, фильтры и экспорт",
          subtitle:
            "Фильтрация остаётся первичным действием для операторов. Экспорт вынесен в отдельный вторичный модуль, чтобы таблица ощущалась рабочим directory view, а не экраном выгрузки.",
          body: `<div class="bo-split-utility">
              ${renderSubsection({
                title: "Рабочий фильтр",
                subtitle: "Сузьте каталог по боту или по строкам профиля, не меняя существующую query-схему.",
                body: `<form method="GET" action="/backoffice/audience" class="bo-stack bo-stack--dense">
                    <div class="bo-toolbar-main">
                      <div>
                        <label>Бот</label>
                        <select name="bot">
                          <option value="">— Все боты —</option>
                          ${botOptions}
                        </select>
                      </div>
                      <div>
                        <label>Поиск (username, id, имя)</label>
                        <input name="search" type="text" value="${escapeHtml(search)}" placeholder="Поиск по каталогу..." />
                      </div>
                    </div>
                    <div class="bo-actions" style="justify-content:flex-start">
                      <button type="submit">Применить фильтр</button>
                      ${hasActiveFilters ? renderActionLink("Сбросить", "/backoffice/audience", "ghost") : ""}
                    </div>
                  </form>`,
                tone: "raised"
              })}
              ${renderSubsection({
                title: "Экспорт выборки",
                subtitle: "Все выгрузки сохраняют текущие фильтры и поиск. Форматы не убраны, но больше не спорят за внимание с сегментацией.",
                body: `<div class="bo-stack bo-stack--dense">
                    <div class="bo-export-list">${exportLinks}</div>
                    <div class="bo-data-caption">HTML удобно для быстрых ручных просмотров, Excel и CSV оставлены для последующей аналитики и передачи данных.</div>
                    ${renderNote("info", hasActiveFilters ? "Выгрузка будет построена по текущей отфильтрованной выборке." : "Сейчас выгружается весь каталог пользователей по всем ботам.")}
                  </div>`,
                tone: "utility"
              })}
            </div>`,
          tone: "utility"
        })}
        ${renderStageBlock({
          eyebrow: "Каталог",
          title: "Каталог пользователей",
          subtitle:
            "ID и технические поля остались доступны, но теперь у таблицы есть явный directory-контекст: профиль и временные метки отделены, а навигация по страницам утяжелена меньше.",
          actions: `<span class="bo-context-chip">Всего: ${total}</span>`,
          body: `${renderSubsection({
            title: "Пользователи",
            subtitle: "Текущая выборка каталога со всеми прежними ссылками в карточку пользователя и фильтрами по ботам.",
            body: `<div class="bo-table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Пользователь</th>
                      <th>Идентификаторы</th>
                      <th>Бот</th>
                      <th>Язык</th>
                      <th>Последняя активность</th>
                      <th>Регистрация</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows || "<tr><td colspan='6' class='small'>Нет пользователей</td></tr>"}</tbody>
                </table>
              </div>
              <div class="row" style="justify-content:space-between; margin-top:14px">
                <span class="small">Страница ${page} из ${totalPages || 1} · Всего строк: ${total}</span>
                <div class="bo-actions" style="justify-content:flex-end">
                  ${prevLink ? renderActionLink("← Назад", `/backoffice/audience?page=${prevPage}&perPage=${perPage}${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`, "ghost") : ""}
                  ${nextLink ? renderActionLink("Вперёд →", `/backoffice/audience?page=${nextPage}&perPage=${perPage}${botId ? `&bot=${encodeURIComponent(botId)}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`, "ghost") : ""}
                </div>
              </div>`,
            tone: "raised"
          })}`,
          tone: "primary"
        })}`
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
        <th>ID</th><th>Логин</th><th>Telegram ID</th><th>Имя</th><th>Бот</th><th>Язык</th><th>Последняя активность</th><th>Регистрация</th>
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
          <p><strong>Логин:</strong> ${user.username ? `<a href="https://t.me/${escapeHtml(user.username)}" target="_blank">@${escapeHtml(user.username)}</a>` : "—"}</p>
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
      <td>
        <div class="table-title"><a href="/backoffice/audience?bot=${encodeURIComponent(row.botId)}"><strong>${escapeHtml(row.botName)}</strong></a></div>
        <div class="table-meta">@${escapeHtml(row.username ?? "—")} · ${renderStatusBadge(row.stats.users > 0 ? "Есть данные" : "Пусто", row.stats.users > 0 ? "active" : "muted")}</div>
      </td>
      <td class="table-number"><a href="/backoffice/audience?bot=${encodeURIComponent(row.botId)}">${row.stats.users}</a></td>
      <td class="table-number">${row.stats.broadcasts}</td>
      <td class="table-number">${row.stats.dripCampaigns}</td>
      <td class="table-number">${row.stats.payments}</td>
      <td class="table-number">${row.stats.paidPayments}</td>
      <td class="table-number">${row.stats.templates}</td>
      <td class="table-number">${row.stats.menuItems}</td>
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
    const botsWithUsers = statsByBot.filter((row) => row.stats.users > 0).length;
    const botsWithPayments = statsByBot.filter((row) => row.stats.payments > 0).length;
    const emptyBots = statsByBot.filter((row) => row.stats.users === 0 && row.stats.payments === 0 && row.stats.menuItems === 0).length;

    const totalsRow =
      statsByBot.length > 1
        ? `
    <tr class="table-total-row">
      <td>Всего</td>
      <td class="table-number">${totals.users}</td>
      <td class="table-number">${totals.broadcasts}</td>
      <td class="table-number">${totals.dripCampaigns}</td>
      <td class="table-number">${totals.payments}</td>
      <td class="table-number">${totals.paidPayments}</td>
      <td class="table-number">${totals.templates}</td>
      <td class="table-number">${totals.menuItems}</td>
    </tr>`
        : "";

    return reply.type("text/html").send(
      renderPage(
        "База данных по ботам",
        `${renderPageHeader({
          eyebrow: "Аналитика платформы",
          title: "База данных",
          subtitle:
            "Компактный обзор по каждому боту: пользователи, рассылки, цепочки, платежи и активные элементы структуры. Страница стала аналитическим рабочим пространством, а не пустым табличным листом.",
          context: [
            `<span>Ботов в отчёте: <strong>${statsByBot.length}</strong></span>`,
            `<span>Пользователей суммарно: <strong>${totals.users}</strong></span>`,
            `<span>Платежей суммарно: <strong>${totals.payments}</strong></span>`
          ],
          actions: renderActionLink("← К списку ботов", "/backoffice", "secondary")
        })}
        <div class="bo-kpi-grid">
          ${renderMetricCard("Пользователи", String(totals.users), `По всем ботам в базе`)}
          ${renderMetricCard("Рассылки", String(totals.broadcasts), `Активность коммуникаций`)}
          ${renderMetricCard("Платежи", String(totals.payments), `Оплачено: <strong>${totals.paidPayments}</strong>`)}
          ${renderMetricCard("Шаблоны и меню", `${totals.templates} / ${totals.menuItems}`, `Активные шаблоны и пункты меню`)}
        </div>
        ${renderStageBlock({
          eyebrow: "Снимок платформы",
          title: "Охват и насыщенность данных",
          subtitle:
            "Этот слой даёт быстрый ответ, насколько система живая: сколько ботов реально наполнены данными, где уже есть платежи и какие контуры пока пустые.",
          body: `<div class="bo-stage-grid-rail">
              ${renderSubsection({
                title: "Качество наполнения",
                subtitle: "Показатели не меняют логику отчёта, но помогают сразу понять, насколько платформа операционно насыщена.",
                body: `<div class="bo-kpi-grid">
                    ${renderMetricCard("Боты с пользователями", String(botsWithUsers), `${renderStatusBadge(botsWithUsers ? "Есть активная база" : "Пока пусто", botsWithUsers ? "active" : "muted")}`, "bo-kpi-card--compact")}
                    ${renderMetricCard("Боты с платежами", String(botsWithPayments), `${renderStatusBadge(botsWithPayments ? "Коммерческий контур активен" : "Платежей нет", botsWithPayments ? "active" : "pending")}`, "bo-kpi-card--compact")}
                    ${renderMetricCard("Пустые контуры", String(emptyBots), emptyBots ? `${renderStatusBadge("Есть неинициализированные боты", "pending")}` : `${renderStatusBadge("Пустых контуров нет", "active")}`, "bo-kpi-card--compact")}
                  </div>`,
                tone: "raised"
              })}
              ${renderSubsection({
                title: "Как читать страницу",
                subtitle: "Таблица ниже остаётся источником истины по каждому боту, а быстрые выводы справа помогают не теряться в сухих числах.",
                body: `<div class="bo-stack bo-stack--dense">
                    <div class="bo-data-caption">Имя бота и статус наполненности стоят первыми, чтобы оператор сразу отделял живые контуры от пустых. Число пользователей по-прежнему ведёт в аудиторию с фильтром.</div>
                    ${renderNote("info", `Всего в отчёте <strong>${statsByBot.length}</strong> ботов. Суммарно <strong>${totals.users}</strong> пользователей и <strong>${totals.payments}</strong> платежей.`)}
                  </div>`,
                tone: "utility"
              })}
            </div>`,
          tone: "utility"
        })}
        ${renderStageBlock({
          eyebrow: "Пер-бот аналитика",
          title: "Статистика по ботам",
          subtitle:
            "Основная таблица оставлена компактной, но визуально усилена как аналитический модуль: заголовок, числовой ритм и итоговая строка читаются заметно быстрее.",
          actions: `<span class="bo-context-chip">Ботов: ${statsByBot.length}</span>`,
          body: `${renderSubsection({
            title: "Статистика по ботам",
            subtitle: "Сначала имя и статус наполненности, затем численные показатели. Итоговая строка сохранена и усилена визуально.",
            body: `<div class="bo-table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Бот</th>
                      <th class="table-number">Пользователи</th>
                      <th class="table-number">Рассылки</th>
                      <th class="table-number">Цепочки</th>
                      <th class="table-number">Платежи</th>
                      <th class="table-number">Оплачено</th>
                      <th class="table-number">Шаблоны</th>
                      <th class="table-number">Пункты меню</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows || "<tr><td colspan='8' class='small'>Нет ботов</td></tr>"}${totalsRow}</tbody>
                </table>
              </div>
              <div class="small" style="margin-top:12px">Клик по числу пользователей сохраняет прежний маршрут и ведёт в аудиторию с фильтром по выбранному боту.</div>`,
            tone: "raised"
          })}`,
          tone: "primary"
        })}`
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
      return reply.code(statusCode).type("text/html").send(renderPage("Панель управления", dashboardBody));
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
        "Настройки бота",
        `<h2 style="margin-top:0">Настройки бота</h2>
         <div class="small">ID экземпляра бота: <code>${escapeHtml(bot.id)}</code></div>
         <div style="margin-top:8px" class="small">Статус: <code>${escapeHtml(bot.status)}</code> · в архиве: <code>${bot.isArchived ? "да" : "нет"}</code></div>
         <div class="small" style="margin-top:2px">Создан: ${bot.createdAt.toISOString()} · обновлён: ${bot.updatedAt.toISOString()}</div>
         <div class="small" style="margin-top:2px">Платный доступ: <code>${bot.paidAccessEnabled ? "вкл" : "выкл"}</code></div>
         
         <div style="margin-top:16px" class="card">
           <h3 style="margin-top:0">Техническая информация шаблона</h3>
           <div class="small">Активный шаблон:</div>
           <div class="small" style="margin-top:6px">
             ${activeTemplate ? `ID: <code>${escapeHtml(activeTemplate.id)}</code> · язык: <code>${escapeHtml(activeTemplate.baseLanguageCode)}</code> · название: ${escapeHtml(activeTemplate.title)}` : "—"}
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
                    <button type="submit">Пауза (остановить бота)</button>
                  </form>
                  <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/lifecycle/resume" style="margin-top:12px">
                    <button type="submit">Запустить (включить)</button>
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
             Платный доступ и блокировки контента настраиваются в разделе:
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
      return reply.code(400).type("text/html").send(renderPage("Обновление токена", `<div class="error">Токен невалиден: ${(e as any)?.message ?? "неизвестная ошибка"}</div>`));
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
        "Клонирование бота",
        `<h2 style="margin-top:0">Клонировать шаблон</h2>
         <div class="small">Источник: ID бота <code>${escapeHtml(sourceBot.id)}</code></div>
         <div class="small" style="margin-top:4px">Базовый язык шаблона: <code>${escapeHtml(activeTemplate?.baseLanguageCode ?? "ru")}</code></div>
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
             <label>Платный доступ включён</label>
             <select name="paidAccessEnabled">
               <option value="true" ${sourceBot.paidAccessEnabled ? "selected" : ""}>Да</option>
               <option value="false" ${!sourceBot.paidAccessEnabled ? "selected" : ""}>Нет</option>
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
      return reply.code(400).type("text/html").send(renderPage("Клонирование бота", `<div class="error">Токен невалиден: ${(e as any)?.message ?? "неизвестная ошибка"}</div>`));
    }

    const tokenHash = hashTelegramBotToken(token);
    const existingByHash = await prisma.botInstance.findUnique({
      where: { telegramBotTokenHash: tokenHash }
    });
    if (existingByHash) {
      return reply.code(409).type("text/html").send(renderPage("Клонирование бота", `<div class="error">Бот с таким токеном уже существует.</div>`));
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
        return reply.code(409).type("text/html").send(renderPage("Клонирование бота", `<div class="error">Бот с таким токеном уже существует.</div>`));
      }
      return reply.code(500).type("text/html").send(renderPage("Клонирование бота", `<div class="error">Ошибка клонирования: ${(e as any)?.message ?? "неизвестная ошибка"}</div>`));
    }

    await runtimeManager.startBotInstance(cloned.newBotInstanceId, { launch: true });
    const clonedBot = await prisma.botInstance.findUnique({
      where: { id: cloned.newBotInstanceId },
      select: { telegramBotUsername: true }
    });
    const openUrl = clonedBot?.telegramBotUsername ? `https://t.me/${clonedBot.telegramBotUsername}` : "#";
    return reply.type("text/html").send(
      renderPage(
        "Бот склонирован",
        `<h2 style="margin-top:0">Клон создан</h2>
         <div class="small">Новый экземпляр бота: <code>${escapeHtml(cloned.newBotInstanceId)}</code></div>
         <div class="small" style="margin-top:10px">Дальше настройте структуру в Telegram через конструктор.</div>
         <div style="margin-top:14px" class="row">
           <a href="${openUrl}" target="_blank" style="text-decoration:none"><button type="button">Открыть в Telegram</button></a>
           <a href="/backoffice" style="text-decoration:none"><button class="secondary" type="button">К списку ботов</button></a>
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
    const paidPageError = String((req.query as any)?.error ?? "").trim();

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

    const [
      activeAccessCount,
      expiringSoonCount,
      recentAccessRights,
      recentPayments,
      recentDeposits,
      recentPurchases,
      recentNotifications,
      nowPaymentsConfig,
      settlementAgg,
      payoutBatches,
      settlementEntries,
      webhookLogs,
      botOwnerAssignments,
      botOwnerPayoutWallets,
      pendingSettlementsForOwners,
      settlementPaidByAttributedOwner,
      ownerAccrualsForEarned,
      paidSettlementEntriesForPeriod,
      ownerPayoutRecipientLog
    ] = await Promise.all([
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
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                fullName: true,
                telegramUserId: true
              }
            }
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
          include: {
            depositTransaction: {
              select: {
                orderId: true,
                user: {
                  select: {
                    invitedByUserId: true,
                    mentorUserId: true,
                    username: true,
                    firstName: true,
                    lastName: true,
                    fullName: true,
                    telegramUserId: true
                  }
                }
              }
            }
          },
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
          .then((filtered) => filtered.slice(0, 20)),
        prisma.botRoleAssignment.findMany({
          where: { botInstanceId: bot.id, role: "OWNER", status: "ACTIVE" },
          include: {
            user: { select: { id: true, fullName: true, username: true, telegramUserId: true } }
          },
          orderBy: { telegramUsernameNormalized: "asc" }
        }),
        prisma.botOwnerPayoutWallet.findMany({ where: { botInstanceId: bot.id } }),
        prisma.ownerSettlementEntry.findMany({
          where: { botInstanceId: bot.id, status: "PENDING" },
          include: {
            depositTransaction: {
              include: {
                user: { select: { invitedByUserId: true, mentorUserId: true } }
              }
            }
          }
        }),
        prisma.ownerSettlementEntry.groupBy({
          by: ["attributedOwnerUserId"],
          where: {
            botInstanceId: bot.id,
            status: { in: ["BATCHED", "PAID"] },
            batchId: { not: null },
            batch: { status: { not: "FAILED" } }
          },
          _sum: { netAmountBeforePayoutFee: true }
        }),
        prisma.ownerSettlementEntry.findMany({
          where: {
            botInstanceId: bot.id,
            createdAt: { gte: new Date(Date.now() - 450 * 86_400_000) }
          },
          select: {
            attributedOwnerUserId: true,
            netAmountBeforePayoutFee: true,
            createdAt: true
          }
        }),
        prisma.ownerSettlementEntry.findMany({
          where: {
            botInstanceId: bot.id,
            status: { in: ["BATCHED", "PAID"] },
            batchId: { not: null },
            batch: {
              status: { not: "FAILED" },
              createdAt: { gte: new Date(Date.now() - 450 * 86_400_000) }
            }
          },
          select: {
            attributedOwnerUserId: true,
            netAmountBeforePayoutFee: true,
            batch: { select: { executedAt: true, runDate: true } }
          }
        }),
        prisma.ownerPayoutBatchRecipient.findMany({
          where: { batch: { botInstanceId: bot.id } },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: {
            batch: { select: { executedAt: true, runDate: true, status: true } },
            ownerUser: { select: { id: true, fullName: true, username: true, telegramUserId: true } }
          }
        })
      ]);

    const ownerUserIdSet = new Set(
      botOwnerAssignments.map((a) => a.userId).filter((id): id is string => Boolean(id))
    );
    const ownerWalletByUserId = new Map(botOwnerPayoutWallets.map((w) => [w.ownerUserId, w.walletAddress]));
    type OwnerRowUser = { id: string; fullName: string; username: string | null; telegramUserId: bigint };
    const ownerUserById = new Map<string, OwnerRowUser>();
    for (const a of botOwnerAssignments) {
      if (a.user) ownerUserById.set(a.user.id, a.user);
    }

    const attributeSettlementToOwnerUserId = (
      u: { invitedByUserId: string | null; mentorUserId: string | null } | null | undefined
    ): string | null => {
      if (!u) return null;
      if (u.invitedByUserId && ownerUserIdSet.has(u.invitedByUserId)) return u.invitedByUserId;
      if (u.mentorUserId && ownerUserIdSet.has(u.mentorUserId)) return u.mentorUserId;
      return null;
    };

    const pendingNetByOwner = new Map<string, number>();
    let pendingNetUnallocated = 0;
    for (const e of pendingSettlementsForOwners) {
      const net = Number(e.netAmountBeforePayoutFee);
      const oid =
        e.attributedOwnerUserId && ownerUserIdSet.has(e.attributedOwnerUserId)
          ? e.attributedOwnerUserId
          : attributeSettlementToOwnerUserId(e.depositTransaction?.user ?? null);
      if (oid) pendingNetByOwner.set(oid, (pendingNetByOwner.get(oid) ?? 0) + net);
      else pendingNetUnallocated += net;
    }

    const paidNetByOwner = new Map<string | null, number>();
    for (const row of settlementPaidByAttributedOwner) {
      paidNetByOwner.set(row.attributedOwnerUserId, Number(row._sum.netAmountBeforePayoutFee ?? 0));
    }

    const payoutTz = nowPaymentsConfig?.payoutTimeZone?.trim() || "UTC";
    const orFromQ = parseYmd((req.query as Record<string, unknown>).orFrom);
    const orToQ = parseYmd((req.query as Record<string, unknown>).orTo);
    const { from: orFromYmd, to: orToYmd } = normalizeOwnerReportRange(orFromQ, orToQ, payoutTz);

    const paidInPeriodByOwner = new Map<string | null, number>();
    for (const e of paidSettlementEntriesForPeriod) {
      const when = e.batch?.executedAt ?? e.batch?.runDate;
      if (!when) continue;
      const ymd = calendarDateInTimeZone(when, payoutTz);
      if (!ymdInInclusiveRange(ymd, orFromYmd, orToYmd)) continue;
      const k = e.attributedOwnerUserId;
      paidInPeriodByOwner.set(k, (paidInPeriodByOwner.get(k) ?? 0) + Number(e.netAmountBeforePayoutFee));
    }

    const earnedInPeriodByOwner = new Map<string | null, number>();
    for (const row of ownerAccrualsForEarned) {
      const dk = calendarDateInTimeZone(row.createdAt, payoutTz);
      if (!ymdInInclusiveRange(dk, orFromYmd, orToYmd)) continue;
      const key = row.attributedOwnerUserId;
      earnedInPeriodByOwner.set(key, (earnedInPeriodByOwner.get(key) ?? 0) + Number(row.netAmountBeforePayoutFee));
    }

    const generalOwnerWalletCode =
      nowPaymentsConfig?.ownerWalletAddress?.trim() != null && nowPaymentsConfig.ownerWalletAddress.trim() !== ""
        ? `<code>${escapeHtml(nowPaymentsConfig.ownerWalletAddress.trim())}</code>`
        : `<span class="small">не задан</span>`;

    const formatOwnerReportingLabel = (userId: string | null) => {
      if (userId == null) return `<span class="small">Общий пул</span>`;
      const u = ownerUserById.get(userId);
      if (!u) return `<code>${escapeHtml(userId)}</code>`;
      const name = escapeHtml(u.fullName?.trim() || "—");
      const login = u.username ? `@${escapeHtml(u.username)}` : `<span class="small">нет @</span>`;
      return `${name} · ${login}`;
    };

    const ownerReportingRows: string[] = [];
    for (const a of botOwnerAssignments) {
      if (!a.userId || !a.user) continue;
      const uid = a.userId;
      const w = ownerWalletByUserId.get(uid) ?? "";
      ownerReportingRows.push(`<tr>
        <td>${formatOwnerReportingLabel(uid)}</td>
        <td class="mono-wrap">${w ? `<code>${escapeHtml(w)}</code>` : `<span class="small">→ общий</span>`}</td>
        <td>${(pendingNetByOwner.get(uid) ?? 0).toFixed(2)}</td>
        <td>${(paidNetByOwner.get(uid) ?? 0).toFixed(2)}</td>
        <td>${(paidInPeriodByOwner.get(uid) ?? 0).toFixed(2)}</td>
        <td>${(earnedInPeriodByOwner.get(uid) ?? 0).toFixed(2)}</td>
      </tr>`);
    }
    const poolPending = pendingNetUnallocated;
    const poolPaid = paidNetByOwner.get(null) ?? 0;
    if (
      poolPending > 0 ||
      poolPaid > 0 ||
      (paidInPeriodByOwner.get(null) ?? 0) > 0 ||
      (earnedInPeriodByOwner.get(null) ?? 0) > 0
    ) {
      ownerReportingRows.push(`<tr>
        <td><span class="small">Общий пул</span></td>
        <td class="mono-wrap">${generalOwnerWalletCode}</td>
        <td>${poolPending.toFixed(2)}</td>
        <td>${poolPaid.toFixed(2)}</td>
        <td>${(paidInPeriodByOwner.get(null) ?? 0).toFixed(2)}</td>
        <td>${(earnedInPeriodByOwner.get(null) ?? 0).toFixed(2)}</td>
      </tr>`);
    }

    const ownerPayoutHistoryFiltered = ownerPayoutRecipientLog.filter((r) => {
      const when = r.batch.executedAt ?? r.batch.runDate;
      const ymd = calendarDateInTimeZone(when, payoutTz);
      return ymdInInclusiveRange(ymd, orFromYmd, orToYmd);
    });

    const ownerPayoutHistoryRows = ownerPayoutHistoryFiltered.length
      ? ownerPayoutHistoryFiltered
          .map((r) => {
            const batchWhen = r.batch.executedAt ?? r.batch.runDate;
            const ownerCell = r.ownerUser
              ? `${escapeHtml(r.ownerUser.fullName?.trim() || "—")} · ${
                  r.ownerUser.username
                    ? `@${escapeHtml(r.ownerUser.username)}`
                    : `<span class="small">нет @</span>`
                }`
              : `<span class="small">Общий пул</span>`;
            const batchRu: Record<string, string> = {
              CREATED: "Создан",
              SENT: "Отправлен",
              PARTIAL: "Частично",
              PAID: "Выплачен",
              FAILED: "Ошибка"
            };
            const st = batchRu[r.batch.status] ?? r.batch.status;
            return `<tr>
              <td>${formatIsoDate(batchWhen)}</td>
              <td>${ownerCell}</td>
              <td class="mono-wrap"><code>${escapeHtml(r.walletAddress)}</code></td>
              <td>${Number(r.netAmount).toFixed(2)}</td>
              <td>${r.entryCount}</td>
              <td>${escapeHtml(st)}</td>
            </tr>`;
          })
          .join("")
      : "";

    const ownerReportQuery = `orFrom=${encodeURIComponent(orFromYmd)}&orTo=${encodeURIComponent(orToYmd)}`;
    const ownerReportingBlock = `<div class="section-title" style="margin-top:16px">Отчётность по владельцам (USDT нетто)</div>
       <form method="GET" action="/backoffice/bots/${escapeHtml(bot.id)}/paid#nowpayments" style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
         <div class="field-wrap"><label class="small" for="or-from">Период с</label><input id="or-from" class="field" type="date" name="orFrom" value="${escapeHtml(orFromYmd)}" /></div>
         <div class="field-wrap"><label class="small" for="or-to">по</label><input id="or-to" class="field" type="date" name="orTo" value="${escapeHtml(orToYmd)}" /></div>
         <button type="submit">Применить</button>
         <a href="/backoffice/bots/${escapeHtml(bot.id)}/paid/owner-report.csv?${ownerReportQuery}" style="text-decoration:none"><button type="button" class="secondary">Скачать CSV</button></a>
       </form>
       <div class="small" style="margin-bottom:8px">Ожидает — текущие PENDING. <b>Выплачено (накопл.)</b> — все успешные батчи. Колонки <b>за период</b> — дата выплаты (батч) и дата начисления в TZ <code>${escapeHtml(payoutTz)}</code>, интервал <code>${escapeHtml(orFromYmd)}</code> … <code>${escapeHtml(orToYmd)}</code> включительно.</div>
       ${
         ownerReportingRows.length
           ? `<table class="paid-table" style="margin-bottom:12px">
           <thead><tr><th>Владелец</th><th>Кошелёк (учёт)</th><th>Ожидает выплаты</th><th>Выплачено (накопл.)</th><th>Выплачено за период</th><th>Начислено за период</th></tr></thead>
           <tbody>${ownerReportingRows.join("")}</tbody>
         </table>`
           : `<div class="small" style="margin-bottom:12px">Нет строк отчёта (нет OWNER с привязкой User).</div>`
       }
       <div class="section-title" style="margin-top:12px">История выплат по получателям</div>
       <div class="small" style="margin-bottom:8px">Только выбранный период (дата батча в TZ выплат).</div>
       ${
         ownerPayoutHistoryRows
           ? `<table class="paid-table" style="margin-bottom:12px"><thead><tr><th>Когда (батч)</th><th>Получатель</th><th>Кошелёк</th><th>Нетто</th><th>Начислений</th><th>Статус батча</th></tr></thead><tbody>${ownerPayoutHistoryRows}</tbody></table>`
           : `<div class="small">Нет записей получателей за этот период (или выплат ещё не было).</div>`
       }`;

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

    /** Депозитор по записи начисления: логин Telegram, имя/фамилия из профиля TG, внутренний id. */
    const formatSettlementDepositorCell = (
      user:
        | {
            username: string | null;
            firstName: string;
            lastName: string;
            fullName: string;
            telegramUserId: bigint;
          }
        | null
        | undefined
    ) => {
      if (!user) return `<span class="small">—</span>`;
      const fn = user.firstName?.trim() || "";
      const ln = user.lastName?.trim() || "";
      const nameFromTelegram = [fn, ln].filter(Boolean).join(" ").trim();
      const nameShown = nameFromTelegram || user.fullName?.trim() || "";
      const loginLine = user.username
        ? escapeHtml(`@${user.username}`)
        : `<span class="small">нет @username</span>`;
      const nameLine = nameShown
        ? escapeHtml(nameShown)
        : `<span class="small">имя в Telegram не передано</span>`;
      return `<div>${loginLine}</div><div class="small">${nameLine} · id ${escapeHtml(String(user.telegramUserId))}</div>`;
    };

    /** Имя / фамилия для строки диагностики депозита (как в Telegram-профиле или из fullName). */
    const depositDiagnosticsNameParts = (
      user:
        | { firstName: string; lastName: string; fullName: string }
        | null
        | undefined
    ): { first: string; last: string } => {
      if (!user) return { first: "—", last: "—" };
      const fn = user.firstName?.trim() || "";
      const ln = user.lastName?.trim() || "";
      if (fn || ln) return { first: fn || "—", last: ln || "—" };
      const full = user.fullName?.trim() || "";
      if (!full) return { first: "—", last: "—" };
      const parts = full.split(/\s+/).filter(Boolean);
      const [firstPart, ...restParts] = parts;
      if (!firstPart) return { first: "—", last: "—" };
      if (restParts.length === 0) return { first: firstPart, last: "—" };
      return { first: firstPart, last: restParts.join(" ") };
    };

    const depositDiagnosticsTelegramLoginCell = (
      user: { username: string | null; telegramUserId: bigint } | null | undefined
    ): string => {
      if (!user) return `<span class="small">—</span>`;
      if (user.username) {
        const path = encodeURIComponent(user.username);
        const label = escapeHtml(`@${user.username}`);
        return `<a href="https://t.me/${path}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      const id = String(user.telegramUserId);
      return `<a href="tg://user?id=${escapeHtml(id)}" rel="noopener">${escapeHtml(`id ${id}`)}</a> <span class="small">(нет @username)</span>`;
    };

    const renderPaymentStatus = (status: string) => {
      const ru: Record<string, { label: string; tone: Parameters<typeof renderStatusBadge>[1] }> = {
        PAID: { label: "Оплачено", tone: "active" },
        CONFIRMED: { label: "Подтверждено", tone: "active" },
        COMPLETED: { label: "Завершено", tone: "active" },
        ACTIVE: { label: "Активно", tone: "active" },
        PENDING: { label: "В ожидании", tone: "pending" },
        UNPAID: { label: "Не оплачено", tone: "pending" },
        BATCHED: { label: "В пакете выплаты", tone: "pending" },
        FAILED: { label: "FAILED", tone: "failed" },
        CANCELLED: { label: "Отменено", tone: "failed" },
        REJECTED: { label: "Отклонено", tone: "failed" },
        EXPIRED: { label: "Истекло", tone: "expired" },
        REVOKED: { label: "Отозвано", tone: "expired" }
      };
      const mapped = ru[status];
      if (mapped) return renderStatusBadge(mapped.label, mapped.tone);
      return renderStatusBadge(status, "muted");
    };

    const renderAccessStatus = (right: (typeof recentAccessRights)[number]) => {
      if (right.status === "EXPIRED") return renderStatusBadge("Истёк", "expired");
      if (right.status === "REVOKED") return renderStatusBadge("Отозван", "failed");
      if (!right.activeUntil) return renderStatusBadge("Активен", "active");
      const msLeft = right.activeUntil.getTime() - Date.now();
      if (msLeft <= 0) return renderStatusBadge("Истёк", "expired");
      if (msLeft <= 3 * 24 * 60 * 60 * 1000) return renderStatusBadge("Скоро истечёт", "expiring");
      return renderStatusBadge("Активен", "active");
    };

    const renderReminderSummary = (accessRightId: string) => {
      const jobs = reminderJobsByAccessId.get(accessRightId) ?? [];
      if (jobs.length === 0) return `<span class="small">—</span>`;
      const sent = jobs.filter((job) => job.status === "COMPLETED").length;
      const failed = jobs.filter((job) => job.status === "FAILED").length;
      const pending = jobs.filter((job) => job.status === "PENDING").length;
      const chunks: string[] = [];
      if (sent) chunks.push(`отпр. ${sent}`);
      if (pending) chunks.push(`ожид. ${pending}`);
      if (failed) chunks.push(`ошиб. ${failed}`);
      return `${renderStatusBadge(chunks.join(" · "), failed ? "failed" : pending ? "pending" : "active")}`;
    };

    const renderExpirySummary = (accessRightId: string) => {
      const job = expiryJobByAccessId.get(accessRightId);
      if (!job) return `<span class="small">—</span>`;
      if (job.status === "FAILED") {
        return `${renderStatusBadge("FAILED", "failed")}<div class="small" style="margin-top:4px">Ошибка удаления: ${escapeHtml(job.errorMessage ?? "неизвестная ошибка")}</div>`;
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
      const postLinkFromIdentifier = (identifier?: string) => {
        const id = String(identifier ?? "").trim();
        const m = id.match(/^-100(\d{6,})$/);
        return m ? `https://t.me/c/${m[1]}/1` : "";
      };
      const sections = boundSectionsByProduct.get(product.id) ?? [];
      const removalWarning = isTemporaryAccessProduct(product) ? diagnostics.issue : null;

      return `<div class="product-card">
        <div class="product-card-header">
          <div>
            <div class="bo-stateline">
              ${renderProductModeBadge(product)}
              ${renderStatusBadge(product.billingType === "TEMPORARY" || Number(product.durationMinutes ?? 0) > 0 ? "Временный доступ" : "Бессрочно", product.billingType === "TEMPORARY" || Number(product.durationMinutes ?? 0) > 0 ? "pending" : "active")}
            </div>
            <div style="font-size:20px; font-weight:700; letter-spacing:-0.02em; margin-top:10px">${escapeHtml(loc?.title ?? product.code)}</div>
            <div class="small" style="margin-top:6px">${escapeHtml(formatMoney(product.price))} ${escapeHtml(product.currency)} · ${escapeHtml(formatProductDuration(product))}</div>
          </div>
          <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(product.id)}/archive" style="margin-left:auto">
            <button type="submit" class="secondary" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.45);">Архивировать</button>
          </form>
        </div>

        <div class="bo-grid-2" style="margin-bottom:16px">
          <div class="bo-note bo-note--info">
            <strong>Привязка и CTA</strong><br>
            Разделы: ${sections.length ? sections.map((item) => `<code>${escapeHtml(item)}</code>`).join(", ") : "<span class=\"small\">пока не привязан</span>"}<br>
            Кнопка в боте: <code>${escapeHtml(loc?.payButtonText ?? "Оплатить")}</code>
          </div>
          <div class="${removalWarning ? "warning-card" : "bo-note bo-note--success"}">
            <strong>Готовность доступа</strong><br>
            ${renderLinkedChatReadiness(product)}${diagnostics.hasLinkedChats ? ` · <span class="small">ссылок ${diagnostics.displayLinkCount}, ID для удаления ${diagnostics.banIdentifierCount}</span>` : ""}
            ${removalWarning ? `<div class="small" style="margin-top:6px; color:inherit">${escapeHtml(removalWarning)}</div>` : ""}
          </div>
        </div>

        <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(product.id)}/update" class="bo-stack">
          <div class="bo-form-cluster">
            <div class="bo-form-cluster-head">
              <div>
                <div class="bo-form-cluster-title">Основное и цена</div>
                <div class="bo-form-cluster-copy">Оффер, CTA и финансовые параметры продукта собраны в одном базовом модуле.</div>
              </div>
            </div>
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
          </div>

          <div class="bo-form-cluster">
            <div class="bo-form-cluster-head">
              <div>
                <div class="bo-form-cluster-title">Платежи и доступ</div>
                <div class="bo-form-cluster-copy">LIVE и TEST остаются явно разделёнными: дни управляют боевым сценарием, минуты управляют лабораторным прогоном.</div>
              </div>
            </div>
          <div class="product-form-grid">
            <div class="field-wrap"><label class="small">Минуты доступа для TEST</label><input name="durationMinutes" type="number" min="1" max="1440" value="${product.durationMinutes ?? ""}" placeholder="пусто = live" /></div>
          </div>
          <div style="margin-top:12px">
            <label class="small">Ссылки доступа в чат / канал</label>
            <div class="linked-chat-grid">
              <div class="linked-chat-card">
                <div class="title">Кнопка 1</div>
                <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel1" type="text" placeholder="Чат" value="${escapeHtml(String(chat1.label ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Ссылка-приглашение</label><input name="linkedChatLink1" type="text" placeholder="https://t.me/+inviteHashChat" value="${escapeHtml(String(chat1.link ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Ссылка на сообщение</label><input name="linkedChatPostLink1" type="text" placeholder="https://t.me/c/1234567890/1" value="${escapeHtml(postLinkFromIdentifier(String(chat1.identifier ?? "")))}" /></div>
                <div class="field-wrap"><label class="small">ID чата</label><div class="field-inline"><input name="linkedChatIdentifier1" type="text" placeholder="-1001234567890" value="${escapeHtml(String(chat1.identifier ?? ""))}" /><button class="secondary mini-btn" type="button" data-linked-chat-extract="1">Извлечь ID</button></div><div class="id-hint" data-id-hint="1"></div></div>
              </div>
              <div class="linked-chat-card">
                <div class="title">Кнопка 2</div>
                <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel2" type="text" placeholder="Канал" value="${escapeHtml(String(chat2.label ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Ссылка-приглашение</label><input name="linkedChatLink2" type="text" placeholder="https://t.me/+inviteHashChannel" value="${escapeHtml(String(chat2.link ?? ""))}" /></div>
                <div class="field-wrap"><label class="small">Ссылка на сообщение</label><input name="linkedChatPostLink2" type="text" placeholder="https://t.me/c/2234567890/1" value="${escapeHtml(postLinkFromIdentifier(String(chat2.identifier ?? "")))}" /></div>
                <div class="field-wrap"><label class="small">ID чата</label><div class="field-inline"><input name="linkedChatIdentifier2" type="text" placeholder="-1002234567890" value="${escapeHtml(String(chat2.identifier ?? ""))}" /><button class="secondary mini-btn" type="button" data-linked-chat-extract="2">Извлечь ID</button></div><div class="id-hint" data-id-hint="2"></div></div>
              </div>
            </div>
            <textarea name="linkedChatsRaw" rows="3" placeholder="Чат | https://t.me/+inviteHashChat | -1001234567890&#10;Канал | https://t.me/+inviteHashChannel | -1002234567890">${formatLinkedChatsForEdit(product.linkedChats)}</textarea>
            <div class="small" style="margin-top:6px">Можно не указывать identifier вручную: если вставите post-link вида <code>https://t.me/c/.../...</code>, identifier <code>-100...</code> будет извлечен автоматически.</div>
            <div class="small" style="margin-top:4px">Для приватного чата можно хранить и ссылку для входа, и identifier для ban/unban в одной строке: <code>https://t.me/+inviteHash | -1001234567890</code> или <code>https://t.me/+inviteHash | https://t.me/c/1234567890/1</code>. Тогда пользователь войдёт по invite-link, а бот сможет удалить его по expiry.</div>
          </div>
          </div>

          <div class="bo-form-cluster">
            <div class="bo-form-cluster-head">
              <div>
                <div class="bo-form-cluster-title">Описание и оффер</div>
                <div class="bo-form-cluster-copy">Пользовательский текст отделён от технических настроек, чтобы продукт редактировался как коммерческая карточка, а не как raw-форма.</div>
              </div>
            </div>
          <div>
            <label class="small">Описание на экране оплаты / тарифы (ru)</label>
            <textarea name="descriptionRu" rows="2">${escapeHtml(loc?.description ?? "")}</textarea>
            <div class="small" style="margin-top:4px">Показывается пользователю в едином инвойсе сразу под названием продукта. Сюда пишите оффер, тарифы, бонусы и что откроется после оплаты.</div>
          </div>
          </div>
          <div class="bo-actions" style="justify-content:flex-start">
            <button type="submit">Сохранить продукт</button>
          </div>
        </form>

        ${
          opts.allowSimulate
            ? `<div class="section-title">Быстрый ручной тест</div>
               <div class="bo-note bo-note--warning">
                 <strong>Тестовый прогон lifecycle</strong><br>
                 Проверяет grant → invite links → reminders → expiry → removal в ускоренном режиме, не меняя production-маршрут.
               </div>
               <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/${escapeHtml(product.id)}/simulate-payment" class="form-row" style="margin-top:12px">
                 <div class="field" style="min-width:220px; max-width:320px">
                   <select name="userId" required>
                     <option value="">— Выберите пользователя —</option>
                     ${userSelectOptions}
                   </select>
                 </div>
                 <div class="btn"><button type="submit" class="secondary">Выдать тестовый доступ</button></div>
               </form>`
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
        productLabel: "Пополнение баланса",
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
      if (deposit.status === "CONFIRMED") return "Зачислено";
      if (deposit.status === "FAILED") return "Отклонено провайдером";
      if (!deposit.providerPaymentId) return "Инвойс не создан";
      if (!deposit.providerPayAddress) return "Нет адреса оплаты";
      return "Ожидание провайдера / webhook";
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
      const toleranceLabel =
        tolerance === "pass" ? "OK (≥98%)" : tolerance === "fail" ? "Ниже порога" : "—";
      const nameParts = depositDiagnosticsNameParts(deposit.user);
      const telegramLoginCell = depositDiagnosticsTelegramLoginCell(deposit.user);

      return {
        createdAt: deposit.createdAt,
        depositorFirstName: nameParts.first,
        depositorLastName: nameParts.last,
        telegramLoginCell,
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
        tolerance,
        toleranceLabel
      };
    });

    const ownersRowsHtml = botOwnerAssignments
      .map((a) => {
        if (a.userId && a.user) {
          const uid = a.userId;
          const w = ownerWalletByUserId.get(uid) ?? "";
          const pend = (pendingNetByOwner.get(uid) ?? 0).toFixed(2);
          return `<tr>
            <td>${escapeHtml(a.user.fullName?.trim() || "—")}</td>
            <td>${a.user.username ? `@${escapeHtml(a.user.username)}` : `<span class="small">—</span>`}</td>
            <td><code>${escapeHtml(String(a.user.telegramUserId))}</code></td>
            <td>${pend}</td>
            <td>
              <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/owner-payout-wallet" style="margin:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
                <input type="hidden" name="ownerUserId" value="${escapeHtml(uid)}" />
                <input name="walletAddress" type="text" placeholder="0x…" value="${escapeHtml(w)}" style="min-width:200px;max-width:min(280px,100%)" class="field" />
                <button type="submit" class="secondary">Сохранить</button>
              </form>
            </td>
          </tr>`;
        }
        const raw = a.telegramUsernameRaw?.trim() || a.telegramUsernameNormalized;
        return `<tr>
          <td colspan="2"><code>${escapeHtml(raw)}</code> <span class="small">(OWNER, пользователь ещё не заходил в бота)</span></td>
          <td>—</td>
          <td>—</td>
          <td><span class="small">После первого входа появится строка с именем и полем кошелька.</span></td>
        </tr>`;
      })
      .join("");

    const nowpaymentsOwnersBlock = `<div class="small" style="margin-bottom:10px;padding:10px;border-radius:8px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2)">
         Массовая выплата NOWPayments: суммы объединяются по <b>адресу</b>. У OWNER с индивидуальным BEP20 — выплата на него; без своего кошелька или для <b>общего пула</b> — на общий кошелёк: ${generalOwnerWalletCode}.
         Ниже — OWNER, логины Telegram и ожидающие нетто (привязка: пригласитель среди OWNER, иначе наставник).
       </div>
       <div class="section-title" style="margin-top:4px">Владельцы, логины и кошельки</div>
       ${
         botOwnerAssignments.length === 0
           ? `<div class="small" style="margin-bottom:12px">Нет активных назначений OWNER. Назначьте владельцев в настройках ролей бота.</div>`
           : `<table class="paid-table" style="margin-bottom:12px">
           <thead><tr><th>Имя</th><th>Логин Telegram</th><th>Telegram ID</th><th>Ожидает нетто (USDT)</th><th>Индив. кошелёк BEP20 (учёт)</th></tr></thead>
           <tbody>${ownersRowsHtml}</tbody>
         </table>`
       }
       ${
         pendingNetUnallocated > 0
           ? `<div class="small" style="margin-bottom:12px;padding:10px;border-radius:8px;background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.25)">
                <b>${pendingNetUnallocated.toFixed(2)} USDT</b> (нетто) в ожидании <b>без привязки</b> к владельцу — учитываются в общем пуле и уйдут на общий кошелёк при выплате.
              </div>`
           : ""
       }`;

    const topStateBanners = [
      simulateOk
        ? renderNote(
            "success",
            "Тестовый сценарий запущен: доступ выдан, reminders и expiry/removal будут обработаны по policy продукта."
          )
        : "",
      simulateError ? renderNote("danger", escapeHtml(simulateError), "Ошибка тестового сценария") : "",
      paidPageError ? renderNote("danger", escapeHtml(paidPageError), "Ошибка операции") : "",
      misconfiguredProducts.length
        ? renderNote(
            "warning",
            `Найдены продукты с истечением без привязки чатов, пригодных для удаления: ${misconfiguredProducts
              .map((product) => `<code>${escapeHtml(productLabelById.get(product.id) ?? product.code)}</code>`)
              .join(", ")}. Кнопки приглашения покажутся, но гарантировать удаление по expiry нельзя.`
          )
        : ""
    ]
      .filter(Boolean)
      .join("");

    const bindingsTable = menuItems.length
      ? `<div class="bo-table-shell"><table class="paid-table">
           <thead><tr><th>Раздел</th><th>Статус</th><th>Продукт и режим</th><th>CTA в боте</th><th>Действие</th></tr></thead>
           <tbody>
             ${menuItems
               .map((mi) => {
                 const title = mi.localizations[0]?.title ?? mi.key;
                 const product = mi.productId ? products.find((item) => item.id === mi.productId) : null;
                 const productLabel = mi.productId ? productLabelById.get(mi.productId) ?? mi.productId : null;
                 const productButtonText = product ? productLoc(product)?.payButtonText ?? "Оплатить" : "—";
                 return mi.productId
                   ? `<tr>
                        <td><strong>${escapeHtml(title)}</strong><div class="small">Раздел закрыт и привязан к продукту</div></td>
                        <td>${renderStatusBadge("Закрыто", "pending")}</td>
                        <td><code>${escapeHtml(productLabel ?? "")}</code> ${product ? renderProductModeBadge(product) : ""}</td>
                        <td><code>${escapeHtml(productButtonText)}</code></td>
                        <td>
                          <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/menu-items/${escapeHtml(mi.id)}/unlock" style="display:inline">
                            <button type="submit" class="secondary">Снять блокировку</button>
                          </form>
                        </td>
                      </tr>`
                   : `<tr>
                        <td><strong>${escapeHtml(title)}</strong><div class="small">Раздел открыт и доступен без оплаты</div></td>
                        <td>${renderStatusBadge("Открыто", "active")}</td>
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
               })
               .join("")}
           </tbody>
         </table></div>`
      : renderNote("warning", "Нет пунктов меню для настройки paid access.");

    const liveCreateBlock = `<div class="bo-note bo-note--info">
         Live-продукты работают по production-логике: стандартный duration в днях, реальные продажи и штатный контур доступа. TEST-логика вынесена в отдельную лабораторию ниже.
       </div>
       <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/create" class="bo-stack" style="margin-top:16px">
         <div class="bo-form-cluster">
           <div class="bo-form-cluster-head">
             <div>
               <div class="bo-form-cluster-title">Создать live-product</div>
               <div class="bo-form-cluster-copy">Production-продукт без ускоренных минутных таймеров. Сначала оффер и биллинг, затем параметры доступа.</div>
             </div>
           </div>
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
         </div>
         <div class="bo-form-cluster">
           <div class="bo-form-cluster-head">
             <div>
               <div class="bo-form-cluster-title">Доступ и linked chats</div>
               <div class="bo-form-cluster-copy">Ссылки доступа и идентификаторы чатов собраны в отдельный кластер, чтобы removal-readiness читался без раскрытия скрытых деталей.</div>
             </div>
           </div>
           <label class="small">Ссылки доступа в чат / канал</label>
           <div class="linked-chat-grid">
             <div class="linked-chat-card">
               <div class="title">Кнопка 1</div>
               <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel1" type="text" placeholder="Чат" /></div>
               <div class="field-wrap"><label class="small">Ссылка-приглашение</label><input name="linkedChatLink1" type="text" placeholder="https://t.me/+inviteHashChat" /></div>
               <div class="field-wrap"><label class="small">Ссылка на сообщение</label><input name="linkedChatPostLink1" type="text" placeholder="https://t.me/c/1234567890/1" /></div>
               <div class="field-wrap"><label class="small">ID чата</label><div class="field-inline"><input name="linkedChatIdentifier1" type="text" placeholder="-1001234567890" /><button class="secondary mini-btn" type="button" data-linked-chat-extract="1">Извлечь ID</button></div><div class="id-hint" data-id-hint="1"></div></div>
             </div>
             <div class="linked-chat-card">
               <div class="title">Кнопка 2</div>
               <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel2" type="text" placeholder="Канал" /></div>
               <div class="field-wrap"><label class="small">Ссылка-приглашение</label><input name="linkedChatLink2" type="text" placeholder="https://t.me/+inviteHashChannel" /></div>
               <div class="field-wrap"><label class="small">Ссылка на сообщение</label><input name="linkedChatPostLink2" type="text" placeholder="https://t.me/c/2234567890/1" /></div>
               <div class="field-wrap"><label class="small">ID чата</label><div class="field-inline"><input name="linkedChatIdentifier2" type="text" placeholder="-1002234567890" /><button class="secondary mini-btn" type="button" data-linked-chat-extract="2">Извлечь ID</button></div><div class="id-hint" data-id-hint="2"></div></div>
             </div>
           </div>
           <textarea name="linkedChatsRaw" rows="3" placeholder="Чат | https://t.me/+inviteHashChat | -1001234567890&#10;Канал | https://t.me/+inviteHashChannel | -1002234567890"></textarea>
           <div class="small" style="margin-top:6px">Можно не указывать identifier вручную: если вставите post-link вида <code>https://t.me/c/.../...</code>, identifier <code>-100...</code> будет извлечен автоматически.</div>
           <div class="small" style="margin-top:4px">Для приватного чата можно сохранить invite-link и identifier в одной строке: <code>https://t.me/+inviteHash | -1001234567890</code> или <code>https://t.me/+inviteHash | https://t.me/c/1234567890/1</code>. Тогда кнопка доступа будет вести по invite-link, а бот сможет удалить пользователя по expiry.</div>
         </div>
         <div class="bo-form-cluster">
           <div class="bo-form-cluster-head">
             <div>
               <div class="bo-form-cluster-title">Описание оффера</div>
               <div class="bo-form-cluster-copy">Отдельный блок для текста на экране оплаты, чтобы коммерческая часть продукта не смешивалась с техническими настройками.</div>
             </div>
           </div>
           <div>
             <label class="small">Описание на экране оплаты / тарифы (ru)</label>
             <textarea name="descriptionRu" rows="2"></textarea>
             <div class="small" style="margin-top:4px">Показывается пользователю в едином инвойсе сразу под названием продукта. Сюда удобно писать тарифы и то, что человек получит после оплаты.</div>
           </div>
         </div>
         <div class="bo-actions" style="justify-content:flex-start"><button type="submit">Создать live-product</button></div>
       </form>`;

    const testCreateBlock = `<div class="bo-note bo-note--warning">
         TEST-логика остаётся полностью явной: source of truth — <code>durationMinutes &gt; 0</code>, reminders идут за <strong>3 / 2 / 1 минуты</strong>, а expiry/removal отрабатывают в ускоренном режиме.
       </div>
       <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/products/create" class="bo-stack" style="margin-top:16px">
         <input type="hidden" name="billingType" value="TEMPORARY" />
         <input type="hidden" name="currency" value="USDT" />
         <div class="bo-form-cluster">
           <div class="bo-form-cluster-head">
             <div>
               <div class="bo-form-cluster-title">Создать тестовый продукт</div>
               <div class="bo-form-cluster-copy">Изолированная лаборатория для быстрого прогона полного access lifecycle без ожидания днями.</div>
             </div>
           </div>
           <div class="product-form-grid">
             <div class="field-wrap"><label class="small">Название продукта в инвойсе (ru)</label><input name="titleRu" type="text" required placeholder="Тест: обучение 5 мин" /></div>
             <div class="field-wrap"><label class="small">Кнопка в разделе (ru)</label><input name="payButtonTextRu" type="text" required value="Оплатить тест" /></div>
             <div class="field-wrap"><label class="small">Цена</label><input name="price" type="text" required value="1" /></div>
             <div class="field-wrap"><label class="small">Срок в минутах</label><input name="durationMinutes" type="number" required min="1" max="1440" value="5" /></div>
           </div>
         </div>
         <div class="bo-form-cluster">
           <div class="bo-form-cluster-head">
             <div>
               <div class="bo-form-cluster-title">Доступ и удаление</div>
               <div class="bo-form-cluster-copy">Здесь остаются все поля для проверки invite, reminders, expiry и removal. Важные TEST-семантики не спрятаны.</div>
             </div>
           </div>
           <label class="small">Ссылки доступа в чат / канал</label>
           <div class="linked-chat-grid">
             <div class="linked-chat-card">
               <div class="title">Кнопка 1</div>
               <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel1" type="text" placeholder="Чат" /></div>
               <div class="field-wrap"><label class="small">Ссылка-приглашение</label><input name="linkedChatLink1" type="text" placeholder="https://t.me/+inviteHashChat" /></div>
               <div class="field-wrap"><label class="small">Ссылка на сообщение</label><input name="linkedChatPostLink1" type="text" placeholder="https://t.me/c/1234567890/1" /></div>
               <div class="field-wrap"><label class="small">ID чата</label><div class="field-inline"><input name="linkedChatIdentifier1" type="text" placeholder="-1001234567890" /><button class="secondary mini-btn" type="button" data-linked-chat-extract="1">Извлечь ID</button></div><div class="id-hint" data-id-hint="1"></div></div>
             </div>
             <div class="linked-chat-card">
               <div class="title">Кнопка 2</div>
               <div class="field-wrap"><label class="small">Название</label><input name="linkedChatLabel2" type="text" placeholder="Канал" /></div>
               <div class="field-wrap"><label class="small">Ссылка-приглашение</label><input name="linkedChatLink2" type="text" placeholder="https://t.me/+inviteHashChannel" /></div>
               <div class="field-wrap"><label class="small">Ссылка на сообщение</label><input name="linkedChatPostLink2" type="text" placeholder="https://t.me/c/2234567890/1" /></div>
               <div class="field-wrap"><label class="small">ID чата</label><div class="field-inline"><input name="linkedChatIdentifier2" type="text" placeholder="-1002234567890" /><button class="secondary mini-btn" type="button" data-linked-chat-extract="2">Извлечь ID</button></div><div class="id-hint" data-id-hint="2"></div></div>
             </div>
           </div>
           <textarea name="linkedChatsRaw" rows="3" placeholder="Чат | https://t.me/+inviteHashChat | -1001234567890&#10;Канал | https://t.me/+inviteHashChannel | -1002234567890"></textarea>
           <div class="small" style="margin-top:6px">Можно не указывать identifier вручную: если вставите post-link вида <code>https://t.me/c/.../...</code>, identifier <code>-100...</code> будет извлечен автоматически.</div>
           <div class="small" style="margin-top:4px">Ожидаемое поведение: reminder за 3/2/1 минуты → expiry → попытка удаления из linked chats. Для приватного чата используйте либо <code>https://t.me/c/1234567890/1</code>, либо комбинированный формат <code>https://t.me/+inviteHash | -1001234567890</code>. Тогда пользователь войдёт по invite-link, а ban/unban пойдёт по identifier.</div>
         </div>
         <div class="bo-form-cluster">
           <div class="bo-form-cluster-head">
             <div>
               <div class="bo-form-cluster-title">Описание тестового оффера</div>
               <div class="bo-form-cluster-copy">Текст продукта остаётся редактируемым отдельно, чтобы не теряться среди ускоренных тестовых параметров.</div>
             </div>
           </div>
           <div>
             <label class="small">Описание на экране оплаты / тарифы (ru)</label>
             <textarea name="descriptionRu" rows="2" placeholder="Тестовый продукт для прогона access lifecycle"></textarea>
             <div class="small" style="margin-top:4px">Показывается в едином инвойсе тестового продукта сразу под названием. Здесь удобно описать оффер, тариф и что откроется после оплаты.</div>
           </div>
         </div>
         <div class="bo-actions" style="justify-content:flex-start"><button type="submit">Создать тестовый продукт</button></div>
       </form>`;

    const paymentEventsTable = paymentEvents.length
      ? `<div class="events-scroll"><table class="paid-table">
           <thead><tr><th>Когда</th><th>Событие</th><th>Пользователь</th><th>Продукт</th><th>Сумма</th><th>Статус</th><th>Референс / заказ</th><th>Кошелёк</th></tr></thead>
           <tbody>
             ${paymentEvents
               .map(
                 (event) => `<tr>
                   <td class="table-nowrap">${formatIsoDate(event.createdAt)}</td>
                   <td><div class="table-title"><code>${escapeHtml(event.kind)}</code></div></td>
                   <td><div class="table-title">${renderUserLabel(event.user)}</div></td>
                   <td><div class="table-title">${escapeHtml(event.productLabel)}</div></td>
                   <td class="table-nowrap">${escapeHtml(event.amount)}</td>
                   <td>${renderPaymentStatus(event.status)}</td>
                   <td class="mono-wrap"><code>${escapeHtml(event.note)}</code></td>
                   <td class="wallet-col"><code>${escapeHtml(event.walletAddress ?? "-")}</code></td>
                 </tr>`
               )
               .join("")}
           </tbody>
         </table></div>`
      : `<div class="small">Пока нет событий платежей.</div>`;

    const accessAuditTable = recentAccessRights.length
      ? `<div class="bo-table-shell"><table class="paid-table">
           <thead><tr><th>Пользователь</th><th>Продукт</th><th>Режим</th><th>Статус</th><th>Истекает</th><th>Чаты</th><th>Напоминания</th><th>Истечение / удаление</th></tr></thead>
           <tbody>
             ${recentAccessRights
               .map((right) => {
                 const loc =
                   right.product.localizations.find((item) => item.languageCode === baseLang) ??
                   right.product.localizations.find((item) => item.languageCode === "ru") ??
                   right.product.localizations[0];
                 return `<tr>
                   <td><div class="table-title">${renderUserLabel(right.user)}</div></td>
                   <td><div class="table-title">${escapeHtml(loc?.title ?? right.product.code)}</div></td>
                   <td>${renderProductModeBadge(right.product)}</td>
                   <td>${renderAccessStatus(right)}</td>
                   <td class="table-nowrap">${formatIsoDate(right.activeUntil)}</td>
                   <td>${renderLinkedChatReadiness(right.product)}</td>
                   <td>${renderReminderSummary(right.id)}</td>
                   <td>${renderExpirySummary(right.id)}</td>
                 </tr>`;
               })
               .join("")}
           </tbody>
         </table></div>`
      : `<div class="small">Пока нет событий доступа для этого бота.</div>`;

    return reply.type("text/html").send(
      renderPage(
        "Платный доступ",
        `${renderPageHeader({
          eyebrow: "Платный доступ",
          title: "Оплаты и доступ",
          subtitle:
            "Операционное рабочее пространство для управления оплатой и доступом без изменения доменной логики. Production и TEST разделены визуально, финансы и аудит вынесены в самостоятельные модули, а все существующие формы и статусы сохранены.",
          context: [
            `<span>Бот: <code>${escapeHtml(bot.id)}</code></span>`,
            `<span>Режим оплаты: ${balanceFlowEnabled ? "баланс + покупка" : "прямой счёт / ручной запрос"}</span>`,
            `<span>Live: <strong>${liveProducts.length}</strong> · Test: <strong>${testProducts.length}</strong></span>`
          ],
          actions: renderActionLink("Настройки бота", `/backoffice/bots/${escapeHtml(bot.id)}/settings`, "secondary")
        })}
        ${topStateBanners}
        <section class="bo-panel bo-panel--utility bo-workspace-nav">
          <div class="bo-section-head">
            <div>
              <h2 class="bo-section-title">Карта рабочего пространства</h2>
              <div class="bo-section-text">Быстрые переходы между управляющим, продуктовым, финансовым и диагностическим контурами страницы.</div>
            </div>
            <div class="bo-context-chip">4 рабочих слоя</div>
          </div>
          <div class="bo-context-list" style="margin-top:0; margin-bottom:12px">
            <span class="bo-context-chip">Разделы: <strong>${menuItems.length}</strong></span>
            <span class="bo-context-chip">LIVE / TEST: <strong>${liveProducts.length}</strong> / <strong>${testProducts.length}</strong></span>
            <span class="bo-context-chip">Платежи в ожидании: <strong>${pendingPaymentsCount}</strong></span>
            <span class="bo-context-chip">Активные доступы: <strong>${activeAccessCount}</strong></span>
          </div>
          <div class="paid-nav">
            <a href="#overview">Обзор</a>
            <a href="#bindings">Контент и доступ</a>
            <a href="#live-products">Боевые продукты</a>
            <a href="#test-lab">Тестовая лаборатория</a>
            <a href="#payments-balance">Платежи / баланс</a>
            <a href="#nowpayments">NOWPayments / выплаты</a>
            <a href="#access-audit">Аудит доступа</a>
          </div>
        </section>
        ${renderStageBlock({
          eyebrow: "Контур управления",
          title: "Обзор и доступ",
          subtitle:
            "Первый слой собран как управляющая палуба: сигналы, глобальное включение платного доступа и привязка контента находятся выше продуктовых и финансовых деталей.",
          actions: bot.paidAccessEnabled ? renderStatusBadge("Платный доступ активен", "active") : renderStatusBadge("Платный доступ выключен", "failed"),
          body: `<div class="bo-stage-grid-rail">
            ${renderSubsection({
            id: "overview",
            title: "Обзор рабочего пространства",
            subtitle:
              "Сначала сигналы и KPI, затем рабочий порядок и режим оплаты. Главные метрики вынесены наверх, чтобы важное читалось раньше диагностического шума.",
            body: `<div class="bo-kpi-grid">
                ${renderMetricCard("Платный доступ", bot.paidAccessEnabled ? "Вкл" : "Выкл", bot.paidAccessEnabled ? `${renderStatusBadge("Активен", "active")}` : `${renderStatusBadge("Выключен", "failed")}`)}
                ${renderMetricCard("Закрытые разделы", String(menuItems.filter((item) => Boolean(item.productId)).length), `${menuItems.length} всего разделов`)}
                ${renderMetricCard("Продукты", String(products.length), `${renderStatusBadge(`Боевые ${liveProducts.length}`, "live")} ${renderStatusBadge(`Тест ${testProducts.length}`, "test")}`)}
                ${renderMetricCard("Активные доступы", String(activeAccessCount), `${renderStatusBadge(`Скоро истекут ${expiringSoonCount}`, expiringSoonCount ? "expiring" : "muted")}`)}
                ${renderMetricCard("Ожидающие платежи", String(pendingPaymentsCount), `${renderStatusBadge(`Депозиты в ожидании ${pendingDepositsCount}`, pendingDepositsCount ? "pending" : "muted")}`)}
                ${renderMetricCard("Проблемы expiry/removal", String(failedExpiryJobsCount), failedExpiryJobsCount ? `${renderStatusBadge("Проверьте ошибки удаления", "failed")}` : `${renderStatusBadge("Сбоев не найдено", "active")}`)}
              </div>
              <div class="bo-form-cluster" style="margin-top:16px">
                <div class="bo-form-cluster-head">
                  <div>
                    <div class="bo-form-cluster-title">Порядок работы</div>
                    <div class="bo-form-cluster-copy">Этот блок оставляет операционный сценарий перед глазами, чтобы по странице не приходилось идти сверху вниз для понимания следующего шага.</div>
                  </div>
                </div>
                <ol class="flow-list">
                  <li><strong>Создайте продукт</strong> в LIVE или TEST-контуре в зависимости от сценария.</li>
                  <li><strong>Привяжите продукт к разделу</strong> в блоке «Контент и доступ».</li>
                  <li><strong>Проверьте CTA и linked chats</strong> перед выдачей доступа.</li>
                  <li><strong>Для TEST</strong> используйте ручную выдачу доступа, чтобы прогнать reminders и expiry за минуты.</li>
                  <li><strong>Ошибки удаления и статусы доступа</strong> отслеживайте в аудите.</li>
                </ol>
              </div>`,
            tone: "raised"
          })}
            ${renderSubsection({
              title: "Управление контуром",
              subtitle: "Глобальный переключатель и режим оформления оплаты вынесены в отдельный управляющий rail, чтобы не смешиваться с таблицами и каталогом продуктов.",
              body: `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/toggle" class="form-row">
                  <div class="field">
                    <label class="small">Режим</label>
                    <select name="paidAccessEnabled" class="field">
                      <option value="true" ${bot.paidAccessEnabled ? "selected" : ""}>Включено</option>
                      <option value="false" ${!bot.paidAccessEnabled ? "selected" : ""}>Выключено</option>
                    </select>
                  </div>
                  <div class="btn"><button type="submit">Сохранить</button></div>
                </form>
                <div class="bo-note bo-note--info" style="margin-top:14px">
                  <strong>Режим оформления оплаты</strong><br>
                  ${balanceFlowEnabled ? "Работает пополнение баланса с покупкой с баланса." : "Используется прямой счёт / ручной запрос оплаты."}
                </div>
                <div class="small" style="margin-top:10px">TEST и LIVE сохраняют разные source of truth: <code>durationMinutes &gt; 0</code> для TEST и <code>durationDays</code> / standard flow для production. Reminders и статусы доступа не скрываются.</div>`,
              tone: "utility"
            })}
          </div>
          ${renderSubsection({
            id: "bindings",
            title: "Контент и доступ",
            subtitle:
              "Здесь сохраняется текущий business-flow: раздел → привязка продукта → страница-витрина → CTA-кнопка оплаты в боте. Визуально он разложен по рабочим модулям, но логика не меняется.",
            body: `${renderNote("info", "Разделы, статусы закрытия и CTA-кнопки остаются полностью явными. Здесь же сохраняется привязка продукта к конкретному контентному entry point.")}<div style="margin-top:14px">${bindingsTable}</div>`,
            tone: "default"
          })}`,
          tone: "primary"
        })}
        ${renderStageBlock({
          eyebrow: "Каталог продуктов",
          title: "Боевые и тестовые сценарии",
          subtitle:
            "LIVE и TEST теперь отделены не только бейджами, но и самим уровнем композиции. Это позволяет быстрее переключаться между реальными продажами и лабораторным прогоном lifecycle.",
          actions: `${renderStatusBadge(`LIVE ${liveProducts.length}`, "live")} ${renderStatusBadge(`TEST ${testProducts.length}`, "test")}`,
          body: `<div class="bo-grid-2">
              ${renderSubsection({
                id: "live-products",
                title: "Боевые продукты",
                subtitle:
                  "Production-настройка для реальных продаж. Здесь intentionally нет ускоренной минутной логики, чтобы live и test не смешивались визуально.",
                body: `${liveCreateBlock}
                  <div class="products-existing-block">
                    <div class="section-title">Существующие live-products</div>
                    ${liveProducts.length ? liveProducts.map((product) => renderProductCard(product, { allowSimulate: false })).join("") : `<div class="small">Пока нет live-продуктов.</div>`}
                  </div>`,
                tone: "raised"
              })}
              ${renderSubsection({
                id: "test-lab",
                title: "Тестовая лаборатория",
                subtitle:
                  "Отдельный ускоренный контур для проверки полного access lifecycle без ожидания днями. TEST статусы и минутные reminders не скрыты и остаются явно отмеченными.",
                body: `${testCreateBlock}
                  <div class="products-existing-block">
                    <div class="section-title">Тестовые продукты</div>
                    ${testProducts.length ? testProducts.map((product) => renderProductCard(product, { allowSimulate: true })).join("") : `<div class="small">Пока нет тестовых продуктов. Создайте первый, чтобы быстро прогонять весь сценарий руками.</div>`}
                  </div>`,
                tone: "utility"
              })}
            </div>`,
          tone: "primary"
        })}
        ${renderStageBlock({
          eyebrow: "Финансовый контур",
          title: "Платежи, баланс и settlement",
          subtitle:
            "Финансовый слой отделён от product setup: сначала поток оплаты и пользовательские события, затем конфиг выплат, owner-пул и техническая диагностика.",
          body: `<div class="bo-stage-grid-rail">
            ${renderSubsection({
            id: "payments-balance",
            title: "Платежи / баланс",
            subtitle:
              "Платёжный поток и уведомления визуально отделены от product setup. Основные операции слева, событийному логу и истории отдан отдельный модуль.",
            body: `<div class="bo-stage-grid-2">
                <div class="bo-form-cluster">
                  <div class="bo-form-cluster-head">
                    <div>
                      <div class="bo-form-cluster-title">Режим оплаты</div>
                      <div class="bo-form-cluster-copy">Короткая легенда потока оплаты, чтобы быстрее интерпретировать события в таблице ниже.</div>
                    </div>
                  </div>
                  <div>${balanceFlowEnabled ? renderStatusBadge("NOWPayments активен (USDT BEP20)", "active") : renderStatusBadge("NOWPayments не настроен", "pending")}</div>
                  <ul class="mono-list" style="margin-top:10px">
                    <li><code>invoice/pending</code>: пользователь открыл оплату, ждём подтверждение.</li>
                    <li><code>deposit/confirmed</code>: баланс пополнен через NOWPayments.</li>
                    <li><code>balance purchase/completed</code>: продукт куплен с баланса.</li>
                    <li><code>NOWPayments IPN</code>: автоматическое подтверждение после оплаты.</li>
                  </ul>
                </div>
                <div class="bo-form-cluster">
                  <div class="bo-form-cluster-head">
                    <div>
                      <div class="bo-form-cluster-title">Последние уведомления</div>
                      <div class="bo-form-cluster-copy">Быстрый срез недавних финансовых событий без перехода к нижним diagnostic-таблицам.</div>
                    </div>
                  </div>
                  ${
                    recentNotifications.length
                      ? recentNotifications
                          .map(
                            (notification) => `<div style="margin-top:10px">
                                <div>${renderPaymentStatus(notification.status)} <code>${escapeHtml(notification.type)}</code></div>
                                <div class="small">${renderUserLabel(notification.user)} · ${formatIsoDate(notification.createdAt)}</div>
                              </div>`
                          )
                          .join("")
                      : `<div class="small">Пока нет уведомлений по событиям.</div>`
                  }
                </div>
              </div>
              <div class="section-title">События платежей</div>
              ${paymentEventsTable}`,
            tone: "raised"
          })}
            ${renderSubsection({
            id: "nowpayments",
            title: "NOWPayments / выплаты владельцу",
            subtitle:
              "Owner-пул, кошельки владельцев и отчётность по выплатам собраны в отдельный модуль. Основная настройка доступна без смешения с техническими логами.",
            body: `${nowpaymentsOwnersBlock}
              ${ownerReportingBlock}
              <div class="bo-form-cluster" style="margin-top:16px">
                <div class="bo-form-cluster-head">
                  <div>
                    <div class="bo-form-cluster-title">Конфиг NOWPayments</div>
                    <div class="bo-form-cluster-copy">Настройка пополнения баланса и ежедневных выплат владельцу бота.</div>
                  </div>
                </div>
                <form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/paid/nowpayments-config" class="bo-stack">
                  <div class="nowpayments-grid">
                    <div class="toggle-field"><label class="small" for="np-enabled">Включить NOWPayments</label><input id="np-enabled" type="checkbox" name="enabled" value="1" ${nowPaymentsConfig?.enabled ? "checked" : ""} /></div>
                    <div class="toggle-field"><label class="small" for="np-owner-payout">Owner payout включён</label><input id="np-owner-payout" type="checkbox" name="ownerPayoutEnabled" value="1" ${nowPaymentsConfig?.ownerPayoutEnabled ? "checked" : ""} /></div>
                    <div class="toggle-field"><label class="small" for="np-daily-payout">Ежедневные выплаты</label><input id="np-daily-payout" type="checkbox" name="dailyPayoutEnabled" value="1" ${nowPaymentsConfig?.dailyPayoutEnabled !== false ? "checked" : ""} /></div>
                    <div class="field-wrap"><label class="small">Кошелёк owner (USDT BEP20)</label><input name="ownerWalletAddress" type="text" placeholder="0x..." value="${escapeHtml(nowPaymentsConfig?.ownerWalletAddress ?? "")}" style="width:100%" /></div>
                    <input type="hidden" name="settlementCurrency" value="usdtbep20" />
                    <div class="field-wrap"><label class="small">Минимум для выплаты (USDT)</label><input name="dailyPayoutMinAmount" type="text" value="${escapeHtml(String(nowPaymentsConfig?.dailyPayoutMinAmount ?? 0))}" /></div>
                  </div>
                  <div class="bo-actions" style="justify-content:flex-start"><button type="submit">Сохранить конфиг</button></div>
                </form>
              </div>`,
            tone: "utility"
          })}
          </div>
          ${renderSubsection({
            title: "Settlement и начисления",
            subtitle: "Сводка по нетто, последние payout batches и журнал начислений вынесены в отдельный модуль, чтобы settlement было проще читать как самостоятельный финансовый поток.",
            body: `<div class="bo-stage-grid-2">
                <div class="bo-form-cluster">
                  <div class="bo-form-cluster-head">
                    <div>
                      <div class="bo-form-cluster-title">Сводка по начислениям</div>
                      <div class="bo-form-cluster-copy">Ожидающее нетто и число записей в settlement-пуле по текущему боту.</div>
                    </div>
                  </div>
                  <div class="bo-kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    ${renderMetricCard("Записей в ожидании", String(settlementAgg._count), "", "bo-kpi-card--compact")}
                    ${renderMetricCard("К выплате нетто", Number(settlementAgg._sum.netAmountBeforePayoutFee ?? 0).toFixed(2), "USDT", "bo-kpi-card--compact")}
                  </div>
                </div>
                <div class="bo-form-cluster">
                  <div class="bo-form-cluster-head">
                    <div>
                      <div class="bo-form-cluster-title">Пакеты выплат</div>
                      <div class="bo-form-cluster-copy">Последние попытки выплаты владельцам без переключения в логовую диагностику.</div>
                    </div>
                  </div>
                  ${
                    payoutBatches.length
                      ? payoutBatches
                          .slice(0, 5)
                          .map((b) => {
                            const batchRu: Record<string, string> = {
                              CREATED: "Создан",
                              SENT: "Отправлен",
                              PARTIAL: "Частично",
                              PAID: "Выплачен",
                              FAILED: "Ошибка"
                            };
                            const st = batchRu[b.status] ?? b.status;
                            return `<div class="small" style="margin-top:8px">${formatIsoDate(b.runDate)} · ${escapeHtml(st)} · ${Number(b.netTotal).toFixed(2)} USDT</div>`;
                          })
                          .join("")
                      : `<div class="small">Нет батчей</div>`
                  }
                </div>
              </div>
              <div class="section-title" style="margin-top:16px">Записи начислений (последние)</div>
              ${
                settlementEntries.length
                  ? `<div class="bo-table-shell"><table class="paid-table"><thead><tr><th>Когда</th><th>Пользователь (пополнил)</th><th>Заказ</th><th>Валовая</th><th>Нетто</th><th>Справочно: владелец</th><th>Статус</th></tr></thead><tbody>${settlementEntries
                      .map((e) => {
                        const attributed =
                          e.attributedOwnerUserId && ownerUserIdSet.has(e.attributedOwnerUserId)
                            ? e.attributedOwnerUserId
                            : attributeSettlementToOwnerUserId(e.depositTransaction?.user ?? null);
                        const ou = attributed ? ownerUserById.get(attributed) : undefined;
                        const attCell =
                          attributed && ou
                            ? renderUserLabel(ou)
                            : attributed
                              ? `<code>${escapeHtml(attributed)}</code>`
                              : `<span class="small">общий пул</span>`;
                        const payerCell = formatSettlementDepositorCell(e.depositTransaction?.user ?? undefined);
                        return `<tr><td>${formatIsoDate(e.createdAt)}</td><td>${payerCell}</td><td class="mono-wrap"><code>${escapeHtml(e.depositTransaction?.orderId ?? "-")}</code></td><td>${Number(e.grossAmount).toFixed(2)}</td><td>${Number(e.netAmountBeforePayoutFee).toFixed(2)}</td><td>${attCell}</td><td>${renderPaymentStatus(e.status)}</td></tr>`;
                      })
                      .join("")}</tbody></table></div>`
                  : `<div class="small">Нет записей</div>`
              }`,
            tone: "utility"
          })}
          ${renderSubsection({
            title: "Техническая диагностика NOWPayments",
            subtitle: "Webhook-логи и диагностика депозитов оставлены полностью доступными, но вынесены в отдельный диагностический модуль, чтобы не перегружать основной финансовый поток.",
            body: `<details style="margin-top:0">
                <summary class="small">Логи webhook (NOWPayments, только этот бот)</summary>
                ${
                  webhookLogs.length
                    ? `<div class="bo-table-shell" style="margin-top:8px"><table class="paid-table"><thead><tr><th>Когда</th><th>Событие</th><th>Подпись</th><th>Результат</th></tr></thead><tbody>${webhookLogs
                        .map(
                          (w) => `<tr><td>${formatIsoDate(w.createdAt)}</td><td><code>${escapeHtml(String((w.bodyJson as any)?.payment_id ?? "-"))}</code></td><td>${w.signatureValid ? "✓" : "✗"}</td><td>${escapeHtml(w.processingResult ?? "-")}</td></tr>`
                        )
                        .join("")}</tbody></table></div>`
                    : `<div class="small" style="margin-top:8px">Нет логов</div>`
                }
              </details>
              <details style="margin-top:12px">
                <summary class="small">Диагностика депозитов (только этот бот)</summary>
                ${
                  depositDiagnosticsRows.length
                    ? `<div class="bo-table-shell" style="margin-top:8px"><table class="paid-table"><thead><tr><th>Когда</th><th>Имя</th><th>Фамилия</th><th>Логин Telegram</th><th>Заказ</th><th>ID платежа</th><th>Статус провайдера</th><th>Кошелёк</th><th>Сумма</th><th>Мин. 98%</th><th>Поступило</th><th>Порог</th><th>Зачислено</th><th>Статус депозита</th><th>Продукт</th><th>Причина</th><th>Поддержка</th></tr></thead><tbody>${depositDiagnosticsRows
                        .map(
                          (d) => `<tr><td>${formatIsoDate(d.createdAt)}</td><td>${escapeHtml(d.depositorFirstName)}</td><td>${escapeHtml(d.depositorLastName)}</td><td>${d.telegramLoginCell}</td><td class="mono-wrap"><code>${escapeHtml(d.orderId)}</code></td><td class="mono-wrap"><code>${escapeHtml(d.providerPaymentId ?? "-")}</code></td><td><code>${escapeHtml(d.providerStatus ?? "-")}</code></td><td class="wallet-col"><code>${escapeHtml(d.providerPayAddress ?? "-")}</code></td><td>${escapeHtml(Number(d.requestedAmountUsd ?? 0).toFixed(2))}</td><td>${escapeHtml(Number(d.minAccepted ?? 0).toFixed(2))}</td><td>${escapeHtml(d.actualOutcomeAmount == null ? "-" : Number(d.actualOutcomeAmount).toFixed(8))}</td><td><code>${escapeHtml(d.toleranceLabel)}</code></td><td>${escapeHtml(Number(d.creditedBalanceAmount ?? 0).toFixed(8))}</td><td>${renderPaymentStatus(d.status)}</td><td class="mono-wrap"><code>${escapeHtml(d.productId ?? "-")}</code></td><td><code>${escapeHtml(d.reason)}</code></td><td>${d.status === "CONFIRMED" ? `<span class="small">—</span>` : `<form method="POST" action="/backoffice/api/bots/${escapeHtml(bot.id)}/deposits/${escapeHtml(d.orderId)}/emergency-confirm" style="margin:0"><input name="reason" type="text" placeholder="Комментарий" style="min-width:180px" /><button type="submit" class="secondary" style="margin-top:6px;background:rgba(34,197,94,0.18);border-color:rgba(34,197,94,0.45);">Подтвердить вручную</button></form>`}</td></tr>`
                        )
                        .join("")}</tbody></table></div>`
                    : `<div class="small" style="margin-top:8px">Нет строк депозитов</div>`
                }
              </details>`,
            tone: "diagnostic"
          })}`,
          tone: "utility"
        })}
        ${renderStageBlock({
          eyebrow: "Наблюдаемость",
          title: "Аудит доступа и критические статусы",
          subtitle:
            "Отдельный диагностический слой, который не конкурирует с основными действиями, но оставляет FAILED, REMOVAL UNAVAILABLE и всю observability полностью видимыми.",
          actions: failedExpiryJobsCount ? renderStatusBadge(`Ошибки удаления ${failedExpiryJobsCount}`, "failed") : renderStatusBadge("Сбоев удаления нет", "active"),
          body: `${renderSubsection({
            id: "access-audit",
            title: "Аудит / события доступа",
            subtitle:
              "Таблица сохраняет все важные сигналы: статусы доступа, reminders, expiry/removal и readiness linked chats. FAILED-состояния и проблемы удаления не скрываются.",
            body: `${renderNote(
              "info",
              `LIVE использует reminders за <strong>3 / 2 / 1 дня</strong>, TEST — за <strong>3 / 2 / 1 минуты</strong>. Истечение и удаление читаются в последнем столбце без скрытия критических статусов.`
            )}
            <div style="margin-top:16px">${accessAuditTable}</div>`,
            tone: "diagnostic"
          })}`,
          tone: "diagnostic"
        })}
        <div class="bo-actions" style="justify-content:flex-start">
          ${renderActionLink("Назад к настройкам", `/backoffice/bots/${escapeHtml(bot.id)}/settings`, "secondary")}
        </div>`
      )
    );
  });

  server.get("/backoffice/bots/:botId/paid/owner-report.csv", async (req, reply) => {
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

    const npCfg = await prisma.botPaymentProviderConfig.findUnique({ where: { botInstanceId: bot.id } });
    const payoutTz = npCfg?.payoutTimeZone?.trim() || "UTC";
    const orFromQ = parseYmd((req.query as Record<string, unknown>).orFrom);
    const orToQ = parseYmd((req.query as Record<string, unknown>).orTo);
    const { from: orFromYmd, to: orToYmd } = normalizeOwnerReportRange(orFromQ, orToQ, payoutTz);

    const [
      csvBotOwnerAssignments,
      csvBotOwnerPayoutWallets,
      csvPendingSettlements,
      csvSettlementPaidByAttr,
      csvAccruals,
      csvPaidInBatches,
      csvRecipientLog
    ] = await Promise.all([
      prisma.botRoleAssignment.findMany({
        where: { botInstanceId: bot.id, role: "OWNER", status: "ACTIVE" },
        include: {
          user: { select: { id: true, fullName: true, username: true, telegramUserId: true } }
        },
        orderBy: { telegramUsernameNormalized: "asc" }
      }),
      prisma.botOwnerPayoutWallet.findMany({ where: { botInstanceId: bot.id } }),
      prisma.ownerSettlementEntry.findMany({
        where: { botInstanceId: bot.id, status: "PENDING" },
        include: {
          depositTransaction: {
            include: {
              user: { select: { invitedByUserId: true, mentorUserId: true } }
            }
          }
        }
      }),
      prisma.ownerSettlementEntry.groupBy({
        by: ["attributedOwnerUserId"],
        where: {
          botInstanceId: bot.id,
          status: { in: ["BATCHED", "PAID"] },
          batchId: { not: null },
          batch: { status: { not: "FAILED" } }
        },
        _sum: { netAmountBeforePayoutFee: true }
      }),
      prisma.ownerSettlementEntry.findMany({
        where: {
          botInstanceId: bot.id,
          createdAt: { gte: new Date(Date.now() - 450 * 86_400_000) }
        },
        select: {
          attributedOwnerUserId: true,
          netAmountBeforePayoutFee: true,
          createdAt: true
        }
      }),
      prisma.ownerSettlementEntry.findMany({
        where: {
          botInstanceId: bot.id,
          status: { in: ["BATCHED", "PAID"] },
          batchId: { not: null },
          batch: {
            status: { not: "FAILED" },
            createdAt: { gte: new Date(Date.now() - 450 * 86_400_000) }
          }
        },
        select: {
          attributedOwnerUserId: true,
          netAmountBeforePayoutFee: true,
          batch: { select: { executedAt: true, runDate: true } }
        }
      }),
      prisma.ownerPayoutBatchRecipient.findMany({
        where: { batch: { botInstanceId: bot.id } },
        orderBy: { createdAt: "desc" },
        take: 500,
        include: {
          batch: { select: { executedAt: true, runDate: true, status: true } },
          ownerUser: { select: { id: true, fullName: true, username: true, telegramUserId: true } }
        }
      })
    ]);

    const csvOwnerUserIdSet = new Set(
      csvBotOwnerAssignments.map((a) => a.userId).filter((id): id is string => Boolean(id))
    );
    const csvOwnerWalletByUserId = new Map(csvBotOwnerPayoutWallets.map((w) => [w.ownerUserId, w.walletAddress]));

    const csvAttr = (
      u: { invitedByUserId: string | null; mentorUserId: string | null } | null | undefined
    ): string | null => {
      if (!u) return null;
      if (u.invitedByUserId && csvOwnerUserIdSet.has(u.invitedByUserId)) return u.invitedByUserId;
      if (u.mentorUserId && csvOwnerUserIdSet.has(u.mentorUserId)) return u.mentorUserId;
      return null;
    };

    const csvPendingByOwner = new Map<string, number>();
    let csvPoolPending = 0;
    for (const e of csvPendingSettlements) {
      const net = Number(e.netAmountBeforePayoutFee);
      const oid =
        e.attributedOwnerUserId && csvOwnerUserIdSet.has(e.attributedOwnerUserId)
          ? e.attributedOwnerUserId
          : csvAttr(e.depositTransaction?.user ?? null);
      if (oid) csvPendingByOwner.set(oid, (csvPendingByOwner.get(oid) ?? 0) + net);
      else csvPoolPending += net;
    }

    const csvPaidTotal = new Map<string | null, number>();
    for (const row of csvSettlementPaidByAttr) {
      csvPaidTotal.set(row.attributedOwnerUserId, Number(row._sum.netAmountBeforePayoutFee ?? 0));
    }

    const csvPaidPeriod = new Map<string | null, number>();
    for (const e of csvPaidInBatches) {
      const when = e.batch?.executedAt ?? e.batch?.runDate;
      if (!when) continue;
      const ymd = calendarDateInTimeZone(when, payoutTz);
      if (!ymdInInclusiveRange(ymd, orFromYmd, orToYmd)) continue;
      const k = e.attributedOwnerUserId;
      csvPaidPeriod.set(k, (csvPaidPeriod.get(k) ?? 0) + Number(e.netAmountBeforePayoutFee));
    }

    const csvEarnedPeriod = new Map<string | null, number>();
    for (const row of csvAccruals) {
      const dk = calendarDateInTimeZone(row.createdAt, payoutTz);
      if (!ymdInInclusiveRange(dk, orFromYmd, orToYmd)) continue;
      const key = row.attributedOwnerUserId;
      csvEarnedPeriod.set(key, (csvEarnedPeriod.get(key) ?? 0) + Number(row.netAmountBeforePayoutFee));
    }

    const sep = ";";
    const lines: string[] = [];
    lines.push(
      [
        "section",
        "owner_name",
        "telegram_login",
        "telegram_id",
        "wallet_bep20",
        "pending_usdt",
        "paid_total_usdt",
        "paid_in_period_usdt",
        "accrued_in_period_usdt",
        "payout_tz",
        "period_from",
        "period_to",
        "bot_id"
      ].join(sep)
    );

    const poolWallet = npCfg?.ownerWalletAddress?.trim() ?? "";

    for (const a of csvBotOwnerAssignments) {
      if (!a.userId || !a.user) continue;
      const u = a.user;
      const w = csvOwnerWalletByUserId.get(a.userId) ?? "";
      lines.push(
        [
          "OWNER",
          csvEscapeCell(u.fullName?.trim() || ""),
          csvEscapeCell(u.username ? `@${u.username}` : ""),
          csvEscapeCell(String(u.telegramUserId)),
          csvEscapeCell(w || "-> pool"),
          csvEscapeCell((csvPendingByOwner.get(a.userId) ?? 0).toFixed(2)),
          csvEscapeCell((csvPaidTotal.get(a.userId) ?? 0).toFixed(2)),
          csvEscapeCell((csvPaidPeriod.get(a.userId) ?? 0).toFixed(2)),
          csvEscapeCell((csvEarnedPeriod.get(a.userId) ?? 0).toFixed(2)),
          csvEscapeCell(payoutTz),
          csvEscapeCell(orFromYmd),
          csvEscapeCell(orToYmd),
          csvEscapeCell(bot.id)
        ].join(sep)
      );
    }

    if (
      csvPoolPending > 0 ||
      (csvPaidTotal.get(null) ?? 0) > 0 ||
      (csvPaidPeriod.get(null) ?? 0) > 0 ||
      (csvEarnedPeriod.get(null) ?? 0) > 0
    ) {
      lines.push(
        [
          "POOL",
          csvEscapeCell("Общий пул"),
          "",
          "",
          csvEscapeCell(poolWallet),
          csvEscapeCell(csvPoolPending.toFixed(2)),
          csvEscapeCell((csvPaidTotal.get(null) ?? 0).toFixed(2)),
          csvEscapeCell((csvPaidPeriod.get(null) ?? 0).toFixed(2)),
          csvEscapeCell((csvEarnedPeriod.get(null) ?? 0).toFixed(2)),
          csvEscapeCell(payoutTz),
          csvEscapeCell(orFromYmd),
          csvEscapeCell(orToYmd),
          csvEscapeCell(bot.id)
        ].join(sep)
      );
    }

    lines.push("");
    lines.push(
      [
        "section",
        "batch_datetime",
        "recipient_name",
        "telegram_login",
        "wallet",
        "net_usdt",
        "entry_count",
        "batch_status"
      ].join(sep)
    );

    const batchRu: Record<string, string> = {
      CREATED: "Создан",
      SENT: "Отправлен",
      PARTIAL: "Частично",
      PAID: "Выплачен",
      FAILED: "Ошибка"
    };
    const csvHist = csvRecipientLog.filter((r) => {
      const when = r.batch.executedAt ?? r.batch.runDate;
      const ymd = calendarDateInTimeZone(when, payoutTz);
      return ymdInInclusiveRange(ymd, orFromYmd, orToYmd);
    });
    for (const r of csvHist) {
      const when = r.batch.executedAt ?? r.batch.runDate;
      const name = r.ownerUser?.fullName?.trim() ?? "Общий пул";
      const login = r.ownerUser?.username ? `@${r.ownerUser.username}` : "";
      lines.push(
        [
          "payout_line",
          csvEscapeCell(formatIsoDate(when)),
          csvEscapeCell(name),
          csvEscapeCell(login),
          csvEscapeCell(r.walletAddress),
          csvEscapeCell(Number(r.netAmount).toFixed(2)),
          csvEscapeCell(String(r.entryCount)),
          csvEscapeCell(batchRu[r.batch.status] ?? r.batch.status)
        ].join(sep)
      );
    }

    const filename = `owner-report-${bot.id.slice(0, 8)}-${orFromYmd}-${orToYmd}.csv`;
    const csv = "\uFEFF" + lines.join("\n");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(csv);
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

  server.post("/backoffice/api/bots/:botId/paid/owner-payout-wallet", async (req, reply) => {
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
    const ownerUserId = String(body?.ownerUserId ?? "").trim();
    const walletAddressRaw = String(body?.walletAddress ?? "").trim();
    if (!ownerUserId) {
      return reply.redirect(`/backoffice/bots/${encodeURIComponent(bot.id)}/paid?error=${encodeURIComponent("Не указан владелец")}#nowpayments`);
    }

    const assignment = await prisma.botRoleAssignment.findFirst({
      where: { botInstanceId: bot.id, userId: ownerUserId, role: "OWNER", status: "ACTIVE" }
    });
    if (!assignment) {
      return reply.redirect(`/backoffice/bots/${encodeURIComponent(bot.id)}/paid?error=${encodeURIComponent("Пользователь не является активным OWNER")}#nowpayments`);
    }

    if (!walletAddressRaw) {
      await prisma.botOwnerPayoutWallet.deleteMany({ where: { botInstanceId: bot.id, ownerUserId } });
      return reply.redirect(`/backoffice/bots/${encodeURIComponent(bot.id)}/paid#nowpayments`);
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddressRaw)) {
      return reply.redirect(
        `/backoffice/bots/${encodeURIComponent(bot.id)}/paid?error=${encodeURIComponent("Неверный адрес BEP20 (ожидается 0x + 40 hex)")}#nowpayments`
      );
    }

    await prisma.botOwnerPayoutWallet.upsert({
      where: { botInstanceId_ownerUserId: { botInstanceId: bot.id, ownerUserId } },
      create: { botInstanceId: bot.id, ownerUserId, walletAddress: walletAddressRaw },
      update: { walletAddress: walletAddressRaw }
    });

    return reply.redirect(`/backoffice/bots/${encodeURIComponent(bot.id)}/paid#nowpayments`);
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
        t("bo_roles_title"),
        `<h2 style="margin-top:0">${escapeHtml(t("bo_roles_title"))}</h2>
         <div class="small">Бот: <code>${escapeHtml(bot.id)}</code></div>
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
                       <div class="small" style="margin-top:6px">Роль: <code>${escapeHtml(a.role)}</code> · статус: <code>${escapeHtml(a.status)}</code></div>
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
        "Платежи (ручное подтверждение)",
        `<h2 style="margin-top:0">Платежи (ручное подтверждение)</h2>
         <div class="small">Бот: <code>${escapeHtml(bot.id)}</code></div>
         <div class="small" style="margin-top:6px">Ожидают подтверждения: ${payments.length}</div>

         ${
           payments.length
             ? payments
                 .map((p) => {
                   return `<div style="margin-top:12px; padding:10px; border:1px solid rgba(255,255,255,0.12); border-radius:12px; background:rgba(255,255,255,0.04)">
                     <div><b>Платёж</b> <code>${escapeHtml(p.id)}</code> · статус <code>${escapeHtml(p.status)}</code></div>
                     <div class="small" style="margin-top:4px">Telegram ID пользователя: <code>${escapeHtml(String(p.user.telegramUserId))}</code></div>
                     <div class="small" style="margin-top:4px">Продукт: <code>${escapeHtml(p.product.code)}</code> · сумма: <code>${escapeHtml(String(p.product.price))}</code> ${escapeHtml(p.product.currency)}</div>
                     <div class="small" style="margin-top:4px">Референс: <code>${escapeHtml(p.referenceCode)}</code></div>
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
