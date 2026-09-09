# AutonomOS — завершальний пакет lifecycle, 2026-09-09

Цей пакет продовжує main `752db433c8708e7d9a55dfbb2afbd2f2a50a5583`. Усі зміни підготовлено разом; ZIP створюється з точного staged Git tree до єдиного коміту. Фінальний SHA, CI та Render фіксуються в окремій копії звіту після публікації.

## Результат розробки

- Спільний `runAcceptedJob` для TaskForce, Agrenting, Gmail та native API: виконання, acceptance QA, до п’яти ремонтних спроб, збереження результатів фаз і навчальних записів. GitHub використовує спеціалізований repository executor з реальною тестовою перевіркою.
- Єдина обмежена черга виконання: за замовчуванням два одночасні виконання, максимум вісім із урахуванням ресурсів. Прийняті роботи та найближчі deadlines мають пріоритет. Виправлено гонку повторної постановки одного job і резервування слотів. Це динамічні task workers у чинному сервісі, а не нові платні Render instances.
- Глобальна перевірка бюджету і запис витрат під одним durable lock. Паралельні роботи не можуть незалежно витратити той самий доступний залишок. Витрати clarification, execution і QA враховуються; повторно збережений результат не викликає LLM.
- GitHub працює з чинним токеном або підключеним GitHub через Composio без експорту OAuth credentials. Перевіряє власника облікового запису, справжній статус API, призначення issue, повноваження автора винагороди. Пропозиція створити bounty, непідтверджений Opire bot та вимога попереднього фінансування не є оплачуваним контрактом.
- GitHub application має стабільний marker. Втрата відповіді відновлюється читанням реального коментаря того самого автора. PR використовує стабільну job branch та доказ тестів. Правки із CHANGES_REQUESTED виконуються на поточній гілці, проходять QA і доставляються без force push; втрачений push відновлюється звіркою tree і parent.
- Native API adapter використовує перевірену OpenAPI-схему, дозволені поля, необхідні IDs, коректні альтернативні/складені security requirements, same-origin endpoints, durable application/delivery intent і зовнішні receipts. Без підтвердженої automation permission write не виконується. Реєстрація не вигадує callback на /health.
- Додано окремий Freelancer adapter за офіційним SDK: власний OAuth account, fixed-price bid, перевірка award/accepted/funded milestone, project-thread delivery, відновлення доставки за sender/project/revision marker, облік окремих released milestones. Він активується лише за наявності справжнього FREELANCER_OAUTH_TOKEN. Нової підписки чи покупки bids не створює.
- Agrenting отримав durable delivery snapshots, reconciliation після timeout, revisions, паралельну чергу та backoff. Completed без payment transaction не зараховується як дохід. TaskForce зберігає зв’язок ledger receipts із конкретною роботою.
- Gmail зберігає sender/thread binding і зовнішній delivery message ID. Повідомлення про оплату є лише підказкою: для наявного EVM owner wallet додано read-only перевірку receipt, chain ID, статусу, configured stablecoin contract, адреси одержувача, часу та підтверджень. Одна транзакція не розподіляється на дві роботи. Часткова оплата не закриває повний рахунок.
- Browser action layer: navigate, JS/DOM, type/click/select, upload/download, screenshots, extraction зовнішнього ID. Приватна cookie session зберігається на persistent disk; повторна неоднозначна дія не надсилається сліпо. Чужий origin та human verification gates зупиняють відповідну операцію.
- Пошук залишається широким. Порожні джерела опитуються рідше; GitHub discovery використовує чинне підключення. Невідомий USD-equivalent, несвіжа робота, employment listing або payout нижче $5 не стають eligible. Безкоштовна application не означає виграний контракт чи дозвіл витрачати на execution.
- Єдиний business snapshot об’єднує native/GitHub/email/TaskForce/Agrenting, дедуплікує receipts і jobs, відокремлює applications, acceptance, execution, QA, delivery, client review, pending payout та paid. Dashboard показує all-time revenue/cost/fees/net окремо від 24H показників.
- Owner-retired markets/tools залишаються заблокованими у runtime, discovery, diagnostics і recovery. Історичні фінансові записи не видалялися. Нових платних providers/subscriptions не додано.

## Перевірки

Повний `npm run verify` завершився exit 0. Додатково `remaining-lifecycle-test` — 18/18, `production-lifecycle-test` — 13/13. Після фінального уточнення підрахунку оплат і deadline знову перевірено ці два відповідні набори. Реальний Chromium пройшов upload/select/submit/receipt/download/screenshot, відновлення cookie session і блокування переходу на інший origin. Новий browser regression включено до GitHub CI. Render build також виконує повний verify.

Ці тести є доказами реалізації та відновлення після збоїв. Вони не є вигаданими платними контрактами чи production receipts.

## Live BEFORE

Спостереження `/autonomos-global-feed.json`, 2026-09-09 18:38 UTC:

| Показник | Значення |
|---|---:|
| Discovered | 2689 |
| Routable | 41 |
| Eligible за попереднім алгоритмом | 38 |
| Applications із збереженими IDs | 41 |
| Accepted / executing / QA / delivered / paid | 0 / 0 / 0 / 0 / 0 |
| Gross revenue | $0 |
| Recorded costs | $0.686 |
| Net | −$0.686 |

Після виправлення eligibility числа не обов’язково зростають: конкурентна робота без оцінки економіки та старий listing не означають придатний контракт.

## Ринки та зовнішні умови

| Ринок / маршрут | Реалізація та встановлений стан |
|---|---|
| TaskForce | Чинний account/worker. Останнє production спостереження: 4 jobs, усі нижче $5; applications на них не надсилаються |
| Agrenting | Чинний зареєстрований provider; assigned hirings 0. Worker продовжує polling |
| GitHub / Opire / Algora / IssueHunt / BOSS | Discovery та GitHub application/assignment/verified PR/revision pipeline. Account або payout onboarding окремої платформи не підміняється GitHub login; оплата не вважається автоматичною після merge |
| Freelancer | Public API дав 100 listings в останньому poll. Native lifecycle реалізовано, але OAuth provider account має існувати у production; public listings не доводять authenticated bidding |
| Нові API marketplaces | Dynamic registry + schema-driven acquisition/execution/delivery. Реальні endpoint, permission, account та receipts мають пройти перевірку до readiness |
| Guru / Workana / Contra / PeoplePerHour / Truelancer | Каталог збережено. Ця сесія не підтвердила авторизовані signup/bidding/payout accounts і дозволений повний browser workflow; ці ринки не оголошуються FULL_AUTO_READY |
| Direct client / Gmail | Прив’язаний до конкретного замовника маршрут; жодна відповідь autoresponder не стає прийняттям контракту |

Відсутність доступного акаунта або призначення замовником не можна усунути вигаданою реєстрацією. Browser capability не дорівнює перевіреній інтеграції кожного сайту. Fiat-to-crypto conversion не заявляється виконаною: чинні wallets/routes збережені, але без авторизованого cashout route/receipt новий переказ не створюється.

## Джерела контрактів API та обмежень

- [Офіційний Freelancer SDK](https://github.com/freelancer/freelancer-sdk-python) — provider bids, awards, milestones і project messages.
- [Composio proxy execute](https://docs.composio.dev/docs/extending-sessions/proxy-execute) — використання чинного connected account.
- [Opire commands](https://docs.opire.dev/overview/commands) — GitHub claim workflow; наявність bot перевіряється окремо.
- [Contra Terms](https://contra.com/policies/terms) — account identity, перевірка особи та обмеження автоматизованого доступу. Відсутність KYC-доказу не обходиться.
- [Workana Terms](https://www.workana.com/pages/view/terms), [Guru Terms](https://www.guru.com/terms-of-service/), [PeoplePerHour Terms](https://www.peopleperhour.com/static/terms), [Truelancer Terms](https://www.truelancer.com/legal/terms-service) — посилання для account-specific перевірки; неповне читання цих сторінок не використовується як доказ дозволу automation.

## Умови бізнес-приймання

Технічний реліз не означає, що всі 73 вимоги доведено реальним платним циклом. Acceptance → delivery → settled revenue потребує справжнього призначеного замовлення та зовнішнього підтвердження оплати. Показники AFTER, точний commit і результат Render додаються після розгортання; нульовий дохід залишається нульовим, поки receipt не підтверджено.
