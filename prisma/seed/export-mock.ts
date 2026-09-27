/**
 * Запускается tsx'ом с tsconfig ФРОНТА (prisma/seed/mock-core.ts): печатает в stdout JSON демо-ядра мока
 * (booking-platform/src/mock/seed) — чтобы сид сервера строил те же бизнесы, людей и записи, что демо фронта.
 * С этапа 6 рядом кладётся срез раздела «schedule» (шаблоны, история, правила слотов, настройки) — `areaSchedule`.
 */
// @ts-expect-error — путь из tsconfig фронта, в сборке сервера не участвует
import { seedCore } from '@/mock/seed';
// @ts-expect-error — путь из tsconfig фронта
import { scheduleSlice } from '@/mock/slices/schedule';

const now = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date();
const core = seedCore(now);
process.stdout.write(JSON.stringify({ ...core, areaSchedule: scheduleSlice.seed(core, now) }));
