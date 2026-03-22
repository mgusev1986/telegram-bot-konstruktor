# Пошаговая настройка admin.botzik.pp.ua

---

## Шаг 1: Открыть туннели Cloudflare

**Ссылка:** https://one.dash.cloudflare.com  

1. Войдите, если нужно.
2. Слева: **Networks** → **Tunnels**.
3. Или прямая ссылка: https://one.dash.cloudflare.com → слева **Networks** → **Tunnels**.

---

## Шаг 2: Узнать адрес туннеля

1. Нажмите на имя вашего туннеля (одного из двух).
2. В блоке **Overview** или **Connector** найдите строку вида:
   ```
   xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.cfargotunnel.com
   ```
3. **Скопируйте** её целиком (без `https://`).

---

## Шаг 3: Проверить Public Hostname

1. На той же странице туннеля найдите **Public Hostname**.
2. Должна быть запись:
   - Subdomain: `admin`
   - Domain: `botzik.pp.ua`
   - URL: `localhost:3000`
3. Если нет — нажмите **Add a public hostname** и введите:
   - Subdomain: `admin`
   - Domain: `botzik.pp.ua`
   - Service type: `HTTP`
   - URL: `localhost:3000`
   - Сохраните.

---

## Шаг 4: Открыть DNS домена

**Ссылка:** https://dash.cloudflare.com  

1. Нажмите на домен **botzik.pp.ua**.
2. Слева: **DNS** → **Records**.
3. Или: https://dash.cloudflare.com → выбрать `botzik.pp.ua` → **DNS**.

---

## Шаг 5: Добавить CNAME-запись

1. Нажмите **Add record** (или **Добавить запись**).
2. Заполните:

   | Поле | Значение |
   |------|----------|
   | Type | `CNAME` |
   | Name | `admin` |
   | Target | Вставьте адрес туннеля из Шага 2 (например `a1b2c3d4-e5f6-7890-abcd-ef1234567890.cfargotunnel.com`) |
   | Proxy status | Proxied (оранжевое облако включено) |

3. Нажмите **Save**.

---

## Шаг 6: Проверить

Подождите 1–2 минуты и откройте в браузере:

```
https://admin.botzik.pp.ua/backoffice
```

---

## Быстрые ссылки

| Страница | Ссылка |
|----------|--------|
| Туннели | https://one.dash.cloudflare.com → Networks → Tunnels |
| DNS записей | https://dash.cloudflare.com → botzik.pp.ua → DNS |
| Backoffice | https://admin.botzik.pp.ua/backoffice |
