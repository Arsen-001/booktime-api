# BookTime — сервер

Бэкенд для сайта `~/WebstormProjects/booking-platform`. План и решения владельца — `booking-platform/docs/backend/PLAN.md`,
журнал постройки — [docs/PROGRESS.md](docs/PROGRESS.md).

Стек (PLAN.md Р1): NestJS 12 (ES-модули) · MySQL 9 · Prisma 7 (адаптер MariaDB) · Redis 7 · BullMQ.

## Запуск локально

```bash
cp .env.example .env
npm install
npm run db:up            # MySQL :3316, Redis :6389 (Docker)
npx prisma migrate dev   # схема базы
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
