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

Сервер покрывает все 21 раздел плана (§6), OpenAPI — `/openapi.json` (945 путей на 28.09). Фронт переведён на сервер
не целиком: часть функций фасадов `src/api/*` в режиме `api` всё ещё читает моковую базу браузера (её держит живой
`src/api/mirror.ts`). Счёт ведёт `booking-platform/scripts/facade-audit.mjs` (печатает по файлам и вид дыры:
`area` — состояние только в браузере, `core` — ядро браузера вне зеркала, `mirror` — только зеркалируемые сервером
сущности). Точный список — `docs/PROGRESS.md`, «Этап 21 — Сдача, попытка 4».

Настройки сети одной строкой на область — `NetworkSetting` (`network_settings`): расписание письма плана, телефония
(Р19: только «подключено», токен, маршруты и правила — звонков сервер не знает), заявки на удаление локаций,
журнал выгрузок.
