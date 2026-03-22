# Деплой и валидация после техдиагностики

## Краткий список исправлений

1. **Callback data > 64 символов** — `page_edit:rem_del` и `page_edit:set_link` передавали два UUID; приведено к одному UUID или коротким id (12 символов).
2. **P2002 при создании default bot** — переход на `upsert` по `telegramBotTokenHash` + fallback retry при race condition.
3. **Health endpoint** — добавлен `GET /health` и редирект `GET /` → `/health`.
4. **Логи старта** — логи "HTTP server started", "health route enabled", "Starting bot X/Y...", "Bot started successfully/failed".
5. **ENV: local vs prod** — в `.env.example` добавлена документация: `postgres` для Docker, `localhost` для локального запуска.
6. **prisma:migrate:local** — скрипт для миграций с хоста (когда postgres в docker с портом 5432).

## Изменённые файлы

- `src/http/server.ts` — GET /, GET /health, логи
- `src/common/callback-data.ts` — `toShortId`, `CALLBACK_DATA_MAX_LENGTH`
- `src/modules/menu/menu.service.ts` — `findMenuItemByIdOrShort`
- `src/bot/register-bot.ts` — rem_del (только ruleId), set_link (short ids), import toShortId
- `src/index.ts` — bootstrap upsert, логи "Starting bot X/Y"
- `.env.example` — комментарии DATABASE_URL / REDIS_URL
- `package.json` — скрипт `prisma:migrate:local`

## Команды для деплоя

```bash
# Полный деплой (git push + обновление на сервере)
./scripts/deploy-hetzner.sh "Deploy: fixes"

# Или вручную на сервере
cd /opt/telegram-bot-konstruktor
docker compose -f docker-compose.prod.yml up -d postgres redis
docker compose -f docker-compose.prod.yml run --rm bot npx prisma migrate deploy
docker compose -f docker-compose.prod.yml up -d --force-recreate bot
```

## Локальная разработка (миграции с хоста)

```bash
# Postgres и Redis должны быть запущены (например: docker compose up -d postgres redis)
npm run prisma:migrate:local   # использует localhost:5432
# или в .env: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/...
npm run prisma:dev
```

## Чеклист ручной валидации после деплоя

- [ ] `curl http://localhost:3000/health` (на сервере) → `{"ok":true,"timestamp":"..."}`
- [ ] `curl http://localhost:3000/` → редирект 302 на `/health`
- [ ] Логи: "HTTP server started", "health route enabled", "Starting bot X/Y...", "Bot started successfully"
- [ ] Бот отвечает в Telegram на /start
- [ ] Админка (backoffice) открывается
- [ ] Напоминания: создание/удаление правил (callback rem_del) работает
- [ ] Кнопки раздела (set_link) — выбор целевого раздела работает
- [ ] Повторный перезапуск бота не даёт P2002

## Важно

- Деструктивных операций с БД не выполнялось.
- Обратная совместимость: старые callback с двумя UUID (rem_del) продолжают обрабатываться.
- Short id (12 символов) для set_link — коллизии маловероятны в пределах одного бота.
