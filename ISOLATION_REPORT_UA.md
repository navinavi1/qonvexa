# Ізоляція AutonomOS від Qonvexa — 2026-09-27

База: останній переданий `qonvexa-next-ready.zip`. Це зміни локальної копії, не перевірка актуального коду на Render.

## Що змінено

- Web `server.js`, worker `scripts/qonvexa-worker.mjs` і сумісний старий launcher запускають тільки Qonvexa. Запуск legacy через npm залишається заблокованим.
- Активний `render.yaml` більше не містить `REDIS_URL`, `DATABASE_URL`, посилань на autonomos-cache/autonomos-db або ключів/увімкнених циклів legacy.
- `AUTONOMOS_ENABLED=false`; успадковане значення true не активує legacy в Qonvexa.
- Основні env examples не вимагають Redis/Postgres. Початкові конфігурації збережено у `docs/legacy/` як неактивні текстові файли.
- `npm run verify` перевіряє Qonvexa. Старий змішаний набір збережено як `verify:legacy`; запускати його слід лише із наявним offline runner. Він не є build/start prerequisite.
- Production CI більше не запускає браузерний runtime AutonomOS. Змінено лише локальний YAML, workflow не запускався.
- `/health` показує `runtimeProfile: qonvexa-isolated-v1`, `legacyRuntimeEnabled: false`, `externalRedisRequired: false`, `externalPostgresRequired: false`.
- npm-пакети redis/pg залишені для неактивного legacy-коду. Наявність пакета не створює мережевого підключення. Нові тести забороняють їх імпорт із Qonvexa.

## Де залишаються дані

Leads/orders/clients: попередні JSON/NDJSON у STORAGE_DIR. Нові audits/jobs: SQLite `qonvexa-next.sqlite` у тому самому каталозі. Redis/Postgres не є сховищами цього runtime. STORAGE_DIR і його резервні копії залишаються потрібними. Дані AutonomOS не видалено й не перенесено.

## Умови майбутньої зупинки Redis

Для цього коду Redis та стара PostgreSQL не потрібні. Це НЕ підтвердження, що вже запущена production-версія або інші сервіси їх не використовують.

Перш ніж зупиняти Redis, окремо потрібно:

1. За вашою окремою командою встановити саме цю версію; поточна робота нічого не деплоїть.
2. Перевірити marker `/health`, homepage, admin, замовлення і worker на встановленій версії, а також відсутність legacy-процесів/Redis reconnect у логах.
3. Перевірити, чи немає інших web/worker/cron/Trigger або сторонніх застосунків, що використовують autonomos-cache. Інвентар Render тут не перевірявся.
4. Зберегти потрібні legacy-дані/backup і перевірити фактичний тип доступної операції у Render. Цей звіт не стверджує, що конкретний тариф дозволяє pause без видалення.
5. Лише після цього приймати окреме рішення про зупинку. Не видаляти autonomos-db або persistent disk за цим звітом.

Render, production env, Redis, PostgreSQL, GitHub, DNS і live інтеграції не змінювалися.
