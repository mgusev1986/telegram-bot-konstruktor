/**
 * Premium landing page for botzik.pp.ua (apex domain).
 *
 * Registered on the same Fastify server as the backoffice + webhooks.
 * Routing is Host-header driven:
 *   - admin.*  → redirect to /backoffice/login (existing admin UX)
 *   - www./apex / anything else → serve the landing page
 * The /health endpoint stays reachable on every hostname for Cloudflare checks.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

export const LANDING_CTA_TELEGRAM = "https://t.me/maximgusev1986";
const ADMIN_HOST_PATTERN = /(^|\.)admin\./i;

function resolveHost(req: FastifyRequest): string {
  const raw = req.headers.host ?? "";
  return String(raw).toLowerCase().trim();
}

function isAdminHost(host: string): boolean {
  return ADMIN_HOST_PATTERN.test(host);
}

export function registerLandingRoutes(server: FastifyInstance): void {
  server.get("/", async (req, reply) => {
    const host = resolveHost(req);
    if (isAdminHost(host)) {
      return reply.redirect("/backoffice/login", 302);
    }
    reply.type("text/html; charset=utf-8");
    reply.header("cache-control", "public, max-age=300, must-revalidate");
    return renderLandingHtml();
  });

  // Explicit routes for apex extras so the landing never 404s
  server.get("/index.html", async (_req, reply) => reply.redirect("/", 301));
  server.get("/pricing", async (_req, reply) => reply.redirect("/#pricing", 301));
  server.get("/features", async (_req, reply) => reply.redirect("/#features", 301));
  server.get("/contact", async (_req, reply) => reply.redirect(LANDING_CTA_TELEGRAM, 302));
  server.get("/robots.txt", async (_req, reply) => {
    reply.type("text/plain");
    return "User-agent: *\nAllow: /\nDisallow: /backoffice/\nDisallow: /webhooks/\n";
  });
}

/** HTML for the landing. Pure server-side string — no external assets required. */
export function renderLandingHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Botzik · Конструктор Telegram-ботов для бизнеса, сетевого маркетинга и личного бренда</title>
  <meta name="description" content="Готовый конструктор Telegram-ботов: платные разделы, многоуровневая партнёрка, NOWPayments, рассылки, drip-цепочки, мультиязычность. $1000 — один раз, доступ навсегда." />
  <meta property="og:title" content="Botzik · Premium Telegram Bot Constructor" />
  <meta property="og:description" content="Соберите Telegram-бот премиум-уровня за вечер. Платные разделы, многоуровневая партнёрка, рассылки — без разработчиков. $1000 навсегда." />
  <meta property="og:type" content="website" />
  <meta name="theme-color" content="#070d16" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #05070d;
      --bg-2: #080d17;
      --bg-3: #0c1321;
      --surface: rgba(15, 22, 36, 0.7);
      --surface-hi: rgba(22, 33, 53, 0.85);
      --border: rgba(118, 152, 186, 0.2);
      --border-hi: rgba(0, 229, 255, 0.35);
      --text: #f3f8ff;
      --text-soft: #c6d2e4;
      --muted: #8a9bb4;
      --accent: #00e5ff;
      --accent-2: #7dd3fc;
      --accent-ink: #03141b;
      --gold: #facc15;
      --success: #34d399;
      --danger: #fb7185;
      --grad-hero: radial-gradient(ellipse at top, rgba(0,229,255,0.18), transparent 50%), radial-gradient(ellipse at bottom left, rgba(125,211,252,0.08), transparent 55%);
      --grad-cta: linear-gradient(135deg, #00e5ff 0%, #7dd3fc 60%, #34d399 110%);
      --shadow-lg: 0 32px 80px rgba(0, 229, 255, 0.18), 0 12px 36px rgba(4, 10, 20, 0.6);
      --shadow-md: 0 18px 48px rgba(4, 10, 20, 0.35);
      --radius-xl: 28px;
      --radius-lg: 20px;
      --radius-md: 14px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: "Inter", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(circle at 20% -10%, rgba(0,229,255,0.16), transparent 45%),
        radial-gradient(circle at 85% 5%, rgba(125,211,252,0.1), transparent 40%),
        linear-gradient(180deg, #030509 0%, var(--bg) 30%, var(--bg-2) 100%);
      color: var(--text);
      min-height: 100vh;
      letter-spacing: 0.01em;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.013) 1px, transparent 1px);
      background-size: 160px 160px;
      mask-image: radial-gradient(circle at center, black 4%, transparent 72%);
      opacity: 0.3;
      z-index: 0;
    }
    a { color: var(--accent-2); text-decoration: none; transition: color 0.15s ease; }
    a:hover { color: #ffffff; }
    .container { max-width: 1180px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }

    /* --- Navbar --- */
    .nav {
      position: sticky;
      top: 0;
      z-index: 30;
      background: linear-gradient(180deg, rgba(5,7,13,0.9), rgba(5,7,13,0.55));
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .nav__inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 16px 24px;
      max-width: 1180px;
      margin: 0 auto;
    }
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .logo__mark {
      width: 36px;
      height: 36px;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--grad-cta);
      color: var(--accent-ink);
      font-weight: 900;
      font-size: 18px;
      box-shadow: 0 10px 32px rgba(0,229,255,0.3);
    }
    .nav__links { display: flex; gap: 26px; font-size: 14px; color: var(--muted); }
    .nav__links a { color: var(--muted); font-weight: 500; }
    .nav__links a:hover { color: var(--text); }
    .nav__actions { display: flex; gap: 10px; align-items: center; }

    /* --- Buttons --- */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 22px;
      border-radius: 14px;
      font-weight: 600;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      border: 1px solid transparent;
      transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.15s ease;
    }
    .btn--primary {
      background: var(--grad-cta);
      color: var(--accent-ink);
      box-shadow: 0 18px 40px rgba(0, 229, 255, 0.3), inset 0 1px 0 rgba(255,255,255,0.4);
      font-weight: 700;
    }
    .btn--primary:hover { transform: translateY(-1px); box-shadow: 0 22px 48px rgba(0, 229, 255, 0.4); color: var(--accent-ink); }
    .btn--ghost {
      background: rgba(255,255,255,0.04);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn--ghost:hover { background: rgba(255,255,255,0.08); color: var(--text); }
    .btn--xl { padding: 18px 32px; font-size: 16px; border-radius: 18px; }

    /* --- Hero --- */
    .hero {
      position: relative;
      padding: 80px 0 100px;
      background: var(--grad-hero);
    }
    .hero__badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      border: 1px solid var(--border-hi);
      background: rgba(0,229,255,0.08);
      font-weight: 600;
      margin-bottom: 24px;
    }
    .hero__badge::before {
      content: ""; width: 7px; height: 7px; border-radius: 50%;
      background: var(--accent); box-shadow: 0 0 0 5px rgba(0,229,255,0.14);
    }
    .hero h1 {
      font-size: clamp(36px, 5.5vw, 64px);
      line-height: 1.05;
      letter-spacing: -0.03em;
      margin: 0 0 24px;
      font-weight: 800;
      max-width: 860px;
    }
    .hero h1 .accent {
      background: linear-gradient(135deg, #00e5ff 0%, #7dd3fc 60%, #34d399 110%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .hero__lead {
      max-width: 680px;
      font-size: clamp(16px, 1.8vw, 19px);
      line-height: 1.55;
      color: var(--text-soft);
      margin: 0 0 36px;
    }
    .hero__cta-row {
      display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
    }
    .hero__meta {
      display: flex; gap: 22px; flex-wrap: wrap;
      margin-top: 36px; color: var(--muted); font-size: 13px;
    }
    .hero__meta b { color: var(--text); font-weight: 700; }
    .hero__preview {
      margin-top: 58px;
      padding: 14px;
      background: linear-gradient(180deg, rgba(15,22,36,0.9), rgba(10,15,25,0.85));
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-lg);
    }
    .hero__preview-bar {
      display: flex; gap: 8px; padding: 10px 14px;
    }
    .hero__preview-bar span { width: 12px; height: 12px; border-radius: 50%; background: rgba(255,255,255,0.1); }
    .hero__preview-bar span:first-child { background: #fb7185; }
    .hero__preview-bar span:nth-child(2) { background: #facc15; }
    .hero__preview-bar span:nth-child(3) { background: #34d399; }
    .hero__preview-window {
      background: #070d16;
      border-radius: 18px;
      padding: 34px;
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 26px;
      min-height: 280px;
    }
    .hero__preview-side {
      padding: 20px; border-radius: 14px; background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
    }
    .hero__preview-side-row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px; border-radius: 10px; margin-bottom: 6px; font-size: 13px; color: var(--muted);
    }
    .hero__preview-side-row--active { background: rgba(0,229,255,0.12); color: var(--text); border: 1px solid var(--border-hi); }
    .hero__preview-side-row::before {
      content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.6;
    }
    .hero__preview-main { display: flex; flex-direction: column; gap: 14px; }
    .hero__preview-card {
      padding: 16px; border-radius: 12px;
      background: linear-gradient(180deg, rgba(15,25,41,0.9), rgba(10,18,30,0.85));
      border: 1px solid var(--border);
      font-size: 13px; color: var(--text-soft);
    }
    .hero__preview-card b { color: var(--accent-2); font-weight: 600; }

    /* --- Section --- */
    .section { padding: 80px 0; position: relative; }
    .section__head {
      display: flex; flex-direction: column; align-items: center;
      text-align: center; gap: 14px; margin-bottom: 50px;
    }
    .section__eyebrow {
      display: inline-block; padding: 5px 12px; border-radius: 999px;
      background: rgba(0,229,255,0.08); color: var(--accent);
      font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700;
      border: 1px solid var(--border-hi);
    }
    .section__title {
      font-size: clamp(28px, 4vw, 44px); line-height: 1.1; margin: 0;
      letter-spacing: -0.02em; font-weight: 800; max-width: 820px;
    }
    .section__copy { max-width: 640px; color: var(--text-soft); font-size: 16px; line-height: 1.55; margin: 0; }

    .grid { display: grid; gap: 20px; }
    .grid--4 { grid-template-columns: repeat(4, 1fr); }
    .grid--3 { grid-template-columns: repeat(3, 1fr); }
    .grid--2 { grid-template-columns: repeat(2, 1fr); }
    @media (max-width: 960px) {
      .grid--4 { grid-template-columns: repeat(2, 1fr); }
      .grid--3 { grid-template-columns: repeat(2, 1fr); }
      .hero__preview-window { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .grid--4, .grid--3, .grid--2 { grid-template-columns: 1fr; }
      .nav__links { display: none; }
      .hero { padding: 56px 0 70px; }
    }

    .card {
      padding: 28px;
      border-radius: var(--radius-lg);
      background: linear-gradient(180deg, rgba(15,22,36,0.8), rgba(8,13,23,0.8));
      border: 1px solid var(--border);
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .card:hover {
      transform: translateY(-4px);
      border-color: var(--border-hi);
      box-shadow: 0 24px 56px rgba(0, 229, 255, 0.08);
    }
    .card__icon {
      width: 48px; height: 48px; border-radius: 14px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(0,229,255,0.1);
      color: var(--accent);
      margin-bottom: 18px;
      font-size: 22px;
    }
    .card h3 { margin: 0 0 10px; font-size: 19px; letter-spacing: -0.01em; font-weight: 700; }
    .card p { margin: 0; color: var(--text-soft); font-size: 14.5px; line-height: 1.55; }

    /* Audience cards */
    .audience .card { position: relative; overflow: hidden; }
    .audience .card::after {
      content: ""; position: absolute; inset: auto -40% -60% auto;
      width: 220px; height: 220px; border-radius: 50%;
      background: radial-gradient(circle, rgba(0,229,255,0.18), transparent 70%);
      opacity: 0.6;
    }

    /* --- Steps --- */
    .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; counter-reset: step; }
    @media (max-width: 960px) { .steps { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px) { .steps { grid-template-columns: 1fr; } }
    .step {
      padding: 24px; border-radius: var(--radius-lg);
      background: rgba(10,15,25,0.6); border: 1px solid var(--border);
      position: relative;
    }
    .step__num {
      position: absolute; top: 18px; right: 18px;
      font-family: "JetBrains Mono", monospace;
      font-size: 36px; line-height: 1;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      -webkit-background-clip: text; background-clip: text; color: transparent;
      opacity: 0.22; font-weight: 700;
    }
    .step h3 { margin: 0 0 10px; font-size: 17px; }
    .step p { margin: 0; color: var(--text-soft); font-size: 14px; line-height: 1.55; }

    /* --- Pricing --- */
    .pricing {
      background: linear-gradient(180deg, rgba(15,22,36,0.6), rgba(5,7,13,0.6));
      position: relative;
    }
    .pricing::before {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(circle at top, rgba(0,229,255,0.1), transparent 50%);
    }
    .pricing__card {
      max-width: 560px; margin: 0 auto;
      padding: 40px 40px 36px;
      background: linear-gradient(180deg, rgba(0,229,255,0.1), rgba(15,22,36,0.95));
      border: 1px solid var(--border-hi);
      border-radius: 30px;
      box-shadow: 0 30px 80px rgba(0, 229, 255, 0.2);
      position: relative;
      overflow: hidden;
    }
    .pricing__ribbon {
      position: absolute; top: 18px; right: -46px;
      padding: 5px 56px; background: var(--gold); color: #0b0d17;
      font-size: 12px; font-weight: 800; letter-spacing: 0.1em;
      transform: rotate(45deg); text-transform: uppercase;
    }
    .pricing__head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 8px; flex-wrap: wrap; }
    .pricing__head h3 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
    .pricing__head .chip {
      display: inline-flex; padding: 3px 10px; border-radius: 999px;
      background: rgba(250,204,21,0.14); color: var(--gold);
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
      border: 1px solid rgba(250,204,21,0.3);
    }
    .pricing__price {
      display: flex; align-items: baseline; gap: 10px; margin: 14px 0 6px;
    }
    .pricing__price .amount { font-size: 72px; font-weight: 900; letter-spacing: -0.04em; background: var(--grad-cta); -webkit-background-clip: text; background-clip: text; color: transparent; line-height: 1; }
    .pricing__price .period { font-size: 20px; color: var(--muted); }
    .pricing__subnote { color: var(--text-soft); margin: 0 0 24px; font-size: 14px; }
    .pricing__list { list-style: none; padding: 0; margin: 0 0 28px; display: grid; gap: 10px; }
    .pricing__list li {
      padding-left: 28px;
      position: relative;
      color: var(--text-soft);
      font-size: 14.5px;
      line-height: 1.5;
    }
    .pricing__list li::before {
      content: "✓";
      position: absolute; left: 0; top: 0;
      width: 20px; height: 20px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(52,211,153,0.18); color: var(--success);
      font-weight: 800; font-size: 12px;
    }
    .pricing__footer { color: var(--muted); font-size: 12.5px; text-align: center; margin-top: 14px; }

    /* --- FAQ --- */
    .faq { max-width: 840px; margin: 0 auto; }
    .faq__item {
      padding: 20px 24px;
      border-radius: var(--radius-md);
      background: rgba(10,15,25,0.5);
      border: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .faq__item summary {
      cursor: pointer; font-weight: 600; font-size: 16px; list-style: none;
      display: flex; justify-content: space-between; align-items: center; gap: 18px;
    }
    .faq__item summary::after { content: "+"; color: var(--accent); font-size: 22px; font-weight: 400; transition: transform 0.2s ease; }
    .faq__item[open] summary::after { transform: rotate(45deg); }
    .faq__item p { margin: 14px 0 0; color: var(--text-soft); font-size: 14.5px; line-height: 1.6; }

    /* --- Final CTA --- */
    .final-cta {
      padding: 90px 24px;
      text-align: center;
      background:
        radial-gradient(ellipse at center, rgba(0,229,255,0.2), transparent 60%),
        linear-gradient(180deg, rgba(8,13,23,0.95), rgba(5,7,13,1));
      border-top: 1px solid var(--border);
    }
    .final-cta h2 { margin: 0 0 18px; font-size: clamp(26px, 3.5vw, 40px); letter-spacing: -0.02em; font-weight: 800; }
    .final-cta p { margin: 0 0 28px; color: var(--text-soft); font-size: 17px; max-width: 620px; margin-left: auto; margin-right: auto; }

    /* --- Footer --- */
    footer { padding: 40px 24px 60px; color: var(--muted); font-size: 13px; }
    footer .container { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; align-items: center; }
    footer a { color: var(--text-soft); }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav__inner">
      <a class="logo" href="/">
        <span class="logo__mark">B</span>
        <span>Botzik</span>
      </a>
      <div class="nav__links">
        <a href="#features">Возможности</a>
        <a href="#audience">Для кого</a>
        <a href="#how">Как это работает</a>
        <a href="#pricing">Цена</a>
        <a href="#faq">FAQ</a>
      </div>
      <div class="nav__actions">
        <a class="btn btn--ghost" href="https://admin.botzik.pp.ua/backoffice/login">Войти</a>
        <a class="btn btn--primary" href="#pricing">Купить за $1000</a>
      </div>
    </div>
  </nav>

  <section class="hero">
    <div class="container">
      <span class="hero__badge">Production · Premium · One-time $1000</span>
      <h1>
        Запускайте <span class="accent">Telegram-ботов премиум-уровня</span><br>
        для бизнеса, сетевого маркетинга и личного бренда
      </h1>
      <p class="hero__lead">
        Готовая платформа для продажи закрытых разделов, автозахвата аудитории и многоуровневой партнёрской программы. Без разработчиков, без SaaS-абонементов, без лимитов на ботов. Один платёж $1000 — доступ навсегда.
      </p>
      <div class="hero__cta-row">
        <a class="btn btn--primary btn--xl" href="#pricing">Получить доступ за $1000 →</a>
        <a class="btn btn--ghost btn--xl" href="#features">Посмотреть возможности</a>
      </div>
      <div class="hero__meta">
        <div><b>✓ Платные разделы</b> · продавайте контент внутри бота</div>
        <div><b>✓ Партнёрка</b> · 3–10 уровней с авто-выплатой</div>
        <div><b>✓ NOWPayments</b> · USDT, TON — принимаете и платите</div>
        <div><b>✓ Мультибот</b> · сколько угодно Telegram-ботов в одной панели</div>
      </div>
      <div class="hero__preview" aria-hidden="true">
        <div class="hero__preview-bar"><span></span><span></span><span></span></div>
        <div class="hero__preview-window">
          <div class="hero__preview-side">
            <div class="hero__preview-side-row hero__preview-side-row--active">Экземпляры ботов</div>
            <div class="hero__preview-side-row">Оплаты и доступ</div>
            <div class="hero__preview-side-row">Партнёрская программа</div>
            <div class="hero__preview-side-row">Роли и доступ</div>
            <div class="hero__preview-side-row">Аудитория</div>
          </div>
          <div class="hero__preview-main">
            <div class="hero__preview-card">💼 <b>3 бота в работе</b> · 1 247 пользователей · $18 430 за месяц</div>
            <div class="hero__preview-card">🧑‍🤝‍🧑 <b>Партнёры заработали $4 120</b> · 412 начислений по 3 уровням</div>
            <div class="hero__preview-card">💸 <b>Выплата через NOWPayments</b> · batch подтверждён · 0.42 сек</div>
            <div class="hero__preview-card">📈 <b>+23 покупателя</b> за последние 24 часа · конверсия 11%</div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="audience">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Для кого</span>
        <h2 class="section__title">Для всех, кто продаёт экспертизу, сообщество или продукт</h2>
        <p class="section__copy">Ниша не важна — важен повторяемый поток клиентов и чёткая воронка. Botzik даёт всё ядро «из коробки».</p>
      </div>
      <div class="grid grid--4 audience">
        <div class="card">
          <div class="card__icon">🏢</div>
          <h3>Бизнес и услуги</h3>
          <p>Платные консультации, закрытые чаты клиентов, подписка на материалы, записи на встречи прямо из бота.</p>
        </div>
        <div class="card">
          <div class="card__icon">🌐</div>
          <h3>Сетевой маркетинг</h3>
          <p>Готовая 3–10 уровневая партнёрская программа с авто-начислением и выплатами через NOWPayments.</p>
        </div>
        <div class="card">
          <div class="card__icon">🎙</div>
          <h3>Личный бренд</h3>
          <p>Закрытые каналы для подписчиков, платный контент по подписке, автопрогревы и drip-цепочки в мессенджере.</p>
        </div>
        <div class="card">
          <div class="card__icon">🎓</div>
          <h3>Эксперты и курсы</h3>
          <p>Продавайте доступ к модулям, автоматически выдавайте ссылки на приватные каналы после оплаты.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="features">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Возможности</span>
        <h2 class="section__title">Целая студия в одной панели</h2>
        <p class="section__copy">Никакого «соберите сами из 7 плагинов». Все нужные модули уже работают вместе, из одного бэкофиса.</p>
      </div>
      <div class="grid grid--3">
        <div class="card">
          <div class="card__icon">🧱</div>
          <h3>Конструктор меню и разделов</h3>
          <p>Собирайте многоуровневые меню, тексты, фото, видео, кнопки-ссылки. Всё через веб-интерфейс, без кода.</p>
        </div>
        <div class="card">
          <div class="card__icon">🔒</div>
          <h3>Платные разделы</h3>
          <p>Закрывайте любые меню-айтемы оплатой: разовая, подписка или пожизненный доступ. Авто-добавление в закрытые каналы.</p>
        </div>
        <div class="card">
          <div class="card__icon">💎</div>
          <h3>Многоуровневая партнёрка</h3>
          <p>3, 5, 10 уровней — любая глубина. Проценты настраиваются для каждого бота отдельно. Комиссии начисляются автоматически при покупке.</p>
        </div>
        <div class="card">
          <div class="card__icon">💳</div>
          <h3>NOWPayments USDT / TON</h3>
          <p>Приём оплат в USDT BEP20/TRC20 и TON. Выплаты партнёрам — Mass Payout с вашего кошелька. Ручная или авто-модерация.</p>
        </div>
        <div class="card">
          <div class="card__icon">📨</div>
          <h3>Рассылки и drip-цепочки</h3>
          <p>Массовые рассылки с сегментацией, авто-цепочки писем после регистрации, оплаты или тега. Шаблоны с локализацией.</p>
        </div>
        <div class="card">
          <div class="card__icon">🧑‍💼</div>
          <h3>Роли и доступ</h3>
          <p>OWNER, ADMIN, USER. Назначение ролей по @username. Несколько администраторов на один бот без раздачи токена.</p>
        </div>
        <div class="card">
          <div class="card__icon">🌍</div>
          <h3>Мультиязычность</h3>
          <p>RU / EN / DE / UK из коробки. AI-перевод через Workers AI, ручное редактирование в панели. Авто-подхват языка Telegram.</p>
        </div>
        <div class="card">
          <div class="card__icon">📊</div>
          <h3>Аналитика и CRM</h3>
          <p>Каталог пользователей с фильтрами, теги, сегменты, история платежей, экспорт в Excel. Клик-трекинг кнопок.</p>
        </div>
        <div class="card">
          <div class="card__icon">🤖</div>
          <h3>Мультибот-архитектура</h3>
          <p>Один бэкофис — любое количество ботов. Своя БД, свои настройки, свои владельцы. Шаблонирование за один клик.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="how">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Как это работает</span>
        <h2 class="section__title">От покупки до первого клиента — за один вечер</h2>
        <p class="section__copy">Никакой разработки или долгого онбординга. Готовое ядро, вам остаётся только настроить под себя.</p>
      </div>
      <div class="steps">
        <div class="step">
          <div class="step__num">01</div>
          <h3>Оплачиваете доступ</h3>
          <p>Один платёж $1000 — получаете полный backoffice, все модули и бессрочную лицензию.</p>
        </div>
        <div class="step">
          <div class="step__num">02</div>
          <h3>Подключаете своего бота</h3>
          <p>Создаёте бот через @BotFather, токен вставляете в панель. Система сама валидирует и запускает его.</p>
        </div>
        <div class="step">
          <div class="step__num">03</div>
          <h3>Собираете воронку</h3>
          <p>Меню, разделы, платный контент, партнёрские уровни, рассылки — всё через веб-панель без кода.</p>
        </div>
        <div class="step">
          <div class="step__num">04</div>
          <h3>Принимаете деньги</h3>
          <p>Покупатели платят USDT → доступ открывается автоматически → партнёры получают % мгновенно.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section pricing" id="pricing">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Тариф</span>
        <h2 class="section__title">Один платёж — лицензия навсегда</h2>
        <p class="section__copy">Никакой ежемесячной подписки. Никаких лимитов на количество ботов, пользователей или партнёров. Купили один раз — пользуетесь всегда.</p>
      </div>
      <div class="pricing__card">
        <div class="pricing__ribbon">LIFETIME</div>
        <div class="pricing__head">
          <h3>Botzik · Premium</h3>
          <span class="chip">Все модули</span>
        </div>
        <div class="pricing__price">
          <span class="amount">$1000</span>
          <span class="period">· разово · навсегда</span>
        </div>
        <p class="pricing__subnote">Полный backoffice, все функции. Обновления входят в стоимость. Поддержка и помощь в запуске первого бота.</p>
        <ul class="pricing__list">
          <li>Безлимитное количество ботов в одной панели</li>
          <li>Конструктор меню, разделов, кнопок, контента</li>
          <li>Платные разделы: разовая оплата, подписка, пожизненный доступ</li>
          <li>Многоуровневая партнёрская программа (3, 5, 10 и более уровней)</li>
          <li>NOWPayments интеграция: приём USDT/TON + авто-выплата партнёрам</li>
          <li>Рассылки, drip-цепочки, сегментация, теги</li>
          <li>Роли и многопользовательский бэкофис</li>
          <li>Мультиязычность (RU / EN / DE / UK)</li>
          <li>Аналитика, CRM, экспорт в Excel</li>
          <li>Авто-добавление и удаление из закрытых каналов</li>
          <li>Пожизненные обновления и hot-fix</li>
          <li>Персональная помощь в развёртывании первого бота</li>
        </ul>
        <a class="btn btn--primary btn--xl" href="${LANDING_CTA_TELEGRAM}" style="width:100%; justify-content:center">
          Купить сейчас за $1000 →
        </a>
        <div class="pricing__footer">Оплата USDT / карта / крипто · доступ в течение 24 часов</div>
      </div>
    </div>
  </section>

  <section class="section" id="faq">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">FAQ</span>
        <h2 class="section__title">Частые вопросы</h2>
      </div>
      <div class="faq">
        <details class="faq__item">
          <summary>Это SaaS или я получаю свою копию?</summary>
          <p>Вы получаете свою production-копию на своём сервере или на нашем хостинге (опционально). Код, база данных, токены — всё ваше. Никаких внешних SaaS-зависимостей, никто не может отключить вас «сверху».</p>
        </details>
        <details class="faq__item">
          <summary>Сколько ботов можно запустить с одной лицензии?</summary>
          <p>Неограниченное количество. Один бэкофис управляет несколькими Telegram-ботами — у каждого своя база пользователей, продукты, партнёрская программа и настройки.</p>
        </details>
        <details class="faq__item">
          <summary>Как работает партнёрская программа?</summary>
          <p>Задаёте уровни и проценты (например 20% / 10% / 5% на 3 уровня или до 10 уровней). При покупке платного раздела пригласивший партнёр получает свой процент на внутренний баланс. Когда партнёр набирает минимальную сумму — он подаёт заявку на вывод, вы одобряете (или настраиваете авто-одобрение), и деньги уходят на его кошелёк через NOWPayments Mass Payout. Списываются с вашего NOWPayments-кошелька.</p>
        </details>
        <details class="faq__item">
          <summary>Какие платежи поддерживаются?</summary>
          <p>USDT (BEP20, TRC20), TON через NOWPayments. Также поддерживается ручной режим: клиент переводит на ваш кошелёк, вы подтверждаете оплату кнопкой. Для подключения NOWPayments нужен верифицированный аккаунт с доступом к Mass Payout API.</p>
        </details>
        <details class="faq__item">
          <summary>Нужно ли что-то кодить самому?</summary>
          <p>Нет. Все настройки — через веб-интерфейс: меню, платные разделы, уровни партнёрки, рассылки, drip-цепочки. Разработчик нужен только если хотите расширить систему под уникальные сценарии.</p>
        </details>
        <details class="faq__item">
          <summary>Что входит в поддержку и обновления?</summary>
          <p>Пожизненные обновления ядра (новые функции, исправления багов), персональная помощь в запуске первого бота, приоритетные ответы по техническим вопросам в течение первых 30 дней.</p>
        </details>
        <details class="faq__item">
          <summary>Есть ли возврат?</summary>
          <p>Если в течение 14 дней после покупки вы понимаете, что продукт вам не подходит — полный возврат без вопросов. Условие: бот ещё не принял платежи через NOWPayments.</p>
        </details>
      </div>
    </div>
  </section>

  <section class="final-cta">
    <div class="container">
      <h2>Готовы запустить свою Telegram-экосистему?</h2>
      <p>Без подписки. Без лимитов. Один платёж — и вы владеете платформой для бесконечного масштабирования.</p>
      <a class="btn btn--primary btn--xl" href="${LANDING_CTA_TELEGRAM}">Купить за $1000 →</a>
    </div>
  </section>

  <footer>
    <div class="container">
      <div class="logo"><span class="logo__mark">B</span> <span>Botzik · © 2026</span></div>
      <div>
        <a href="https://admin.botzik.pp.ua/backoffice/login">Вход в backoffice</a> · <a href="${LANDING_CTA_TELEGRAM}">Связаться</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}
