# Engineering Handoff — Telegram Bot Konstruktor

Один snapshot проекта для переноса контекста в новый чат или онбординга разработчика. Обновляйте этот файл после крупных изменений.

### Last checkpoint
Дата: 2026-03-20
Снапшот: `snapshot-2026-03-20_20-40-51.tar.gz`
Сборка: `npm run build` (pass), `npm run lint:types` (pass)
Деплой: Hetzner VPS (77.42.79.54), Docker Compose

### Checkpoint notes (2026-03-20) — деплой и bootstrap
- **Деплой на Hetzner VPS:** проект развёрнут через `scripts/hetzner-setup.sh`, `docker-compose.prod.yml`. Репозиторий: github.com/mgusev1986/telegram-bot-konstruktor.
- **Ранний старт HTTP-сервера:** `startHttpServer()` вызывается сразу после `registerBackofficeRoutes()`, до запуска ботов. Раньше `listen()` был в конце bootstrap — при зависании Telegram API `/health` не отвечал, контейнер перезапускался.
- **Ленивый payment webhook:** `addPaymentWebhookRoute(server, getServices, prisma)` принимает геттер; webhook возвращает 503 до готовности сервисов. Все роуты регистрируются до `listen()` без ошибки Fastify "Root plugin has already booted".
- **Путь точки входа:** `node dist/src/index.js` (исправлено с `dist/index.js`).
- **Seed InactivityReminderRule:** исправлен Prisma `WhereUniqueInput` в seed-demo-structure.ts.

### Checkpoint notes (2026-03-19)
- Упрощен UX language-version editor: убрана кнопка `💾 Сохранить в черновик` из post-edit/preview flow; после edit-action показывается только `👁 Предпросмотр версии`, `✅ Опубликовать`, `↩️ Назад`, `🗂 В главное меню`.
- `👁 Предпросмотр версии` стал интерактивным walkthrough всей языковой версии: старт с `root` редактируемого языка и навигация по дереву страниц.
- Порядок/иконки кнопок в preview version: `↩️ Назад` -> `🛠 Вернуться в редактор языка` -> `🗂 В главное меню` (кнопка `🗂...` всегда внизу).
- Publish применяет изменения только после нажатия `✅ Опубликовать` (без мгновенного автоприменения после ввода текста/медиа).
- Выполнен большой рефактор по разделению языков:
  - `adminUiLanguageCode` (язык интерфейса админа)
  - `editingContentLanguageCode` (язык редактируемого контента)
- Исправлено смешение языков в UI/контенте для:
  - page editor flow
  - edit content scene
  - rename button scene
  - create section / create button scenes
  - attach video from media library scene
  - inactivity reminder admin scene (часть flow + preload title)
- Добавлены/обновлены регресс-тесты locale split:
  - `tests/edit-page-content.scene.locale.test.ts`
  - `tests/rename-button.scene.locale-split.test.ts`
  - `tests/page-editor-language-wiring.test.ts`
  - `tests/create-button-link.scene.locale-split.test.ts`
  - `tests/create-section.scene.locale-split.test.ts`
  - `tests/attach-video.scene.locale-split.test.ts`
  - `tests/inactivity-reminder.scene.locale-split.test.ts`
- Локализация UI в связанных flow (partner/cabinet external ref link/export captions/html export) приведена к i18n-ключам.

---

## 1. Overview проекта

**Название:** telegram-bot-konstruktor  
**Назначение:** конструктор Telegram-ботов для MLM-презентаций: сборка меню (главная, разделы, подразделы, кнопки), контент страниц (текст/фото/видео/документ), онбординг мастера, drip-серии, рассылки, кабинет, рефералы, экспорт.

**Стек:** Node.js ≥20, TypeScript, Telegraf, Prisma (PostgreSQL), Redis, BullMQ, Fastify.

**Ключевые договорённости:**
- Один активный шаблон презентации (PresentationTemplate isActive: true).
- Root = главная страница (контент из PresentationLocalization.welcome*, кнопки = MenuItem с parentId null).
- «Добавить новый раздел» = новая страница + кнопка на текущей; «Добавить новую кнопку» = только кнопка (SECTION_LINK) на существующую страницу.
- Все кнопки в интерфейсе бота — вертикально (одна в ряд).
- «↩️ Назад» ведёт на реальную предыдущую страницу с контентом; «🗂 В главное меню» = тот же экран, что /start.

---

## 2. Структура папок и файлов

```
Telegram Bot - Konstruktor/
├── HANDOFF.md                 # этот файл
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env / .env.example
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts                # теги, бейджи
│   └── seed-demo-structure.ts # демо: главная, разделы, подразделы, drip
├── docs/
│   ├── PRODUCT_REBUILD_AUDIT_REPORT.md
│   ├── CONSTRUCTOR_UX_REDESIGN.md
│   └── NAVIGATION_STANDARD.md
├── tests/
│   ├── README.md
│   ├── helpers/
│   │   └── mock-i18n.ts
│   ├── navigation-audit.test.ts
│   ├── navigation-integrity.test.ts
│   └── keyboards.test.ts
└── src/
    ├── index.ts               # точка входа: prisma, redis, services, bot, http, workers
    ├── config/
    │   └── env.ts
    ├── app/
    │   └── services.ts        # buildServices(prisma, redis, bull)
    ├── common/
    │   ├── callback-data.ts
    │   ├── errors.ts
    │   ├── html.ts
    │   ├── json.ts
    │   ├── logger.ts
    │   ├── media.ts
    │   └── personalization.ts
    ├── infrastructure/
    │   ├── prisma.ts
    │   └── redis.ts
    ├── http/
    │   └── server.ts
    ├── bot/
    │   ├── context.ts
    │   ├── register-bot.ts    # вся регистрация хендлеров, sendRootWithWelcome, sendMenuPage
    │   ├── keyboards.ts       # buildMenuKeyboard, buildContentScreenKeyboard, buildPageEditorKeyboard, nav
    │   ├── helpers/
    │   │   ├── message-content.ts
    │   │   └── screen-template.ts
    │   └── scenes/
    │       ├── create-section.scene.ts
    │       ├── create-menu-item.scene.ts
    │       ├── create-button-link.scene.ts
    │       ├── edit-page-content.scene.ts
    │       ├── rename-button.scene.ts
    │       ├── create-broadcast.scene.ts
    │       ├── create-drip-campaign.scene.ts
    │       └── ...
    └── modules/
        ├── menu/
        │   ├── menu.service.ts
        │   └── navigation-audit.ts  # граф, валидация, runNavigationAudit
        ├── navigation/
        │   └── navigation.service.ts
        ├── i18n/
        │   ├── i18n.service.ts
        │   └── static-dictionaries.ts
        ├── users/
        │   └── user.service.ts
        ├── drip/
        │   └── drip.service.ts
        ├── broadcasts/
        │   └── broadcast.service.ts
        ├── cabinet/
        │   └── cabinet.service.ts
        ├── referrals/
        │   └── referral.service.ts
        ├── payments/
        │   └── payment.service.ts
        ├── access/
        │   └── access-rule.service.ts
        ├── analytics/
        │   └── analytics.service.ts
        ├── audit/
        │   └── audit.service.ts
        ├── jobs/
        │   ├── scheduler.service.ts
        │   └── workers.ts
        ├── exports/
        │   └── export.service.ts
        ├── permissions/
        │   └── permission.service.ts
        ├── notifications/
        │   └── notification.service.ts
        ├── ab/
        │   └── ab-test.service.ts
        └── ...
```

---

## 3. Архитектура

- **Вход:** `src/index.ts` — поднимает Prisma, Redis, BullMQ, собирает сервисы (`buildServices`), запускает HTTP (Fastify), регистрирует бота (`registerBot(services)`), вешает уведомления/рассылки/drip на `bot.telegram`, запускает воркеры (drip, broadcast, scheduler).
- **Бот:** Telegraf, сцены (WizardScene) для создания раздела/кнопки/рассылки/drip. Контекст расширен (`BotContext`) сервисами и сессией (в т.ч. навигация navPrev/navCurrent).
- **Навигация:** «Главная» = `sendRootWithWelcome` (getWelcome + getMenuItemsForParent(null) + buildMenuKeyboard). Любая страница по id = `sendMenuPage(ctx, pageId)` (при null/root → sendRootWithWelcome). «Назад» из меню = `menu:back:<parentId>` → sendMenuPage(ctx, parentId). «В главное меню» = `nav:root` → sendRootWithWelcome.
- **Персистентность:** Всё важное в PostgreSQL (Prisma). Временное — только состояние сцен и ctx.session (напр. nav). Отмена сцены не удаляет уже сохранённые данные.

---

## 4. Логика конструктора

- **Страница (раздел):** экран с контентом (текст; фото/видео/документ с подписью или только файл). Хранится как MenuItem + MenuItemLocalization (title, contentText, mediaType, mediaFileId).
- **Кнопка:** пункт меню, ведущий на страницу. Обычный раздел = одна запись MenuItem (type TEXT/PHOTO/VIDEO/DOCUMENT/SUBMENU), показывается как кнопка с callback `menu:open:<id>`. Доп. кнопка на существующую страницу = type SECTION_LINK, targetMenuItemId = id целевой страницы.
- **«Добавить новый раздел»:** сцена create-section (или переход в неё из онбординга): запрос названия кнопки → запрос контента одним сообщением → createMenuItem с parentId текущей страницы → кнопка появляется на текущей странице автоматически.
- **«Добавить новую кнопку»:** сцена create-button-link: выбор целевой страницы + название кнопки → createMenuItem type SECTION_LINK с targetMenuItemId.
- **Подраздел:** дочерняя страница (parentId = id страницы, из которой вызвали «Добавить новый раздел»). Контекст в сценах задаётся через section_hint_inside_page / section_hint_on_root.

---

## 5. Логика навигации

- **Root:** Виртуальная страница «root». Контент = `getWelcome(user)` из PresentationLocalization активного шаблона. Кнопки = `getMenuItemsForParent(user, null)`.
- **Открытие страницы:** callback `menu:open:<id>`. Если id = SECTION_LINK с targetMenuItemId — показывается контент целевой страницы, parent для «Назад» = родитель ссылки. Иначе — getMenuItemContent(user, id), getMenuItemsForParent(user, id); если есть дети или type SUBMENU — экран «подменю» (title+content + кнопки детей), иначе — контент + buildContentScreenKeyboard.
- **«↩️ Назад»:** В меню контента callback `menu:back:<parentId>` (parentId или "root") → sendMenuPage(ctx, parentId ?? null). В редакторе страницы callback `page_edit:back:<pageId>`: если pageId root → sendRootWithWelcome; иначе — переход на родителя или showPageEditor(parentId).
- **«🗂 В главное меню»:** callback `nav:root` → sendRootWithWelcome. Должен совпадать с экраном по /start.
- **Редактор страницы:** «🛠 Настроить страницу» = `page_edit:open:<currentPageId>`, чтобы редактор открывался именно для текущей страницы. В редакторе: изменить контент, добавить раздел/кнопку, управление кнопками, предпросмотр, удаление (не для root), Назад, В главное меню.

---

## 6. Логика страниц / кнопок / подразделов

- **MenuItem:** id, templateId, parentId (null = корневой уровень), key (уникальный), type (TEXT, PHOTO, VIDEO, DOCUMENT, LINK, SUBMENU, SECTION_LINK), sortOrder, isActive, targetMenuItemId (для SECTION_LINK). Локализации в MenuItemLocalization (languageCode, title, contentText, mediaType, mediaFileId).
- **Кнопки на экране:** Собираются в keyboards.ts. buildMenuKeyboard — по одной кнопке в ряд (вертикально); каждая пункт меню = `menu:open:<item.id>`; в конце строки навигации (menu:back:<parentId>, nav:root), для админа — «Настроить страницу» (page_edit:open:<currentPageId>).
- **Подразделы:** Родитель = страница с parentId; её дети = getMenuItemsForParent(user, parentId). «Назад» с дочерней страницы = sendMenuPage(ctx, parentId).

---

## 7. Текущие модули и их роли

| Модуль | Роль |
|--------|------|
| **menu** | Шаблон, приветствие (setWelcome, getWelcome), пункты меню (createMenuItem, getMenuItemsForParent, getMenuItemContent, findMenuItemById), дерево, превью, удаление, runNavigationAudit. |
| **navigation** | replaceScreen (обновление последнего сообщения контентом + клавиатура, сохранение lastContentMessageId). |
| **navigation-audit** | Построение графа (buildNavigationGraph), валидация (validateNavigationGraph), хелперы getButtonTargetPage, getBackTargetPageId. |
| **i18n** | Словари (static-dictionaries), t(), pickLocalized, availableLanguages. |
| **users** | Поиск/создание по telegram id, онбординг (setOnboardingStep, setOnboardingCompleted, resetOnboarding). |
| **drip** | Кампании, шаги, enrollUser(triggerType), отправка по расписанию (scheduler). |
| **broadcasts** | Рассылки, сегменты, планирование. |
| **cabinet** | Текст кабинета, реферальная ссылка, pay button. |
| **referrals** | Реферальные коды, разрешение пригласителя. |
| **payments** | Продукты, доступ, ensureDemoProducts. |
| **access** | Правила доступа к пунктам меню (accessRuleId, productId), locked. |
| **audit** | Лог действий (audit.log). |
| **jobs/scheduler** | Отложенные задачи (BullMQ), восстановление после рестарта. |
| **exports** | Выгрузка структуры/пользователей (HTML, Excel). |
| **permissions** | Роли, OWNER/ADMIN, grantAdmin. |

---

## 8. Состояние базы / Prisma schema

- **PostgreSQL**, подключение через `DATABASE_URL`.
- **Ключевые модели:** User, PresentationTemplate, PresentationLocalization, MenuItem, MenuItemLocalization, DripCampaign, DripStep, DripStepLocalization, UserDripProgress, Broadcast, Product, Payment, AccessRule, AdminPermission, ReferralEvent, Tag, Badge и др.
- **Один активный шаблон:** `PresentationTemplate` с `isActive: true`. У него — welcome в PresentationLocalization и все MenuItem с этим templateId.
- **MenuItem:** parentId null = кнопки на главной; иначе — дочерние к странице parentId. SECTION_LINK — targetMenuItemId указывает на страницу, на которую ведёт кнопка.
- Миграции: `prisma migrate deploy` / `prisma migrate dev`. Сид базовый: `prisma/seed.ts`. Демо-структура: `prisma/seed-demo-structure.ts` (главная, разделы, подразделы «О продукте» → Продукт 1–3, drip 3 шага по 1 мин, ON_REGISTRATION).

---

## 9. Текущие реализованные функции

- Регистрация пользователя по /start, определение OWNER по SUPER_ADMIN_TELEGRAM_ID.
- Главная страница: приветствие (с плейсхолдером {name}), кнопки разделов первого уровня.
- Разделы и подразделы: контент (текст/фото/видео/документ), кнопки детей, «Назад», «В главное меню».
- Онбординг: язык → главная → первый раздел → выбор (ещё раздел / предпросмотр) → предпросмотр → публикация.
- Создание раздела вручную: название кнопки → контент одним сообщением.
- Создание кнопки-ссылки (SECTION_LINK) на существующую страницу.
- Редактор страницы: изменить контент, добавить раздел/кнопку, управление кнопками (переименовать, цель, вкл/выкл, порядок, удалить), удаление страницы (не root), предпросмотр структуры.
- Кабинет пользователя, связь с наставником, смена языка.
- Админ-панель: структура, предпросмотр, публикация, рассылки, drip, экспорт, полное обнуление (с подтверждением).
- Drip: кампании с шагами (delayValue + delayUnit), триггер ON_REGISTRATION (и др.), запланированная отправка.
- Рассылки и отложенные рассылки.
- Отложенные (scheduled) рассылки: админский hub `Отложенные` → `📅 Запланированные`, list/detail на конкретной рассылке, действия `Редактировать/Остановить/Удалить` (редактирование сейчас открывает recreate-flow).
- Экспорт (HTML, Excel).
- Аудит навигации: buildNavigationGraph, validateNavigationGraph, runNavigationAudit (по активному шаблону).
- Демо-сид: `npm run prisma:seed-demo` — готовая структура для ручной проверки.

---

## 10. Известные баги и нестабильные зоны

- **«Назад» из редактора главной страницы:** При нажатии «↩️ Назад» в экране «Редактирование страницы: Главная страница» пользователь может попасть на пустой экран (только «Главное меню» без контента). Проверить: для `page_edit:back` с value `root` всегда вызывается `sendRootWithWelcome(ctx)`, а не только заголовок меню.
- Scheduled: `✏️ Редактировать` для запланированных рассылок сейчас работает как “пересоздание” (открывает recreate-flow); для true-edit это следующий шаг.
- **Битые target у SECTION_LINK:** Исправлено: при нажатии на кнопку SECTION_LINK с несуществующим targetMenuItemId пользователь перенаправляется на главную с сообщением «Эта кнопка ведёт на удалённую страницу» (link_target_missing), без падения бота.
- **Orphan pages:** Страницы, недостижимые от root (напр. битый parentId), выявляются runNavigationAudit (ORPHAN_PAGE).
- **Язык в мастерах:** В сценах создания пункта меню может запрашиваться язык снова; продуктовая договорённость — базовый язык один раз в онбординге, доп. языки отдельно.
- **Перегрузка админки:** Много кнопок в одном списке; «Полностью обнулить» уже помечен ⚠️.

---

## 11. Важные продуктовые договорённости

- Все видимые кнопки — вертикально, одна в ряд.
- «🗂 В главное меню» = тот же root, что и /start (sendRootWithWelcome).
- «↩️ Назад» = реальная предыдущая страница с контентом (sendMenuPage по parentId), не пустой заголовок.
- «Добавить новый раздел» = новая страница + кнопка на текущей; «Добавить новую кнопку» = только кнопка на существующую страницу.
- Отмена сцены не удаляет сохранённые данные; полное обнуление — отдельное опасное действие с подтверждением.
- Плейсхолдеры в пользовательском контенте: {name}, {{first_name}}, {{last_name}}, {{username}}, {{full_name}}; в подсказках админа показывать буквально, в контенте пользователю — подставлять.

---

## 12. Roadmap / что делать дальше

- ~~Исправить «Назад» из редактора главной~~: уже реализовано — page_edit:back для root вызывает sendRootWithWelcome.
- Scheduled broadcasts: сделать полноценный true-edit (изменение времени/аудитории/языка/контента) вместо recreate-flow на экране деталей.
- ~~Защита от битых target~~: реализован fallback при открытии SECTION_LINK с несуществующим targetMenuItemId (главная + link_target_missing).
- Усилить UX редактора: явный контекст «Вы редактируете: [название]» на каждом шаге.
- Опционально: вынести разрешение маршрутов (resolve target page, resolve back target) в отдельный сервис для тестируемости.
- Улучшение экспорта (подписи, имена файлов, кликабельные username в HTML) без ущерба приоритетам навигации и конструктора.

---

## 13. Команды запуска

```bash
# зависимости
npm install

# БД
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed          # теги, бейджи
npm run prisma:seed-demo     # демо-структура (главная, разделы, подразделы, drip)

# приложение
npm run dev                  # tsx watch src/index.ts
npm run build && npm start   # production

# тесты
npm run test                 # vitest run
npm run test:watch           # vitest watch

# типы
npm run lint:types           # tsc --noEmit
```

Требуется `.env`: DATABASE_URL, REDIS_URL, BOT_TOKEN, SUPER_ADMIN_TELEGRAM_ID, BOT_USERNAME и др. (см. .env.example).

### Деплой на Hetzner VPS

```bash
# На сервере (первый раз)
git clone https://github.com/mgusev1986/telegram-bot-konstruktor.git /opt/telegram-bot-konstruktor
cd /opt/telegram-bot-konstruktor
cp .env.production.example .env
nano .env   # заполнить DATABASE_URL, REDIS_URL, BOT_TOKEN, SUPER_ADMIN_TELEGRAM_ID и др.
sudo bash scripts/hetzner-setup.sh

# Обновление после git push
cd /opt/telegram-bot-konstruktor
git pull
docker compose -f docker-compose.prod.yml build --no-cache bot
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

Проверка: `curl http://localhost:3000/health` или `http://77.42.79.54:3000/health`.

---

## 14. Manual testing checklist

- [ ] `/start` — открывается главная с приветствием и кнопками разделов.
- [ ] «🗂 В главное меню» с любой страницы — тот же экран, что по /start.
- [ ] Кнопка раздела → открывается контент этого раздела; «↩️ Назад» → родитель с контентом.
- [ ] Раздел с подразделами (напр. «О продукте») → кнопки подразделов; подраздел → контент; «Назад» → «О продукте».
- [ ] У админа на странице контента есть «🛠 Настроить страницу»; открывается редактор этой страницы.
- [ ] В редакторе главной «↩️ Назад» → главная с контентом (не пустой экран).
- [ ] После удаления дочерней страницы в редакторе открывается полная страница родителя с контентом.
- [ ] Кабинет, смена языка, связь с наставником — работают.
- [ ] Админ: предпросмотр структуры, публикация, «⚠️ Полностью обнулить бота» с подтверждением.
- [ ] Drip: новый пользователь после /start получает серию (если есть активная кампания ON_REGISTRATION); интервалы по delayValue/delayUnit.
- [ ] Демо: после `npm run prisma:seed-demo` в Telegram — главная с разделами О компании, О продукте (с Продукт 1–3), О пассивном доходе, О маркетинге; все переходы и «Назад» работают.

---

## 15. Краткий handoff для нового чата

Скопируй в новый чат:

**Проект:** Telegram Bot Konstruktor — конструктор MLM-ботов (меню, разделы, подразделы, контент, drip, рассылки). Стек: Node/TS, Telegraf, Prisma (PostgreSQL), Redis, BullMQ.

**Главное по навигации:** Главная = sendRootWithWelcome (getWelcome + getMenuItemsForParent(null)). Любая страница = sendMenuPage(ctx, pageId). «Назад» = menu:back:<parentId> → sendMenuPage(ctx, parentId). «В главное меню» = nav:root → sendRootWithWelcome. Редактор страницы для root при «Назад» должен вызывать sendRootWithWelcome, иначе возможен пустой экран.

**Ключевые файлы:** `src/bot/register-bot.ts` (хендлеры, sendRootWithWelcome, sendMenuPage), `src/bot/keyboards.ts` (вертикальные кнопки, callback_data), `src/modules/menu/menu.service.ts` (контент, дети, createMenuItem), `src/modules/menu/navigation-audit.ts` (граф, валидация). Тесты: `tests/navigation-audit.test.ts`, `tests/navigation-integrity.test.ts`, `tests/keyboards.test.ts`. Демо-данные: `npm run prisma:seed-demo`.

**Деплой:** Hetzner VPS 77.42.79.54, Docker Compose. HTTP-сервер стартует до запуска ботов — `/health` отвечает сразу. Репозиторий: github.com/mgusev1986/telegram-bot-konstruktor.

**Полный контекст:** см. HANDOFF.md в корне проекта.
