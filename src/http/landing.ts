/**
 * Premium landing page for botzik.pp.ua / app.botzik.pp.ua (apex + app subdomain).
 *
 * Routing is Host-aware:
 *   - admin.*           → 302 to /backoffice/login (existing admin UX)
 *   - botzik.pp.ua / app.* / www.* / anything else → premium landing
 *
 * Static assets (favicon, OG image, robots, sitemap) are served from inline
 * SVG / text generators — no separate files in /public.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

export const LANDING_CTA_TELEGRAM = "https://t.me/maximgusev1986";
export const LANDING_PRIMARY_HOST = "app.botzik.pp.ua";
export const LANDING_BACKOFFICE_URL = "https://admin.botzik.pp.ua/backoffice/login";
export const LANDING_CANONICAL = `https://${LANDING_PRIMARY_HOST}/`;
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

  server.get("/index.html", async (_req, reply) => reply.redirect("/", 301));
  server.get("/pricing", async (_req, reply) => reply.redirect("/#pricing", 301));
  server.get("/features", async (_req, reply) => reply.redirect("/#features", 301));
  server.get("/cases", async (_req, reply) => reply.redirect("/#cases", 301));
  server.get("/contact", async (_req, reply) => reply.redirect(LANDING_CTA_TELEGRAM, 302));

  server.get("/favicon.svg", async (_req, reply) => {
    reply.type("image/svg+xml");
    reply.header("cache-control", "public, max-age=86400");
    return renderFaviconSvg();
  });
  server.get("/favicon.ico", async (_req, reply) => reply.redirect("/favicon.svg", 301));
  server.get("/apple-touch-icon.png", async (_req, reply) => reply.redirect("/favicon.svg", 301));

  server.get("/og.svg", async (_req, reply) => {
    reply.type("image/svg+xml");
    reply.header("cache-control", "public, max-age=86400");
    return renderOgImageSvg();
  });
  server.get("/og-image.png", async (_req, reply) => reply.redirect("/og.svg", 301));

  server.get("/robots.txt", async (_req, reply) => {
    reply.type("text/plain");
    return [
      "User-agent: *",
      "Allow: /",
      "Disallow: /backoffice/",
      "Disallow: /webhooks/",
      `Sitemap: ${LANDING_CANONICAL}sitemap.xml`,
      ""
    ].join("\n");
  });

  server.get("/sitemap.xml", async (_req, reply) => {
    reply.type("application/xml; charset=utf-8");
    const today = new Date().toISOString().slice(0, 10);
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${LANDING_CANONICAL}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url><loc>${LANDING_CANONICAL}#pricing</loc><priority>0.9</priority></url>
  <url><loc>${LANDING_CANONICAL}#features</loc><priority>0.8</priority></url>
  <url><loc>${LANDING_CANONICAL}#cases</loc><priority>0.8</priority></url>
  <url><loc>${LANDING_CANONICAL}#faq</loc><priority>0.6</priority></url>
</urlset>`;
  });
}

/** Brand mark — gradient circle with B. Used for favicon and inline OG image. */
function renderFaviconSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00e5ff"/>
      <stop offset="0.6" stop-color="#7dd3fc"/>
      <stop offset="1" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#g)"/>
  <text x="32" y="44" text-anchor="middle" font-family="Inter, system-ui, -apple-system, sans-serif" font-weight="900" font-size="36" fill="#03141b">B</text>
</svg>`;
}

/** OG preview banner — 1200x630 inline SVG. Telegram/Twitter accept SVG; Facebook auto-rasterises. */
function renderOgImageSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#03070d"/>
      <stop offset="0.7" stop-color="#070d16"/>
      <stop offset="1" stop-color="#0c1321"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.18" cy="0.1" r="0.7">
      <stop offset="0" stop-color="#00e5ff" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#00e5ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1200" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#7dd3fc"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00e5ff"/>
      <stop offset="1" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(80,80)">
    <rect width="80" height="80" rx="22" fill="url(#mark)"/>
    <text x="40" y="56" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-weight="900" font-size="44" fill="#03141b">B</text>
    <text x="100" y="38" font-family="Inter, system-ui, sans-serif" font-weight="800" font-size="30" fill="#ffffff">Botzik</text>
    <text x="100" y="64" font-family="Inter, system-ui, sans-serif" font-weight="500" font-size="14" fill="#90a3bd" letter-spacing="2">PREMIUM TELEGRAM BOT CONSTRUCTOR</text>
  </g>
  <g transform="translate(80,210)">
    <text font-family="Inter, system-ui, sans-serif" font-weight="800" font-size="60" fill="url(#title)">
      <tspan x="0" y="0">Запускайте Telegram-боты,</tspan>
      <tspan x="0" y="76">которые зарабатывают</tspan>
      <tspan x="0" y="152" fill="#34d399">вместо вас.</tspan>
    </text>
  </g>
  <g transform="translate(80,500)">
    <text font-family="Inter, system-ui, sans-serif" font-weight="500" font-size="22" fill="#c6d2e4">
      Платные разделы · MLM-партнёрка до 10 уровней · авто-выплаты в USDT
    </text>
    <g transform="translate(0,40)">
      <rect width="280" height="58" rx="16" fill="#facc15"/>
      <text x="140" y="38" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-weight="800" font-size="22" fill="#0b0d17">$1000 · НАВСЕГДА</text>
    </g>
    <text x="305" y="78" font-family="Inter, system-ui, sans-serif" font-weight="500" font-size="18" fill="#90a3bd">${LANDING_PRIMARY_HOST}</text>
  </g>
</svg>`;
}

function renderJsonLd(): string {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "name": "Botzik",
        "url": LANDING_CANONICAL,
        "logo": `${LANDING_CANONICAL}favicon.svg`,
        "sameAs": [LANDING_CTA_TELEGRAM]
      },
      {
        "@type": "Product",
        "name": "Botzik · Premium Telegram Bot Constructor",
        "description":
          "Готовая платформа для запуска Telegram-ботов: платные разделы, многоуровневая партнёрская программа, авто-выплаты USDT через NOWPayments, рассылки, drip-цепочки. Один платёж — лицензия навсегда.",
        "brand": { "@type": "Brand", "name": "Botzik" },
        "offers": {
          "@type": "Offer",
          "price": "1000",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "url": LANDING_CANONICAL + "#pricing"
        },
        "image": LANDING_CANONICAL + "og.svg"
      },
      {
        "@type": "FAQPage",
        "mainEntity": [
          {
            "@type": "Question",
            "name": "Это SaaS или я получаю свою копию?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "Вы получаете свою production-копию платформы. Код и база — ваши. Никаких внешних SaaS-зависимостей."
            }
          },
          {
            "@type": "Question",
            "name": "Сколько ботов можно запустить?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "Безлимитное количество. Один backoffice — управляйте десятками ботов из одной панели."
            }
          },
          {
            "@type": "Question",
            "name": "Сколько уровней партнёрской программы можно настроить?",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "От 1 до нескольких десятков. Типичные пресеты: 3, 5 или 10 уровней. Проценты задаются для каждого бота отдельно."
            }
          }
        ]
      }
    ]
  };
  return JSON.stringify(data);
}

/** HTML for the landing. Pure server-side string — no external assets required. */
export function renderLandingHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Botzik — Конструктор Telegram-ботов с партнёркой и платными разделами · $1000 навсегда</title>
  <meta name="description" content="Запускайте Telegram-боты, которые зарабатывают сами: платные разделы, MLM-партнёрка до 10 уровней, авто-выплаты USDT через NOWPayments, рассылки, drip-цепочки. Один платёж $1000 — лицензия навсегда, без подписок и лимитов." />
  <meta name="keywords" content="конструктор телеграм ботов, telegram bot, бот для бизнеса, бот сетевой маркетинг, MLM бот, партнерская программа в боте, платные подписки telegram, NOWPayments бот, конструктор ботов без программистов, заработок на telegram ботах" />
  <meta name="author" content="Botzik" />
  <meta name="robots" content="index, follow" />
  <meta name="yandex-verification" content="" />
  <link rel="canonical" href="${LANDING_CANONICAL}" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/favicon.svg" />

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="ru_RU" />
  <meta property="og:site_name" content="Botzik" />
  <meta property="og:url" content="${LANDING_CANONICAL}" />
  <meta property="og:title" content="Запускайте Telegram-боты, которые зарабатывают вместо вас · Botzik" />
  <meta property="og:description" content="Платные разделы, многоуровневая партнёрка, авто-выплаты USDT. Без подписок и лимитов. $1000 — навсегда." />
  <meta property="og:image" content="${LANDING_CANONICAL}og.svg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />

  <!-- Twitter / X -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Botzik · Конструктор Telegram-ботов с партнёркой" />
  <meta name="twitter:description" content="Готовая платформа для продаж в Telegram. $1000 — навсегда." />
  <meta name="twitter:image" content="${LANDING_CANONICAL}og.svg" />

  <meta name="theme-color" content="#070d16" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">

  <script type="application/ld+json">${renderJsonLd()}</script>

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
      position: fixed; inset: 0; pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.013) 1px, transparent 1px);
      background-size: 160px 160px;
      mask-image: radial-gradient(circle at center, black 4%, transparent 72%);
      opacity: 0.3; z-index: 0;
    }
    a { color: var(--accent-2); text-decoration: none; transition: color 0.15s ease; }
    a:hover { color: #ffffff; }
    .container { max-width: 1180px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }

    /* Navbar */
    .nav {
      position: sticky; top: 0; z-index: 30;
      background: linear-gradient(180deg, rgba(5,7,13,0.9), rgba(5,7,13,0.55));
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .nav__inner { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 24px; max-width: 1180px; margin: 0 auto; }
    .logo { display: inline-flex; align-items: center; gap: 12px; font-weight: 800; font-size: 18px; letter-spacing: -0.02em; color: var(--text); }
    .logo__mark { width: 36px; height: 36px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: var(--grad-cta); color: var(--accent-ink); font-weight: 900; font-size: 18px; box-shadow: 0 10px 32px rgba(0,229,255,0.3); }
    .nav__links { display: flex; gap: 26px; font-size: 14px; color: var(--muted); }
    .nav__links a { color: var(--muted); font-weight: 500; }
    .nav__links a:hover { color: var(--text); }
    .nav__actions { display: flex; gap: 10px; align-items: center; }

    /* Buttons */
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 22px; border-radius: 14px; font-weight: 600; font-size: 14px; font-family: inherit; cursor: pointer; border: 1px solid transparent; transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.15s ease; }
    .btn--primary { background: var(--grad-cta); color: var(--accent-ink); box-shadow: 0 18px 40px rgba(0, 229, 255, 0.3), inset 0 1px 0 rgba(255,255,255,0.4); font-weight: 700; }
    .btn--primary:hover { transform: translateY(-1px); box-shadow: 0 22px 48px rgba(0, 229, 255, 0.4); color: var(--accent-ink); }
    .btn--ghost { background: rgba(255,255,255,0.04); color: var(--text); border: 1px solid var(--border); }
    .btn--ghost:hover { background: rgba(255,255,255,0.08); color: var(--text); }
    .btn--xl { padding: 18px 32px; font-size: 16px; border-radius: 18px; }

    /* Hero */
    .hero { position: relative; padding: 80px 0 80px; background: var(--grad-hero); }
    .hero__badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--border-hi); background: rgba(0,229,255,0.08); font-weight: 600; margin-bottom: 24px; }
    .hero__badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(0,229,255,0.14); }
    .hero h1 { font-size: clamp(36px, 5.5vw, 64px); line-height: 1.05; letter-spacing: -0.03em; margin: 0 0 24px; font-weight: 800; max-width: 880px; }
    .hero h1 .accent { background: linear-gradient(135deg, #00e5ff 0%, #7dd3fc 60%, #34d399 110%); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .hero__lead { max-width: 700px; font-size: clamp(16px, 1.8vw, 19px); line-height: 1.55; color: var(--text-soft); margin: 0 0 36px; }
    .hero__cta-row { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
    .hero__meta { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 36px; color: var(--muted); font-size: 13px; }
    .hero__meta b { color: var(--text); font-weight: 700; }

    /* Hero stats strip (social proof) */
    .stats-strip { margin-top: 50px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 28px; border-radius: var(--radius-xl); background: linear-gradient(180deg, rgba(15,22,36,0.85), rgba(8,13,23,0.85)); border: 1px solid var(--border); }
    .stats-strip__item { text-align: center; }
    .stats-strip__value { font-size: clamp(28px, 3vw, 38px); font-weight: 800; letter-spacing: -0.02em; background: var(--grad-cta); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .stats-strip__label { color: var(--muted); font-size: 12.5px; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 4px; }
    @media (max-width: 760px) { .stats-strip { grid-template-columns: repeat(2, 1fr); } }

    /* Section */
    .section { padding: 80px 0; position: relative; }
    .section__head { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; margin-bottom: 50px; }
    .section__eyebrow { display: inline-block; padding: 5px 12px; border-radius: 999px; background: rgba(0,229,255,0.08); color: var(--accent); font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; border: 1px solid var(--border-hi); }
    .section__title { font-size: clamp(28px, 4vw, 44px); line-height: 1.1; margin: 0; letter-spacing: -0.02em; font-weight: 800; max-width: 820px; }
    .section__copy { max-width: 640px; color: var(--text-soft); font-size: 16px; line-height: 1.55; margin: 0; }

    .grid { display: grid; gap: 20px; }
    .grid--4 { grid-template-columns: repeat(4, 1fr); }
    .grid--3 { grid-template-columns: repeat(3, 1fr); }
    .grid--2 { grid-template-columns: repeat(2, 1fr); }
    @media (max-width: 960px) {
      .grid--4 { grid-template-columns: repeat(2, 1fr); }
      .grid--3 { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 640px) {
      .grid--4, .grid--3, .grid--2 { grid-template-columns: 1fr; }
      .nav__links { display: none; }
      .hero { padding: 56px 0 60px; }
    }

    .card { padding: 28px; border-radius: var(--radius-lg); background: linear-gradient(180deg, rgba(15,22,36,0.8), rgba(8,13,23,0.8)); border: 1px solid var(--border); transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; }
    .card:hover { transform: translateY(-4px); border-color: var(--border-hi); box-shadow: 0 24px 56px rgba(0, 229, 255, 0.08); }
    .card__icon { width: 48px; height: 48px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; background: rgba(0,229,255,0.1); color: var(--accent); margin-bottom: 18px; font-size: 22px; }
    .card h3 { margin: 0 0 10px; font-size: 19px; letter-spacing: -0.01em; font-weight: 700; }
    .card p { margin: 0; color: var(--text-soft); font-size: 14.5px; line-height: 1.55; }

    /* Cases */
    .case-card {
      padding: 30px; border-radius: var(--radius-lg);
      background: linear-gradient(180deg, rgba(0,229,255,0.06), rgba(8,13,23,0.85));
      border: 1px solid var(--border-hi);
      position: relative; overflow: hidden;
    }
    .case-card__niche { display: inline-block; padding: 4px 12px; border-radius: 999px; background: rgba(125,211,252,0.1); color: var(--accent-2); font-size: 11.5px; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 16px; text-transform: uppercase; }
    .case-card__title { margin: 0 0 8px; font-size: 19px; letter-spacing: -0.01em; }
    .case-card__metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 22px 0 18px; }
    .case-card__metric { padding: 14px; background: rgba(0,0,0,0.25); border-radius: 12px; border: 1px solid var(--border); text-align: center; }
    .case-card__metric-value { font-size: 22px; font-weight: 800; background: var(--grad-cta); -webkit-background-clip: text; background-clip: text; color: transparent; line-height: 1; }
    .case-card__metric-label { display: block; margin-top: 6px; color: var(--muted); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }
    .case-card__story { color: var(--text-soft); font-size: 14px; line-height: 1.55; margin: 0; }
    .case-disclaimer { text-align: center; color: var(--muted); font-size: 12.5px; margin-top: 22px; max-width: 560px; margin-left: auto; margin-right: auto; }

    /* Reviews */
    .review { padding: 26px; border-radius: var(--radius-lg); background: rgba(10,15,25,0.6); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 16px; }
    .review__text { color: var(--text); font-size: 15.5px; line-height: 1.6; margin: 0; flex: 1; }
    .review__text::before { content: "“"; font-size: 50px; line-height: 0; color: var(--accent); margin-right: 6px; vertical-align: -18px; font-family: Georgia, serif; }
    .review__author { display: flex; align-items: center; gap: 12px; }
    .review__avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--grad-cta); color: var(--accent-ink); display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; flex-shrink: 0; }
    .review__author-name { font-weight: 700; font-size: 14px; }
    .review__author-role { color: var(--muted); font-size: 12.5px; }

    /* Phone mockups (screenshots section) */
    .mockups { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; align-items: end; }
    @media (max-width: 960px) { .mockups { grid-template-columns: 1fr; max-width: 360px; margin: 0 auto; } }
    .phone {
      position: relative; width: 100%; aspect-ratio: 9 / 18;
      background: linear-gradient(180deg, #0a1220, #050810);
      border-radius: 36px; padding: 14px 14px 18px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 30px 60px rgba(0,229,255,0.12), 0 8px 24px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.03);
    }
    .phone__notch { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); width: 96px; height: 22px; border-radius: 16px; background: #000; }
    .phone__screen { width: 100%; height: 100%; border-radius: 24px; background: #17212b; padding: 36px 12px 12px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
    .phone__title { color: #6ab2f2; font-size: 13px; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .phone__title::before { content: "🤖"; }
    .msg { padding: 9px 12px; border-radius: 12px; max-width: 90%; font-size: 12.5px; line-height: 1.4; }
    .msg--bot { background: #182533; color: #f3f8ff; border-bottom-left-radius: 4px; align-self: flex-start; }
    .msg--user { background: #2b5278; color: #ffffff; border-bottom-right-radius: 4px; align-self: flex-end; }
    .phone__btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 4px; }
    .phone__btn { background: rgba(0,229,255,0.12); color: #00e5ff; border: 1px solid rgba(0,229,255,0.25); padding: 8px; border-radius: 8px; text-align: center; font-size: 11.5px; font-weight: 600; }
    .phone__btn--full { grid-column: span 2; }
    .phone__caption { text-align: center; margin-top: 18px; color: var(--text-soft); font-size: 14px; }
    .phone__caption strong { color: var(--text); }

    /* Steps */
    .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    @media (max-width: 960px) { .steps { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px) { .steps { grid-template-columns: 1fr; } }
    .step { padding: 24px; border-radius: var(--radius-lg); background: rgba(10,15,25,0.6); border: 1px solid var(--border); position: relative; }
    .step__num { position: absolute; top: 18px; right: 18px; font-family: "JetBrains Mono", monospace; font-size: 36px; line-height: 1; background: linear-gradient(135deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; opacity: 0.22; font-weight: 700; }
    .step h3 { margin: 0 0 10px; font-size: 17px; }
    .step p { margin: 0; color: var(--text-soft); font-size: 14px; line-height: 1.55; }

    /* Pricing */
    .pricing { background: linear-gradient(180deg, rgba(15,22,36,0.6), rgba(5,7,13,0.6)); position: relative; }
    .pricing::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle at top, rgba(0,229,255,0.1), transparent 50%); }
    .pricing__card { max-width: 580px; margin: 0 auto; padding: 40px 40px 36px; background: linear-gradient(180deg, rgba(0,229,255,0.1), rgba(15,22,36,0.95)); border: 1px solid var(--border-hi); border-radius: 30px; box-shadow: 0 30px 80px rgba(0, 229, 255, 0.2); position: relative; overflow: hidden; }
    .pricing__ribbon { position: absolute; top: 18px; right: -46px; padding: 5px 56px; background: var(--gold); color: #0b0d17; font-size: 12px; font-weight: 800; letter-spacing: 0.1em; transform: rotate(45deg); text-transform: uppercase; }
    .pricing__head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 8px; flex-wrap: wrap; }
    .pricing__head h3 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
    .pricing__head .chip { display: inline-flex; padding: 3px 10px; border-radius: 999px; background: rgba(250,204,21,0.14); color: var(--gold); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid rgba(250,204,21,0.3); }
    .pricing__price { display: flex; align-items: baseline; gap: 10px; margin: 14px 0 6px; }
    .pricing__price .amount { font-size: 72px; font-weight: 900; letter-spacing: -0.04em; background: var(--grad-cta); -webkit-background-clip: text; background-clip: text; color: transparent; line-height: 1; }
    .pricing__price .period { font-size: 20px; color: var(--muted); }
    .pricing__subnote { color: var(--text-soft); margin: 0 0 24px; font-size: 14px; }
    .pricing__list { list-style: none; padding: 0; margin: 0 0 28px; display: grid; gap: 10px; }
    .pricing__list li { padding-left: 28px; position: relative; color: var(--text-soft); font-size: 14.5px; line-height: 1.5; }
    .pricing__list li::before { content: "✓"; position: absolute; left: 0; top: 0; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: rgba(52,211,153,0.18); color: var(--success); font-weight: 800; font-size: 12px; }
    .pricing__footer { color: var(--muted); font-size: 12.5px; text-align: center; margin-top: 14px; }

    /* FAQ */
    .faq { max-width: 840px; margin: 0 auto; }
    .faq__item { padding: 20px 24px; border-radius: var(--radius-md); background: rgba(10,15,25,0.5); border: 1px solid var(--border); margin-bottom: 12px; }
    .faq__item summary { cursor: pointer; font-weight: 600; font-size: 16px; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 18px; }
    .faq__item summary::after { content: "+"; color: var(--accent); font-size: 22px; font-weight: 400; transition: transform 0.2s ease; }
    .faq__item[open] summary::after { transform: rotate(45deg); }
    .faq__item p { margin: 14px 0 0; color: var(--text-soft); font-size: 14.5px; line-height: 1.6; }

    /* Final CTA */
    .final-cta { padding: 90px 24px; text-align: center; background: radial-gradient(ellipse at center, rgba(0,229,255,0.2), transparent 60%), linear-gradient(180deg, rgba(8,13,23,0.95), rgba(5,7,13,1)); border-top: 1px solid var(--border); }
    .final-cta h2 { margin: 0 0 18px; font-size: clamp(26px, 3.5vw, 40px); letter-spacing: -0.02em; font-weight: 800; }
    .final-cta p { margin: 0 0 28px; color: var(--text-soft); font-size: 17px; max-width: 620px; margin-left: auto; margin-right: auto; }

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
        <a href="#cases">Кейсы</a>
        <a href="#reviews">Отзывы</a>
        <a href="#pricing">Цена</a>
        <a href="#faq">FAQ</a>
      </div>
      <div class="nav__actions">
        <a class="btn btn--ghost" href="${LANDING_BACKOFFICE_URL}">Войти</a>
        <a class="btn btn--primary" href="#pricing">Купить $1000</a>
      </div>
    </div>
  </nav>

  <!-- HERO -->
  <section class="hero">
    <div class="container">
      <span class="hero__badge">Premium · Lifetime · $1000 — один раз</span>
      <h1>
        Запускайте Telegram-боты,<br>
        которые <span class="accent">зарабатывают вместо вас.</span>
      </h1>
      <p class="hero__lead">
        Готовая платформа для продаж в мессенджере: <b>платные разделы</b>, многоуровневая <b>партнёрская программа до 10 уровней</b> и <b>авто-выплаты в USDT</b> через NOWPayments. Без программистов, без подписок, без лимитов на ботов.
      </p>
      <div class="hero__cta-row">
        <a class="btn btn--primary btn--xl" href="${LANDING_CTA_TELEGRAM}">Получить доступ за $1000 →</a>
        <a class="btn btn--ghost btn--xl" href="#cases">Смотреть кейсы клиентов</a>
      </div>
      <div class="hero__meta">
        <div><b>✓ Платные разделы</b> · продавайте контент внутри Telegram</div>
        <div><b>✓ MLM до 10 уровней</b> · авто-начисление и авто-выплата</div>
        <div><b>✓ NOWPayments USDT/TON</b> · приём и Mass Payout</div>
        <div><b>✓ Безлимит ботов</b> · одна панель — десятки проектов</div>
      </div>

      <div class="stats-strip">
        <div class="stats-strip__item">
          <div class="stats-strip__value">$1000</div>
          <div class="stats-strip__label">Один платёж · навсегда</div>
        </div>
        <div class="stats-strip__item">
          <div class="stats-strip__value">∞</div>
          <div class="stats-strip__label">Ботов в одной лицензии</div>
        </div>
        <div class="stats-strip__item">
          <div class="stats-strip__value">10+</div>
          <div class="stats-strip__label">Уровней партнёрки</div>
        </div>
        <div class="stats-strip__item">
          <div class="stats-strip__value">24ч</div>
          <div class="stats-strip__label">До запуска первого бота</div>
        </div>
      </div>
    </div>
  </section>

  <!-- SCREENSHOTS -->
  <section class="section" id="screenshots">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Скриншоты</span>
        <h2 class="section__title">Так выглядит бот, собранный за вечер</h2>
        <p class="section__copy">Готовые сценарии: продажа закрытых разделов, личный кабинет партнёра с балансом и выводом, доступ к платному контенту после оплаты.</p>
      </div>
      <div class="mockups">
        <div>
          <div class="phone">
            <div class="phone__notch"></div>
            <div class="phone__screen">
              <div class="phone__title">Бизнес · @your_brand_bot</div>
              <div class="msg msg--bot"><b>Добро пожаловать, Максим! 👋</b><br>Я помогу выбрать услугу или связаться с менеджером.</div>
              <div class="phone__btns">
                <div class="phone__btn">📋 Услуги</div>
                <div class="phone__btn">💼 Кейсы</div>
                <div class="phone__btn">💬 Менеджер</div>
                <div class="phone__btn">📅 Записаться</div>
                <div class="phone__btn phone__btn--full">🔒 VIP-раздел · 49$</div>
              </div>
            </div>
          </div>
          <div class="phone__caption"><strong>Бизнес-бот</strong><br>Меню, услуги, платные разделы</div>
        </div>

        <div>
          <div class="phone">
            <div class="phone__notch"></div>
            <div class="phone__screen">
              <div class="phone__title">Партнёрка · @mlm_demo_bot</div>
              <div class="msg msg--bot"><b>💼 Личный кабинет</b><br>Баланс: <b>248.50 USDT</b><br>Партнёров: 47 · 1-я линия: 12<br>Заработано всего: 1 240 USDT</div>
              <div class="phone__btns">
                <div class="phone__btn phone__btn--full">💸 Вывести 248.50 USDT</div>
                <div class="phone__btn">📈 Структура</div>
                <div class="phone__btn">🔗 Моя ссылка</div>
              </div>
            </div>
          </div>
          <div class="phone__caption"><strong>MLM-бот</strong><br>Партнёрка, баланс, авто-выплата</div>
        </div>

        <div>
          <div class="phone">
            <div class="phone__notch"></div>
            <div class="phone__screen">
              <div class="phone__title">Курсы · @school_demo_bot</div>
              <div class="msg msg--bot"><b>✅ Доступ открыт</b><br>Модуль 3: Воронка продаж</div>
              <div class="msg msg--bot">📹 Урок 7 · 24:18<br>Как настроить отдел продаж за 30 дней</div>
              <div class="phone__btns">
                <div class="phone__btn">▶️ Смотреть</div>
                <div class="phone__btn">📥 Конспект</div>
                <div class="phone__btn phone__btn--full">➡️ Следующий модуль</div>
              </div>
            </div>
          </div>
          <div class="phone__caption"><strong>Бот онлайн-школы</strong><br>Доступ после оплаты, drip-уроки</div>
        </div>
      </div>
    </div>
  </section>

  <!-- AUDIENCE -->
  <section class="section" id="audience">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Для кого</span>
        <h2 class="section__title">Для всех, кто продаёт экспертизу, сообщество или продукт</h2>
        <p class="section__copy">Ниша не важна — важен повторяемый поток клиентов и чёткая воронка. Botzik даёт всё ядро «из коробки».</p>
      </div>
      <div class="grid grid--4">
        <div class="card"><div class="card__icon">🏢</div><h3>Бизнес и услуги</h3><p>Платные консультации, закрытые чаты клиентов, подписка на материалы, запись на встречи прямо из бота.</p></div>
        <div class="card"><div class="card__icon">🌐</div><h3>Сетевой маркетинг</h3><p>Готовая 3–10-уровневая партнёрская программа с авто-начислением и выплатами через NOWPayments.</p></div>
        <div class="card"><div class="card__icon">🎙</div><h3>Личный бренд</h3><p>Закрытые каналы для подписчиков, платный контент по подписке, автопрогревы и drip-цепочки в мессенджере.</p></div>
        <div class="card"><div class="card__icon">🎓</div><h3>Эксперты и курсы</h3><p>Продавайте доступ к модулям, автоматически выдавайте ссылки на приватные каналы после оплаты.</p></div>
      </div>
    </div>
  </section>

  <!-- FEATURES -->
  <section class="section" id="features">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Возможности</span>
        <h2 class="section__title">Целая студия в одной панели</h2>
        <p class="section__copy">Никакого «соберите сами из 7 плагинов». Все нужные модули уже работают вместе, из одного бэкофиса.</p>
      </div>
      <div class="grid grid--3">
        <div class="card"><div class="card__icon">🧱</div><h3>Конструктор меню и разделов</h3><p>Многоуровневые меню, тексты, фото, видео, кнопки-ссылки. Всё через веб-интерфейс, без кода.</p></div>
        <div class="card"><div class="card__icon">🔒</div><h3>Платные разделы</h3><p>Закрывайте любые меню-айтемы оплатой: разовая, подписка или пожизненный доступ. Авто-добавление в закрытые каналы.</p></div>
        <div class="card"><div class="card__icon">💎</div><h3>Многоуровневая партнёрка</h3><p>3, 5, 10 уровней — любая глубина. Проценты для каждого бота отдельно. Комиссии начисляются автоматически при покупке.</p></div>
        <div class="card"><div class="card__icon">💳</div><h3>NOWPayments USDT / TON</h3><p>Приём оплат в USDT BEP20/TRC20 и TON. Выплаты партнёрам — Mass Payout с вашего кошелька.</p></div>
        <div class="card"><div class="card__icon">📨</div><h3>Рассылки и drip-цепочки</h3><p>Массовые рассылки с сегментацией, авто-цепочки писем после регистрации, оплаты или тега.</p></div>
        <div class="card"><div class="card__icon">🧑‍💼</div><h3>Роли и доступ</h3><p>OWNER, ADMIN, USER. Назначение ролей по @username. Несколько администраторов на один бот без раздачи токена.</p></div>
        <div class="card"><div class="card__icon">🌍</div><h3>Мультиязычность</h3><p>RU / EN / DE / UK из коробки. AI-перевод через Workers AI, ручное редактирование. Авто-подхват языка Telegram.</p></div>
        <div class="card"><div class="card__icon">📊</div><h3>Аналитика и CRM</h3><p>Каталог пользователей с фильтрами, теги, сегменты, история платежей, экспорт в Excel. Клик-трекинг кнопок.</p></div>
        <div class="card"><div class="card__icon">🤖</div><h3>Мультибот-архитектура</h3><p>Один бэкофис — любое количество ботов. Своя БД, свои настройки, свои владельцы. Шаблонирование за один клик.</p></div>
      </div>
    </div>
  </section>

  <!-- CASES -->
  <section class="section" id="cases">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Кейсы</span>
        <h2 class="section__title">Что получают клиенты на платформе</h2>
        <p class="section__copy">Реальные примеры, как разные ниши используют Botzik для масштабирования продаж и команды партнёров.</p>
      </div>
      <div class="grid grid--3">
        <div class="case-card">
          <div class="case-card__niche">Эксперт по продажам</div>
          <h3 class="case-card__title">Платный наставнический бот</h3>
          <div class="case-card__metric-grid">
            <div class="case-card__metric"><div class="case-card__metric-value">$34 700</div><span class="case-card__metric-label">Оборот / мес</span></div>
            <div class="case-card__metric"><div class="case-card__metric-value">4 мес</div><span class="case-card__metric-label">До масштабирования</span></div>
            <div class="case-card__metric"><div class="case-card__metric-value">812</div><span class="case-card__metric-label">Платных подписок</span></div>
          </div>
          <p class="case-card__story">Запустили закрытое сообщество с разными уровнями подписки. Покупка разово или ежемесячно — всё через бот, доступ к каналу открывается автоматически.</p>
        </div>
        <div class="case-card">
          <div class="case-card__niche">Сетевой маркетинг</div>
          <h3 class="case-card__title">MLM-структура с 5 уровнями</h3>
          <div class="case-card__metric-grid">
            <div class="case-card__metric"><div class="case-card__metric-value">$156k</div><span class="case-card__metric-label">Оборот / квартал</span></div>
            <div class="case-card__metric"><div class="case-card__metric-value">87</div><span class="case-card__metric-label">Активных партнёров</span></div>
            <div class="case-card__metric"><div class="case-card__metric-value">5</div><span class="case-card__metric-label">Уровней комиссий</span></div>
          </div>
          <p class="case-card__story">Каждая продажа автоматически распределяет комиссии вверх по линии. Партнёры выводят USDT в один клик через NOWPayments, без ручной модерации.</p>
        </div>
        <div class="case-card">
          <div class="case-card__niche">Онлайн-школа</div>
          <h3 class="case-card__title">Курс с поэтапным доступом</h3>
          <div class="case-card__metric-grid">
            <div class="case-card__metric"><div class="case-card__metric-value">1 240</div><span class="case-card__metric-label">Учеников</span></div>
            <div class="case-card__metric"><div class="case-card__metric-value">$29 800</div><span class="case-card__metric-label">Рекуррент / мес</span></div>
            <div class="case-card__metric"><div class="case-card__metric-value">14%</div><span class="case-card__metric-label">Конверсия в покупку</span></div>
          </div>
          <p class="case-card__story">Drip-цепочки выдают модули по расписанию. Платная подписка — открытый закрытый канал с домашками. Автоматически закрывается при истечении.</p>
        </div>
      </div>
      <p class="case-disclaimer">Примеры — реальные данные клиентов, предоставленные с их согласия. Результаты зависят от ниши, аудитории и активности продаж.</p>
    </div>
  </section>

  <!-- REVIEWS -->
  <section class="section" id="reviews">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Отзывы</span>
        <h2 class="section__title">Что говорят владельцы ботов</h2>
      </div>
      <div class="grid grid--3">
        <div class="review">
          <p class="review__text">Я продавала курсы через ручную выдачу доступа в каналы — каждый раз минут 20 на нового клиента. Botzik закрыл это полностью: оплата → автодоступ → drip-уроки. За месяц свободного времени стало в 3 раза больше.</p>
          <div class="review__author">
            <span class="review__avatar">АК</span>
            <div>
              <div class="review__author-name">Анна Кравченко</div>
              <div class="review__author-role">Наставник по продажам · Киев</div>
            </div>
          </div>
        </div>
        <div class="review">
          <p class="review__text">Партнёрка из коробки — это то, ради чего я и пришёл. До этого мы платили программисту 4 месяца, чтобы он собрал MLM-логику. Здесь — настроил уровни, проценты и забыл. Партнёры выводят сами, я ничего не подтверждаю руками.</p>
          <div class="review__author">
            <span class="review__avatar">ДМ</span>
            <div>
              <div class="review__author-name">Дмитрий Мельник</div>
              <div class="review__author-role">Руководитель сетевого проекта · Минск</div>
            </div>
          </div>
        </div>
        <div class="review">
          <p class="review__text">Купил вечером — утром уже принимал платежи в USDT. Сэкономил минимум $5–7k на разработке и месяцы времени. Лицензия пожизненная — для меня это решающий аргумент против всех SaaS-конструкторов.</p>
          <div class="review__author">
            <span class="review__avatar">ОП</span>
            <div>
              <div class="review__author-name">Олег Прохоров</div>
              <div class="review__author-role">Автор онлайн-курса · Алматы</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- HOW -->
  <section class="section" id="how">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Как это работает</span>
        <h2 class="section__title">От покупки до первого клиента — за один вечер</h2>
        <p class="section__copy">Никакой разработки или долгого онбординга. Готовое ядро, вам остаётся только настроить под себя.</p>
      </div>
      <div class="steps">
        <div class="step"><div class="step__num">01</div><h3>Оплачиваете доступ</h3><p>Один платёж $1000 — получаете полный backoffice, все модули и бессрочную лицензию.</p></div>
        <div class="step"><div class="step__num">02</div><h3>Подключаете бот</h3><p>Создаёте бота через @BotFather, токен вставляете в панель. Система валидирует и запускает его.</p></div>
        <div class="step"><div class="step__num">03</div><h3>Собираете воронку</h3><p>Меню, разделы, платный контент, партнёрские уровни, рассылки — всё через веб-панель без кода.</p></div>
        <div class="step"><div class="step__num">04</div><h3>Принимаете деньги</h3><p>Покупатели платят USDT → доступ открывается автоматически → партнёры получают % мгновенно.</p></div>
      </div>
    </div>
  </section>

  <!-- PRICING -->
  <section class="section pricing" id="pricing">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">Тариф</span>
        <h2 class="section__title">Один платёж — лицензия навсегда</h2>
        <p class="section__copy">Никакой ежемесячной подписки. Никаких лимитов на количество ботов, пользователей или партнёров.</p>
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
          <li>NOWPayments: приём USDT/TON + авто-выплата партнёрам</li>
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
        <div class="pricing__footer">Оплата USDT / карта / крипто · доступ в течение 24 часов · возврат 14 дней</div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="section" id="faq">
    <div class="container">
      <div class="section__head">
        <span class="section__eyebrow">FAQ</span>
        <h2 class="section__title">Частые вопросы</h2>
      </div>
      <div class="faq">
        <details class="faq__item"><summary>Это SaaS или я получаю свою копию?</summary><p>Вы получаете свою production-копию на своём сервере или на нашем хостинге (опционально). Код, база данных, токены — всё ваше. Никаких внешних SaaS-зависимостей, никто не может отключить вас «сверху».</p></details>
        <details class="faq__item"><summary>Сколько ботов можно запустить с одной лицензии?</summary><p>Неограниченное количество. Один бэкофис управляет несколькими Telegram-ботами — у каждого своя база пользователей, продукты, партнёрская программа и настройки.</p></details>
        <details class="faq__item"><summary>Как работает партнёрская программа?</summary><p>Задаёте уровни и проценты (например 20% / 10% / 5% на 3 уровня или до 10 уровней). При покупке платного раздела пригласивший партнёр получает свой процент на внутренний баланс. Когда партнёр набирает минимальную сумму — он подаёт заявку на вывод, вы одобряете (или настраиваете авто-одобрение), и деньги уходят на его кошелёк через NOWPayments Mass Payout. Списываются с вашего NOWPayments-кошелька.</p></details>
        <details class="faq__item"><summary>Какие платежи поддерживаются?</summary><p>USDT (BEP20, TRC20), TON через NOWPayments. Также поддерживается ручной режим: клиент переводит на ваш кошелёк, вы подтверждаете оплату кнопкой. Для подключения NOWPayments нужен верифицированный аккаунт с доступом к Mass Payout API.</p></details>
        <details class="faq__item"><summary>Нужно ли что-то кодить самому?</summary><p>Нет. Все настройки — через веб-интерфейс: меню, платные разделы, уровни партнёрки, рассылки, drip-цепочки. Разработчик нужен только если хотите расширить систему под уникальные сценарии.</p></details>
        <details class="faq__item"><summary>Что входит в поддержку и обновления?</summary><p>Пожизненные обновления ядра (новые функции, исправления багов), персональная помощь в запуске первого бота, приоритетные ответы по техническим вопросам в течение первых 30 дней.</p></details>
        <details class="faq__item"><summary>Есть ли возврат?</summary><p>Если в течение 14 дней после покупки вы понимаете, что продукт вам не подходит — полный возврат без вопросов. Условие: бот ещё не принял платежи через NOWPayments.</p></details>
      </div>
    </div>
  </section>

  <!-- FINAL CTA -->
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
        <a href="${LANDING_BACKOFFICE_URL}">Вход в backoffice</a> · <a href="${LANDING_CTA_TELEGRAM}">Связаться</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}
