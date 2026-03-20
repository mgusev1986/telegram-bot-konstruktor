# Тесты навигации и связности бота

## Запуск

```bash
npm run test        # один прогон
npm run test:watch  # в watch-режиме
```

## Что проверяется

### 1. `navigation-audit.test.ts`
- Построение графа навигации из списка пунктов меню (root, parent-child, SECTION_LINK → target).
- Валидация: битые target, отсутствующий target у SECTION_LINK, orphan-страницы, битый parent.
- Хелперы: `getButtonTargetPage`, `getBackTargetPageId`.

### 2. `navigation-integrity.test.ts`
- Целостность маршрутов: root и главное меню, разделы и подразделы, кнопка «Назад», целевые страницы кнопок.
- Полный прогон по графу: все страницы достижимы, все ссылки валидны.

### 3. `keyboards.test.ts`
- Контракт клавиатур: каждая кнопка меню → `menu:open:<pageId>`; «Назад» → `menu:back:<parentId>`; «В главное меню» → `nav:root`.
- У админа есть «Настроить страницу» → `page_edit:open:<currentPageId>`; у пользователя — нет.
- Вертикальный layout: по одной кнопке в ряд для пунктов меню и навигации.

## Аудит по реальной БД

В проде или при наличии БД можно вызывать:

```ts
const errors = await services.menu.runNavigationAudit({ requireRootContent: true });
```

Ошибки имеют коды: `BROKEN_BUTTON_TARGET`, `SECTION_LINK_MISSING_TARGET`, `ORPHAN_PAGE`, `BROKEN_PARENT`, `EMPTY_ROOT`.

## Интерпретация падений

| Ошибка теста | Что проверить |
|--------------|----------------|
| `BROKEN_BUTTON_TARGET` | В данных есть SECTION_LINK с несуществующим `targetMenuItemId`. |
| `SECTION_LINK_MISSING_TARGET` | Кнопка-ссылка без указанной целевой страницы. |
| `ORPHAN_PAGE` | Страница не достижима от root (битый parent или не в дереве). |
| Падение в `keyboards.test` | Изменён формат callback_data или layout клавиатур в `keyboards.ts`. |
