# Telegram Bot Konstruktor

Production-like MVP of a Telegram constructor for MLM presentation bots built on:

- Node.js + TypeScript
- Telegraf
- PostgreSQL + Prisma
- Redis + BullMQ
- ExcelJS
- Zod + dotenv
- Pino

## What is implemented in MVP

- Single system Telegram bot with owner/admin/user roles
- Dynamic presentation template stored in PostgreSQL
- Menu constructor inside Telegram with wizard flow
- Multilanguage interface and content fallback
- Referral deep links with MLM tree binding and first-line notifications
- Personal cabinet with referral link, stats, language and mentor access
- Mentor link logic with username fallback and request flow
- Immediate broadcasts, scheduled broadcasts and registration-based drip campaigns
- Crypto paywall foundation with payment requests, webhook/manual confirmation and access rights
- Rule-based content access foundation
- CRM primitives: tags, notes, statuses
- Analytics foundation: menu click tracking and content progress
- A/B testing foundation for welcome/menu/offer entities
- Excel export for owner/admin/user scope
- Single-screen navigation engine:
  previous content message is deleted before the next screen is sent

## Project structure

```text
prisma/
  schema.prisma
  seed.ts
  migrations/
src/
  app/
  bot/
  common/
  config/
  http/
  infrastructure/
  modules/
```

## Environment

Copy [.env.example](/Users/maksimgusev/Desktop/Автоматизация/Telegram Bot - Konstruktor/.env.example) to `.env` and fill in:

- `BOT_TOKEN`
- `DATABASE_URL`
- `REDIS_URL`
- `SUPER_ADMIN_TELEGRAM_ID`
- `BOT_USERNAME`
- `DEFAULT_LANGUAGE`
- `REQUIRE_REFERRAL_LINK_FOR_NEW_USERS` (default `true`): new Telegram users must open the bot via `https://t.me/<bot>?start=<telegramUserId>`. Set to `false` for open registration (e.g. local dev). Exceptions: `SUPER_ADMIN_TELEGRAM_ID`, and users with a **PENDING** bot role assignment matching their Telegram @username (back-office owner invite).
- `APP_TIMEZONE`
- `PAYMENT_PROVIDER_MODE`
- `USDT_TRC20_WALLET`
- `USDT_BEP20_WALLET`

The app validates env on startup and exits with a clear error if any required variables are missing.

## Локальный перевод без Gemini (Ollama)

Чтобы перевод работал без внешней квоты:
1. Поднимите Ollama: `docker compose up -d ollama`
2. Загрузите модель в Ollama (пример): `ollama pull qwen2.5:14b`
3. В `.env` установите:
   - `AI_TRANSLATION_PROVIDER=ollama`
   - `AI_TRANSLATION_MODEL=<ollama_model_tag>` (например `qwen2.5:14b` или другой, который у вас есть)
   - `OLLAMA_BASE_URL=http://localhost:11434` (по умолчанию уже так)

## Local run

1. Install dependencies:

```bash
npm install
```

2. Start infrastructure:

```bash
docker compose up -d postgres redis
```

3. Apply migrations and generate Prisma client:

```bash
npm run prisma:migrate
npm run prisma:generate
```

4. Seed basic tags and badges:

```bash
npm run prisma:seed
```

5. Start the app:

```bash
npm run dev
```

## Docker run

```bash
docker compose up --build
```

## Main Telegram commands

### User

- `/start`
- `Мой кабинет`
- `Связь с наставником`
- `Выбрать язык`
- `Поделиться контактом`

### Admin / Owner

- `/admin`
- `/grant_admin 123456789`
- `/grant_admin @username`
- `/revoke_admin 123456789`
- `/create_menu_item`
- `/set_welcome ru Ваш текст`
- `/preview_menu`
- `/publish`
- `/create_broadcast`
- `/create_scheduled_broadcast`
- `/create_drip_campaign`
- `/export_users`
- `/confirm_payment <payment_id>`

## Notes on UX navigation

The bot uses a single-screen content engine implemented in
[navigation.service.ts](/Users/maksimgusev/Desktop/Автоматизация/Telegram Bot - Konstruktor/src/modules/navigation/navigation.service.ts):

- it stores `last_content_message_id`
- deletes the previous content message before sending the next screen
- falls back gracefully if Telegram refuses deletion
- prevents chat clutter during menu navigation

## Verification done

- Prisma client generated successfully
- TypeScript typecheck passed
- Production build passed

## V2 directions

- Full admin panel on web
- Rich translation management UI
- Event-based automation engine
- Payment provider adapters with real blockchain callbacks
- Real template cloning/import-export
- Leaderboards, gamification and advanced funnels
- Better segment builder UI
- Real A/B dashboards and conversion attribution
