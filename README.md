# BookTime — сервер

Бэкенд для сайта `~/WebstormProjects/booking-platform`. План и решения владельца — `booking-platform/docs/backend/PLAN.md`,
журнал постройки — [docs/PROGRESS.md](docs/PROGRESS.md).

Стек (PLAN.md Р1): NestJS 12 (ES-модули) · MySQL 9 · Prisma 7 (адаптер MariaDB) · Redis 7 · BullMQ.

## Запуск локально

```bash
cp .env.example .env
npm install
npm run db:up            # MySQL :3316, Redis :6389 (Docker)
npx prisma migrate dev   # схема базы + сид (npx prisma db seed — демо-данные из мока фронта, нужен ../booking-platform или FRONTEND_DIR)
npm run build
npm run start:api        # http://localhost:4010 — /v1/health, /docs, /openapi.json
npm run start:worker     # очереди и расписания (отдельный процесс)
```

Разработка: `npm run dev` (tsc --watch) и в другом окне `node --watch dist/main.js`. Сборка обычным `tsc`, а не
esbuild/tsx: Nest берёт зависимости из метаданных декораторов (`emitDecoratorMetadata`).

- OpenAPI для фронта: `npm run openapi` → `openapi/openapi.json`.
- Ошибки API — всегда `{ code, message }` (`src/common/errors`).
- Конфиг — только переменные окружения (`src/common/config/env.ts` проверяет их при старте).
- Файлы — адаптер хранилища: `STORAGE_DRIVER=local` (папка) или `s3`.
- Коммит: `npm run commit -- "сообщение"` (isomorphic-git, системный git на этой машине может быть недоступен).

## Вход при разработке (этап 2)

- Код входа — в логе API (`[fake code-sender]`); при `NODE_ENV=development` и `DEV_LOGIN_CODE=0000` код всегда `0000`.
  Telegram Gateway настоящий, если задан `TELEGRAM_GATEWAY_TOKEN`; WhatsApp и SMS — заглушки.
- Клиенты — номера из мока (`+374 00 160 001` — Ани, `au_01`); новый номер создаёт нового человека.
- Администраторы салонов — логины из мока (`lilit.nuri`, `anahit.atam`, …), пароль = логин, первый вход просит сменить.
- Команда платформы (`/platform/login` фронта): `platform` / `booktime-dev`, затем код.
- Фронт в режиме сервера: `NEXT_PUBLIC_DATA=api` при сборке, при разработке — открыть любой адрес с `?data=api`
  (`?data=mock` — обратно к демо). Сессия — httpOnly cookie `bt_session` (панель — `bt_platform`).

## Бизнес и сотрудники (этап 3)

- «Мастер или бизнес» по номеру владельца из мока — его бизнес: `+374 00 110 001` — владелец Nuri Nail Studio,
  `+374 00 150 001` — мастер-индивидуал Лусине, `+374 00 140 001` — владелец сети Manana (оба филиала, роль «сеть»).
  Новый номер без бизнеса попадает на регистрацию бизнеса.
- Членство и права читаются из базы на каждом запросе: снятая галочка, отключённый доступ, увольнение действуют сразу.
- Приглашение из сида: `/biz/onboarding/invite/dev-invite-st_nuri_eva` (номер `+374 00 110 008`). Новые ссылки
  выпускает «Скопировать ссылку» / «Отправить ещё раз» — прежняя ссылка при этом перестаёт работать.
- Сид можно запускать повторно на рабочей базе (`npx prisma db seed`): уже существующие строки пропускаются.

## Проверка перед сдачей (PLAN.md §9)

```bash
npx tsc --noEmit -p tsconfig.build.json      # 0 ошибок
npm run openapi                              # сборка + openapi/openapi.json
# чистая база: migrate reset --force (или CREATE DATABASE … + prisma migrate deploy) и npx prisma db seed
npm run start:api & npm run start:worker     # /v1/health → {db:true, redis:true}
```

Фронт: `npx tsc --noEmit --incremental --tsBuildInfoFile .tsbuild/backend.tsbuildinfo`, затем экраны с `?data=api`
настоящим входом (номера выше, код `0000`).

## Состояние (этап 21 «Сдача»)

Сервер покрывает все 21 раздел плана (§6), OpenAPI — `/openapi.json` (1031 путь на 28.09, после попытки 6). Все
используемые экранами функции фасадов `booking-platform/src/api/*` в режиме `api` идут на сервер: аудит
`booking-platform/scripts/facade-audit.mjs` — **0 используемых дыр** (было 89 после попытки 5: маркетплейс
интеграций, сторис/новости/продвижение кабинета, чат через партнёра — закрыты попыткой 6). Скрипт ещё печатает
33 экспортированные функции без единого потребителя (мёртвый код фасадов) и 36 «внутренних помощников» из
allowlist с причиной на каждого. `src/api/mirror.ts` держит в браузере зеркало серверных сущностей для чистых
вычислений экранов. Подробности — `docs/PROGRESS.md`, «Этап 21 — Сдача, попытка 6 (итог)».

Настройки сети одной строкой на область — `NetworkSetting` (`network_settings`): расписание письма плана, телефония
(Р19: только «подключено», токен, маршруты и правила — звонков сервер не знает), заявки на удаление локаций,
журнал выгрузок.

Обход всех экранов в режиме `api` настоящим входом (владелец сети Manana `+374 00 140 001`, клиент `+374 00 160 001`,
панель `platform`/`booktime-dev`, код `0000`): 278 страниц, 0 падений (28.09). Осторожно: вход по коду ограничен
30 запросами кода с одного IP за 10 минут (`auth-code-ip`) и 10 кодами на номер в сутки — несколько обходов подряд
упираются в `rate_limited`; держите одну сессию на прогон.
