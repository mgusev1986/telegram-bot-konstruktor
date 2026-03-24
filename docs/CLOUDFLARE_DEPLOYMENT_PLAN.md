# Cloudflare Deployment Plan (v1)

## Цель

Стабильный deployment flow с двумя AI-провайдерами:

- local/dev: `ollama`
- production: `workers_ai` (Cloudflare Workers AI)

## Что Cloudflare-friendly

- **Workers AI**: production AI-перевод через Cloudflare API.
- **Web/admin static assets**: можно хостить на Cloudflare Pages (если фронт отделён в сборку).
- **Edge-прокси/API gateway слой**: можно вынести в Cloudflare Worker как reverse proxy для части HTTP-трафика.

## Что не является нативно Cloudflare-only в текущей архитектуре

- **Telegram bot runtime (Telegraf long polling/webhook runtime)**: в текущем виде запускается как Node.js процесс.
- **BullMQ workers + scheduler**: требуют совместимого Redis и фонового worker runtime.
- **Prisma + PostgreSQL**: остаются во внешней managed БД/сервере.
- **Redis/BullMQ queue runtime**: остаётся во внешнем Redis (например, Upstash/Redis Cloud/VM).

## Рекомендуемый deployment split v1

- **Cloudflare**:
  - Workers AI как AI-провайдер (`AI_TRANSLATION_PROVIDER=workers_ai`);
  - опционально Pages для web/admin UI;
  - опционально Worker как edge ingress.
- **Отдельный Node.js runtime (VM/Container/Fly/Render/etc.)**:
  - `src/index.ts` (бот + API + job workers runtime);
  - BullMQ workers/scheduler.
- **Managed data services**:
  - PostgreSQL для Prisma;
  - Redis для BullMQ и runtime-cache.

## Почему split именно такой

- Ollama не может быть `localhost` в Cloudflare production.
- Workers AI закрывает AI-часть на Cloudflare без изменений бизнес-логики бота.
- Основной runtime проекта зависит от долгоживущих background workers и Redis/BullMQ.

## Минимальные production env для Workers AI

- `AI_TRANSLATION_PROVIDER=workers_ai`
- `CLOUDFLARE_ACCOUNT_ID=...`
- `CLOUDFLARE_AI_API_TOKEN=...`
- `CLOUDFLARE_AI_MODEL=...`

Локальные Ollama-переменные в production не требуются.
