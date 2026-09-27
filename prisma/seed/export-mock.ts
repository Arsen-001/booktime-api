/**
 * Запускается tsx'ом с tsconfig ФРОНТА (prisma/seed/mock-core.ts): печатает в stdout JSON демо-ядра мока
 * (booking-platform/src/mock/seed) — чтобы сид сервера строил те же бизнесы, людей и записи, что демо фронта.
 */
// @ts-expect-error — путь из tsconfig фронта, в сборке сервера не участвует
import { seedCore } from '@/mock/seed';

const now = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date();
process.stdout.write(JSON.stringify(seedCore(now)));
