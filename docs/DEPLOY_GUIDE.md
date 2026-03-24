# Деплой бота на Hetzner

Универсальная инструкция для обновления бота. Все данные (цепочки, рассылки, push-уведомления) сохраняются.

---

## Одна команда

```bash
npm run deploy
```

Скрипт автоматически:
1. Закоммитит и запушит изменения (если есть)
2. Сделает бэкап БД перед обновлением
3. Обновит код на сервере, соберёт и перезапустит бота
4. Применит миграции

---

## Полная последовательность (если делаете вручную)

```bash
# 1. Сохранить изменения в git
git add -A
git commit -m "Update: описание изменений"
git push origin main

# 2. Деплой (всё остальное скрипт сделает сам)
npm run deploy
```

---

## С произвольным сообщением коммита

```bash
npm run deploy "Добавлены кнопки к письмам"
```

---

## Восстановление (если что-то пошло не так)

```bash
ssh root@77.42.79.54 "cd /opt/telegram-bot-konstruktor && bash scripts/restore-db.sh /root/bot-backups/backup-YYYY-MM-DD_HH-MM-SS/database.sql.gz"
```

(Подставьте дату нужного бэкапа из `ls /root/bot-backups/`)

---

## Быстрые проверки после деплоя

```bash
# Логи бота
ssh root@77.42.79.54 "cd /opt/telegram-bot-konstruktor && docker compose -f docker-compose.prod.yml logs -f bot --tail 50"

# Список бэкапов
ssh root@77.42.79.54 "ls -la /root/bot-backups/"

# Статус контейнеров
ssh root@77.42.79.54 "cd /opt/telegram-bot-konstruktor && docker compose -f docker-compose.prod.yml ps"
```
