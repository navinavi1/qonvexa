# Ваш чек-лист дій — з обох глибоких перевірок цієї сесії

Це ВСЕ, що потрібно зробити з вашого боку. Нічого більше не приховано в тексті звітів.

---

## A. Замінити 17 файлів на GitHub (структура папок вже правильна)

- [ ] `src/autonomos/runtime.js`
- [ ] `src/autonomos/agency-intelligence.js`
- [ ] `src/autonomos/capabilities.js`
- [ ] `src/autonomos/job-executor.js`
- [ ] `src/autonomos/qa-engine.js`
- [ ] `src/autonomos/outcome-model.js`
- [ ] `src/autonomos/products.js`
- [ ] `src/autonomos/task-agent-runtime.js`
- [ ] `src/autonomos/mcp-client.js`
- [ ] `src/autonomos/artifact-store.js`
- [ ] `src/autonomos/connectors/index.js`
- [ ] `scripts/agency-intelligence-test.mjs`
- [ ] `scripts/autonomos-workforce-test.mjs`
- [ ] `scripts/general-audit.mjs`
- [ ] `public/admin.html`
- [ ] `.env.example`
- [ ] `.env.production.example`

## B. Видалити з папки `/public/` на GitHub (публічно доступний старий backend-код)

- [ ] `public/server.js`
- [ ] `public/package.json`
- [ ] `public/render.yaml`
- [ ] `public/Procfile`
- [ ] уся папка `public/scripts/`
- [ ] `public/DEPLOY.md`
- [ ] `public/FINAL-LAUNCH-CHECKLIST.md`
- [ ] `public/GITHUB-RENDER-DEPLOY.md`
- [ ] `public/LAUNCH-REPORT.md`
- [ ] `public/PRODUCTION-5-REPORT.md`
- [ ] `public/PRODUCTION-5.1-REPORT.md`
- [ ] `public/PRODUCTION-6.0-REPORT.md`
- [ ] `public/PRODUCTION-7.0-REPORT.md`
- [ ] `public/PRODUCTION-7.1-REPORT.md`
- [ ] `public/QONVEXA-11.0-SHORT-REPORT.md`
- [ ] `public/QONVEXA-8.0-LAUNCH-REPORT.md`
- [ ] `public/QONVEXA-9.0-FINAL-AUDIT.md`
- [ ] `public/QONVEXA-9.0-REPORT.md`
- [ ] `public/QONVEXA-PRODUCTION-FINALIZATION-REPORT.md`
- [ ] `public/QONVEXA-REDESIGN-CHANGELOG.md`
- [ ] `public/README.md` (саме той, що ВСЕРЕДИНІ `public/` — кореневий README.md не чіпайте)
- [ ] `public/RENDER-7.1-DEPLOY.md`

## C. Перевірити/додати в Render → Environment

- [ ] **`AUTONOMOS_OWNER_WALLET`** — переконайтесь, що встановлена явно вашою адресою. У коді є запасний варіант, який мовчки підставить ту саму адресу, якщо змінна зникне, — але краще не покладатись на це.
- [ ] **`AUTONOMOS_ARTIFACT_URL_TTL_SECONDS`** — якщо там стоїть `3600` (1 година), змініть на `604800` (7 днів). Якщо змінної там взагалі немає — нічого робити не треба, новий код сам використає правильний дефолт.
- [ ] **`SUPERTEAM_HUMAN_TELEGRAM`** — НОВА змінна, якої раніше не існувало. Додайте її зі своїм реальним Telegram у форматі `http://t.me/ваш_нікнейм`. Без неї заявки типу "project" на Superteam Earn гарантовано провалюються (це вимога самого Superteam, не наша).

## D. Після заливки — що подивитись за перші кілька циклів

- [ ] "OPPORTUNITIES" на дашборді росте, а не застрягло на 500.
- [ ] "QUEUE" тепер підписано чесно ("qualified & attempted last cycle").
- [ ] У "Recent claim/delivery activity" з'являються ціни біля кожної задачі.
- [ ] Помилки `delivery_failed:http_403` по Superteam зникли.
- [ ] Якщо є Superteam-заявки типу "project" — перевірте, що вони більше не провалюються через відсутній `telegram`.

---

Це буквально все. Жодних прихованих дій, крім цих чотирьох розділів.
