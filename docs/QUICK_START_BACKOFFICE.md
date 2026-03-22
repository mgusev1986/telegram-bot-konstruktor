# Быстрый старт: доступ к Backoffice через Cloudflare

Пошаговая инструкция. Выполняйте по порядку.

---

## Шаг 1: Создать Tunnel в Cloudflare (в браузере)

1. Откройте: **https://one.dash.cloudflare.com**
2. В левом меню: **Networks** → **Tunnels**
3. Нажмите **Create a tunnel**
4. Выберите **Cloudflared**
5. Имя туннеля: `telegram-bot` (любое)
6. Нажмите **Save tunnel**
7. **Скопируйте длинный токен** (начинается с `eyJ...`) — он появится в окне после сохранения.

---

## Шаг 2: Добавить Public Hostname

В том же окне туннеля (или в настройках только что созданного):

1. Найдите раздел **Public Hostname**
2. Нажмите **Add a public hostname**
3. Заполните:
   - **Subdomain:** `admin`
   - **Domain:** выберите `botzik.pp.ua` (или ваш домен)
   - **Service type:** `HTTP`
   - **URL:** `localhost:3000`
4. Нажмите **Save hostname**

Итог: `https://admin.botzik.pp.ua` будет вести на backoffice.

---

## Шаг 3: Подключиться к серверу

В терминале на вашем Mac:

```bash
ssh root@77.42.79.54
```

Введите пароль, когда попросит.

---

## Шаг 4: Установить Cloudflare Tunnel

**На сервере** (после `ssh`):

```bash
cd /opt/telegram-bot-konstruktor
```

Замените `ВСТАВЬТЕ_ТОКЕН_СЮДА` на токен из Шага 1 (целиком, в кавычках):

```bash
sudo bash scripts/cloudflared-install.sh "ВСТАВЬТЕ_ТОКЕН_СЮДА"
```

**Пример** (ваш токен будет другой):

```bash
sudo bash scripts/cloudflared-install.sh "eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmMxMjM0In0.xxxxxxxxxxxx"
```

---

## Шаг 5: Проверить

**На сервере:**

```bash
systemctl status cloudflared
```

Должно быть: `active (running)`.

В Cloudflare Dashboard статус туннеля должен смениться на **Healthy**.

---

## Шаг 6: Открыть Backoffice

В браузере откройте:

```
https://admin.botzik.pp.ua/backoffice
```

(Или `https://admin.ВАШ_ДОМЕН/backoffice`)

При первом заходе появится Cloudflare Access — войдите по email и введите код из письма.

---

## Если что-то не работает

| Проблема | Действие |
|----------|----------|
| `Unit cloudflared.service could not be found` | Скрипт из Шага 4 не запускали или он завершился с ошибкой. Запустите снова с токеном. |
| Страница не открывается | Проверьте: домен в Cloudflare, NS у регистратора (NIC.UA) указывают на Cloudflare. |
| Cloudflare Access спрашивает код | Нормально. Проверьте почту, введите код из письма. |
| Туннель в статусе Pending | Подождите 1–2 минуты после Шага 4. Проверьте `journalctl -u cloudflared -f`. |

---

## Локальные миграции Prisma (на Mac)

Если нужны миграции без Docker:

```bash
# 1. Поднять PostgreSQL (если ещё не запущен)
docker compose up -d postgres

# 2. Применить миграции
npm run prisma:migrate:local

# Или создать новую миграцию
npm run prisma:dev:local -- --name имя_миграции
```
