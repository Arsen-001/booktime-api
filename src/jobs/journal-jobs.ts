import type { Redis } from 'ioredis';
import { AuditService } from '../common/audit/audit.service.js';
import { LiveService } from '../common/live/live.service.js';
import type { PrismaService } from '../common/prisma.service.js';
import { AvailabilityService } from '../modules/availability/availability.service.js';
import { OccupyService } from '../modules/availability/occupy.js';
import { BookingsService, SYSTEM_ACTOR } from '../modules/journal/bookings.service.js';
import { JournalSettingsService } from '../modules/journal/journal-settings.js';
import { SeriesService } from '../modules/journal/series.service.js';
import { LoyaltyProgramService } from '../modules/loyalty/loyalty-program.service.js';

/**
 * Фоновые задачи журнала (PLAN §6 №7, Р10) в воркере — те же сервисы, что у API, собранные без Nest:
 *  - journal.holds (каждую минуту): снять заявки без предоплаты/ответа мастера по сроку (B13, В-03, В-05) и
 *    продвинуть раздачу освободившихся окон (В-18);
 *  - journal.series (ночью, 03:00 по Еревану): продлить серии повторов на 8 недель вперёд (F-00-064, A11).
 */
export function journalServices(prisma: PrismaService, redis: Redis) {
  const live = new LiveService(redis);
  const availability = new AvailabilityService(prisma, redis, live);
  const bookings = new BookingsService(prisma, new OccupyService(), availability, new AuditService(), live, new JournalSettingsService(prisma), new LoyaltyProgramService(prisma, new AuditService()));
  const series = new SeriesService(bookings, availability);
  return { bookings, series, live };
}

export async function journalHolds(svc: ReturnType<typeof journalServices>) {
  const released = await svc.bookings.releaseExpired();
  const freed = await svc.bookings.advanceFreedSlots();
  return { released, freed };
}

export async function journalSeries(svc: ReturnType<typeof journalServices>) {
  return { added: await svc.series.extendDue(SYSTEM_ACTOR) };
}
