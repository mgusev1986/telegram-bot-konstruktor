# Полная ревизия: Telegram Bot Konstruktor — отчёт

**Дата:** 2026-03-17  
**Роль:** Senior product engineer, UX auditor, QA, bug fixer.

---

## 1. EXECUTIVE SUMMARY

1. **Root / «Назад» из редактора главной** — уже корректно: `page_edit:back` для root вызывает `sendRootWithWelcome(ctx)` (register-bot.ts ~982–983).
2. **Битый SECTION_LINK** — исправлено: при несуществующем `targetMenuItemId` пользователь перенаправляется на главную с сообщением `link_target_missing` вместо падения.
3. **i18n** — убран дубликат ключа `drip_wizard_step_lang` (оставлен `drip_wizard_step_language`), в en добавлен `drip_wizard_add_first_step` для консистентности типов.
4. **Навигация** — escape-маршруты `/start` и `nav:root` обрабатываются до stage; вертикальная раскладка кнопок и slotOrder для nav соблюдаются.
5. **Drip** — кодовая цепочка проверена: `enrollUser(ON_REGISTRATION)` при регистрации, `scheduler.schedule` с idempotencyKey, worker `processProgress`, отправка через `sendRichMessage`. Ручной E2E (3×1 мин) рекомендуется выполнить при запущенных app + Redis + workers.
6. **Существующие ошибки lint:types** — не связаны с аудитом (scenes/WizardContext, create-menu-item SCENE_CANCEL_DATA, export.service/menu.service undefined, i18n ключи в en). Широкий рефакторинг не вносился.
7. **Тесты** — 35 тестов проходят (navigation-audit, navigation-integrity, keyboards); автоматических тестов на runtime fallback SECTION_LINK не добавлялось (логика покрыта audit BROKEN_BUTTON_TARGET).
8. **HANDOFF.md** — обновлён: отмечены исправления по root back и битым target.

---

## 2. AUDIT FINDINGS

### Critical
- **SECTION_LINK с несуществующим target** — при нажатии вызывался `getMenuItemContent(user, targetMenuItemId)`, что приводило к `findUniqueOrThrow` и падению. **Исправлено:** проверка `findMenuItemById(target)` перед контентом; при отсутствии target — показ главной с текстом `link_target_missing`.

### Major
- **Дубликат ключа drip_wizard_step_lang / drip_wizard_step_language** — в ru был и `drip_wizard_step_lang`, и `drip_wizard_step_language`; сцена использует только `drip_wizard_step_language`. Удалён `drip_wizard_step_lang` из ru; в en добавлен `drip_wizard_add_first_step` для выравнивания ключей и типов.

### Medium
- **Общие сообщения об ошибках** — в нескольких местах используется `error_generic`. Для битой ссылки добавлено отдельное сообщение `link_target_missing`; остальные места не менялись в рамках минимального патча.
- **Язык в мастерах** — по handoff возможен лишний запрос языка; в текущей реализации drip wizard явно запрашивает язык цепочки (шаг 3) — продуктово допустимо.

### Minor
- **Pre-existing type errors** — в проекте есть ошибки типов в scenes (BotContext vs WizardContext), SCENE_CANCEL_DATA в create-menu-item, export.service/menu.service, i18n (ключи только в ru). Не исправлялись, чтобы не расширять объём ревизии.

---

## 3. FIXES IMPLEMENTED

| Изменение | Файл |
|-----------|------|
| Проверка существования target у SECTION_LINK; при отсутствии — главная + `link_target_missing` | `src/bot/register-bot.ts` |
| Новые ключи i18n `link_target_missing` (ru, en) | `src/modules/i18n/static-dictionaries.ts` |
| Удалён ключ `drip_wizard_step_lang` из ru | `src/modules/i18n/static-dictionaries.ts` |
| Добавлен ключ `drip_wizard_add_first_step` в en | `src/modules/i18n/static-dictionaries.ts` |
| Обновлены формулировки по битым target и root back | `HANDOFF.md` |

---

## 4. UX IMPROVEMENTS

- Пользователь при нажатии на кнопку с удалённой целью видит понятное сообщение («Эта кнопка ведёт на удалённую страницу. Откройте главное меню.») и главное меню, а не ошибку или «часики».
- Консистентность ключей drip wizard (один ключ для шага языка, наличие ключа в en) снижает риск отсутствующих переводов.

---

## 5. DRIP TEST REPORT

- **Код:** Цепочка проверена по коду.
  - Регистрация: в register-bot после создания/привязки пользователя вызывается `services.drips.enrollUser(result.user.id, "ON_REGISTRATION")`.
  - `enrollUser`: выбирает активные кампании с данным triggerType, для каждой создаёт/обновляет UserDripProgress, считает nextRunAt по первому шагу, вызывает `scheduler.schedule("SEND_DRIP_STEP", { progressId }, nextRunAt, idempotencyKey)`.
  - Worker: обрабатывает job, вызывает `drips.processProgress(progressId)`; processProgress отправляет текущий шаг пользователю, планирует следующий шаг тем же типом job с новым nextRunAt.
  - Idempotency: `scheduler.schedule` использует idempotencyKey и не создаёт дубликаты.
- **Ручной E2E:** Не выполнялся в рамках сессии (требуется запуск приложения, Redis, воркеров и тестового пользователя). Рекомендуется: seed-demo или создание кампании 3 шага по 1 минуте, новый пользователь, проверка доставки через 1, 2 и 3 минуты.
- **Итог:** Логика drip и планирования согласована с архитектурой; для уверенности в доставке нужен ручной прогон.

---

## 6. TEST RESULTS

- **Automated:** `npm run test` — 35 passed (navigation-audit, navigation-integrity, keyboards).
- **Manual:** В рамках ревизии не выполнялся полный ручной чеклист; рекомендуется пройти пункты из раздела 7 (Manual checklist).

---

## 7. RISKS / FOLLOW-UPS

- **Следующий проход:** исправить оставшиеся ошибки lint:types (scenes, SCENE_CANCEL_DATA, export/menu, i18n ключи в en); при необходимости — добавить unit-тест на обработчик menu:open для SECTION_LINK с несуществующим target (с моками).
- **Риски:** без изменений; архитектура навигации и drip не менялась.

---

## 8. SHORT DIFF SUMMARY

- **register-bot.ts:** перед вызовом `getMenuItemContent` для SECTION_LINK добавлена проверка `findMenuItemById(target)`. При отсутствии target — setNavCurrent("menu:open:root"), загрузка items и rootSlotOrder, replaceScreen с текстом `link_target_missing` и buildMenuKeyboard для root.
- **static-dictionaries.ts:** добавлены `link_target_missing` (ru, en); удалён `drip_wizard_step_lang` (ru); добавлен `drip_wizard_add_first_step` (en).
- **HANDOFF.md:** в разделе «Известные баги» и «Roadmap» отмечено исправление битых target и текущее поведение root back.

---

## 9. MANUAL CHECKLIST (рекомендуемый)

| # | Сценарий | Статус |
|---|----------|--------|
| 1 | `/start` открывает корректный root | NOT TESTED |
| 2 | `/start` внутри сцены делает reset | NOT TESTED |
| 3 | «В главное меню» совпадает с `/start` | NOT TESTED |
| 4 | «Назад» ведёт на корректный экран | NOT TESTED |
| 5 | page editor root back не ломается | NOT TESTED |
| 6 | SECTION_LINK с битым target показывает главную + сообщение | NOT TESTED |
| 7 | create section работает | NOT TESTED |
| 8 | create button link работает | NOT TESTED |
| 9 | page editor button management работает | NOT TESTED |
| 10 | onboarding логичен | NOT TESTED |
| 11 | language picker логичен | NOT TESTED |
| 12 | admin panel не перегружена критично | NOT TESTED |
| 13 | drip creation понятен | NOT TESTED |
| 14 | delayed drip 3×1 min реально отрабатывает | NOT TESTED |
| 15 | Нет новых console/server errors | NOT TESTED |

После запуска бота и Redis рекомендуется пройти пункты 1–15 и отметить PASS/FAIL.
