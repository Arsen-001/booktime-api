/**
 * Поиск окон для переноса записи (QA приложений 15.10.2026): `excludeBookingId` — время самой переносимой записи
 * не занято, окна со сдвигом внутри неё предлагаются; без него — как раньше. База и Redis — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AvailabilityService, withoutBooking } = await import('./availability.service.js');

const DATE = '2030-03-12'; // будущий день — «сейчас» окна не режет
const WEEK = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{ from: '10:00', to: '14:00' }]]));
const at = (hm: string) => new Date(`${DATE}T${hm}:00.000+04:00`);

function service() {
  // Запись 11:00–12:00 этого мастера и чужая (другого бизнеса того же человека) 13:00–14:00
  const blocks = [
    { personKey: 'st_1', source: 'booking', sourceId: 'bk_move', startAt: at('11:00'), endAt: at('12:00'), serviceEndAt: at('12:00'), businessId: 'biz_1', staffId: 'st_1', workplace: 'salon', noShow: false },
    { personKey: 'st_1', source: 'booking', sourceId: 'bk_other', startAt: at('13:00'), endAt: at('14:00'), serviceEndAt: at('14:00'), businessId: 'biz_1', staffId: 'st_1', workplace: 'salon', noShow: false },
  ];
  const prisma = {
    staff: {
      findMany: async () => [
        { id: 'st_1', businessId: 'biz_1', userId: null, name: 'Анна', status: 'active', calendarMode: 'free', onlineBookingEnabled: true, serviceIds: [], deletedAt: null, locations: [{ locationId: 'loc_1' }] },
      ],
    },
    location: { findUnique: async () => ({ tz: 'Asia/Yerevan' }) },
    workSchedule: { findMany: async () => [{ id: 'ws_1', staffId: 'st_1', locationId: 'loc_1', workplace: 'salon', week: WEEK, openUntil: null, days: [] }] },
    calendarMark: { findMany: async () => [] },
    busyBlock: { findMany: async () => blocks },
    businessSetting: { findUnique: async () => null },
    onlineSlotRuleSet: { findMany: async () => [] },
    service: { findFirst: async () => null },
  };
  const store = new Map<string, string>();
  const redis = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v) };
  return new AvailabilityService(prisma as never, redis as never, null as never);
}

const starts = (slots: { start: string }[]) => slots.map((s) => s.start.slice(11, 16));

test('withoutBooking: убирает только блоки этой записи', () => {
  const busy = [
    { source: 'booking', sourceId: 'bk_1' },
    { source: 'booking', sourceId: 'bk_2' },
    { source: 'mark_busy', sourceId: 'bk_1' },
  ];
  assert.deepEqual(withoutBooking(busy, 'bk_1'), busy.slice(1));
  assert.equal(withoutBooking(busy, undefined), busy);
});

test('окна мастера: без excludeBookingId время записи занято; с ним — сдвиг на 30 мин внутри неё предлагается', async () => {
  const svc = service();
  const plain = starts(await svc.freeSlots('biz_1', { staffId: 'st_1', date: DATE, durationMin: 60 }));
  assert.ok(!plain.includes('11:00') && !plain.includes('11:30'), plain.join(','));
  const moving = starts(await svc.freeSlots('biz_1', { staffId: 'st_1', date: DATE, durationMin: 60, excludeBookingId: 'bk_move' }));
  assert.ok(moving.includes('11:30') || moving.includes('11:00'), moving.join(','));
  // Другая запись по-прежнему занята
  assert.ok(!moving.includes('13:00'), moving.join(','));
});

test('быстрая запись (перенос из кабинета): то же правило', async () => {
  const svc = service();
  const plain = starts(await svc.quickSlots('biz_1', { staffId: 'st_1', date: DATE }));
  assert.ok(!plain.includes('11:15'), plain.join(','));
  const moving = starts(await svc.quickSlots('biz_1', { staffId: 'st_1', date: DATE, excludeBookingId: 'bk_move' }));
  assert.ok(moving.includes('11:15') && moving.includes('11:30'), moving.join(','));
  assert.ok(!moving.includes('13:00'), moving.join(','));
});
