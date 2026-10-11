/**
 * «Правила записи» бизнеса (11.10.2026): «не дальше чем на» (maxDaysAhead) и «сотрудник для всех записей»
 * (staffForAllBookings) — хранятся, отдаются, горизонт ограничивает окна виджета и саму запись. База в памяти.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { OnlineService, lastBookableDate, DEFAULT_MAX_DAYS_AHEAD } = await import('./online.service.js');
const { nowLocal } = await import('../../common/time/time.js');
type Ctor = ConstructorParameters<typeof OnlineService>;
type Row = Record<string, unknown>;

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Равенство, `in`, составной ключ businessId_area — больше эти методы не просят */
function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'businessId_area') {
      const o = v as Row;
      return r.businessId === o.businessId && r.area === o.area;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      return !('in' in o) || (o.in as unknown[]).includes(r[k]);
    }
    return v === null ? r[k] === null || r[k] === undefined : r[k] === v;
  });
}

function memoryPrisma(tables: Record<string, Row[]>) {
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    groupBy: async () => [],
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const list = (tables[name] ??= []);
      const found = list.find((r) => matches(r, where));
      if (found) Object.assign(found, { ...update, version: 2 });
      else list.push({ ...create });
      return found ?? create;
    },
  });
  return Object.fromEntries(['business', 'location', 'staff', 'service', 'serviceCategory', 'bookingLink', 'workSchedule', 'businessSetting', 'onlineRecord', 'booking'].map((n) => [n, table(n)]));
}

function makeService(settings: Row | null = null) {
  const tables: Record<string, Row[]> = {
    business: [
      {
        id: 'barber', kind: 'salon', name: 'barber', slug: 'barber', sphereIds: ['barber'], networkId: null, ownerStaffId: 'm1', phone: '+37410000000', description: null, logoUrl: null, photos: [],
        status: 'active', createdAt: new Date('2026-01-01T00:00:00Z'), forbidHomeBookingsDuringShift: false, socials: null, bookingRules: null, brandName: null, ordersEnabled: null, orderPickupReminders: null, version: 1,
      },
    ],
    location: [],
    staff: ['m1', 'm2'].map((id) => ({
      id, businessId: 'barber', name: id, phone: '+37491000000', role: id === 'm1' ? 'owner' : 'master', sphereIds: [], serviceIds: ['svc1'], photos: [], materials: [], workplaces: ['salon'],
      accepts: 'all', calendarVisibility: 'all', status: 'active', onlineBookingEnabled: true, deletedAt: null, version: 1, locations: [], bookingRules: null,
    })),
    service: [{ id: 'svc1', businessId: 'barber', name: { ru: 'Стрижка' }, durationMin: 30, priceMin: 5000n, priceMax: null, order: 0, kind: 'individual', sphereId: 'barber', active: true, onlineBookable: true, staffIds: ['m1', 'm2'] }],
    serviceCategory: [],
    bookingLink: [
      { id: 'lnk1', businessId: 'barber', locationId: null, networkId: null, name: 'Основная', kind: 'normal', bookingType: 'individual', defaultLocale: 'ru', staffId: null, primary: true, formId: 'f1', createdAt: new Date('2026-01-01T00:00:00Z'), version: 1, config: {} },
    ],
    workSchedule: [
      { businessId: 'barber', staffId: 'm1' },
      { businessId: 'barber', staffId: 'm2' },
    ],
    businessSetting: settings ? [{ businessId: 'barber', area: 'online', data: settings, version: 1 }] : [],
    onlineRecord: [],
    booking: [],
  };
  const calls: string[] = [];
  const availability = {
    freeSlots: async (_b: string, q: { date: string; staffId: string }) => {
      calls.push(q.date);
      return [{ staffId: q.staffId, locationId: 'loc1', workplace: 'salon', start: `${q.date}T10:00`, end: `${q.date}T10:30` }];
    },
  };
  const otp = { verify: async () => { throw new Error('otp must not be reached'); } };
  const moderation = { hiddenRefIds: async () => new Set<string>() };
  const svc = new OnlineService(memoryPrisma(tables) as unknown as Ctor[0], availability as unknown as Ctor[1], otp as unknown as Ctor[2], {} as Ctor[3], moderation as unknown as Ctor[4]);
  return { svc, tables, calls };
}

const slotQuery = (date: string) => ({ staffId: 'm1', date, durationMin: 30 });

test('правила по умолчанию: maxDaysAhead 60, сотрудника для всех записей нет', async () => {
  const { svc } = makeService();
  const r = await svc.businessOnlineRules('barber');
  assert.equal(r.maxDaysAhead, DEFAULT_MAX_DAYS_AHEAD);
  assert.equal(r.staffForAllBookings, undefined);
});

test('PUT online/rules сохраняет «не дальше чем на» и «сотрудника для всех записей», null снимает', async () => {
  const { svc, tables } = makeService({ hourCycle: '12' });
  let r = await svc.updateBusinessOnlineRules('barber', { maxDaysAhead: 14, staffForAllBookings: 'm2' });
  assert.equal(r.maxDaysAhead, 14);
  assert.equal(r.staffForAllBookings, 'm2');
  assert.equal(r.hourCycle, '12', 'остальные правила не теряются');
  r = await svc.updateBusinessOnlineRules('barber', { staffForAllBookings: null });
  assert.equal(r.staffForAllBookings, undefined);
  assert.equal(r.maxDaysAhead, 14);
  assert.ok(!('staffForAllBookings' in (tables.businessSetting![0]!.data as Row)), 'null не хранится');
});

test('PUT online/rules: чужой или несуществующий сотрудник — staff_not_found', async () => {
  const { svc } = makeService();
  await assert.rejects(svc.updateBusinessOnlineRules('barber', { staffForAllBookings: 'nobody' }), (e: { code?: string }) => e.code === 'staff_not_found');
});

test('публичная страница: maxDaysAhead, anyStaffAllowed и сотрудник для всех записей в ссылке', async () => {
  const { svc } = makeService({ maxDaysAhead: 30, staffForAllBookings: 'm2', allowAnyStaffForAllLinks: false });
  const d = await svc.publicBusinessData('barber');
  assert.equal(d.maxDaysAhead, 30);
  assert.equal(d.anyStaffAllowed, false);
  assert.equal(d.link?.staffForAllBookings, 'm2');
});

test('публичная страница: своя настройка ссылки главнее общей', async () => {
  const { svc, tables } = makeService({ staffForAllBookings: 'm2' });
  (tables.bookingLink![0] as Row).config = { staffForAllBookings: 'm1' };
  const d = await svc.publicBusinessData('barber');
  assert.equal(d.link?.staffForAllBookings, 'm1');
  assert.equal(d.maxDaysAhead, DEFAULT_MAX_DAYS_AHEAD);
  assert.equal(d.anyStaffAllowed, true);
});

test('окна виджета: в горизонте есть, дальше «не дальше чем на» — пусто', async () => {
  const { svc, calls } = makeService({ maxDaysAhead: 7 });
  const today = nowLocal().slice(0, 10);
  assert.equal((await svc.widgetSlots('barber', slotQuery(addDays(today, 7)))).length, 1);
  assert.deepEqual(await svc.widgetSlots('barber', slotQuery(addDays(today, 8))), []);
  assert.ok(!calls.includes(addDays(today, 8)), 'за горизонтом окна даже не считаются');
});

test('месяц и ближайшая дата не выходят за горизонт', async () => {
  const { svc } = makeService({ maxDaysAhead: 7 });
  const today = nowLocal().slice(0, 10);
  const last = lastBookableDate(7, today);
  const month = await svc.monthAvailability('barber', { staffId: 'm1', durationMin: 30, month: last.slice(0, 7) });
  for (const [date, open] of Object.entries(month)) if (date > last) assert.equal(open, false, date);
  assert.equal(month[last], true);
  assert.equal(await svc.nearestDate('barber', { staffId: 'm1', durationMin: 30, from: addDays(today, 8) }), undefined);
  assert.equal(await svc.nearestDate('barber', { staffId: 'm1', durationMin: 30, from: today }), today);
});

test('запись дальше горизонта отклоняется до проверки кода', async () => {
  const { svc } = makeService({ maxDaysAhead: 7 });
  const start = `${addDays(nowLocal().slice(0, 10), 9)}T10:00`;
  await assert.rejects(
    svc.createBooking('barber', {
      staffId: 'm1', start, services: [{ serviceId: 'svc1' }], clientName: 'Анна', clientPhone: '+37491234567', code: '1234', source: 'widget', device: 'mobile', locationId: 'loc1',
    }),
    (e: { code?: string }) => e.code === 'slot_taken',
  );
});
