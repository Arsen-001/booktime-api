/**
 * Места подписки (владелец 17.11.2026, ответ 19): бесплатно — только ассистент по галочке без своих услуг, графика и
 * записей; приглашённый, не вошедший — до первого входа, но не дольше 14 дней с приглашения; минимум салона — 2 мастера.
 * База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { computeSeats, INVITED_FREE_DAYS } = await import('./billing-seats.js');
const { DEFAULT_PRICES } = await import('./billing-prices.js');
type Db = Parameters<typeof computeSeats>[0];

const DAY = 86_400_000;
type StaffRow = { id: string; name: string; role: string; status: string; userId: string | null; assistantOnly: boolean; serviceIds: string[]; hiredAt: string };
const st = (id: string, over: Partial<StaffRow> = {}): StaffRow => ({ id, name: id, role: 'master', status: 'active', userId: `u_${id}`, assistantOnly: false, serviceIds: ['svc1'], hiredAt: '2026-01-10', ...over });

function db(staff: StaffRow[], opts: { scheduled?: string[]; bookings?: string[]; invites?: Record<string, Date> } = {}): Db {
  return {
    business: { findUnique: async () => ({ kind: 'salon' }) },
    staff: { findMany: async () => staff },
    workSchedule: { findMany: async () => (opts.scheduled ?? []).map((staffId) => ({ staffId })) },
    booking: {
      groupBy: async ({ where }: { where: { staffId: { in: string[] } } }) =>
        (opts.bookings ?? []).filter((id) => where.staffId.in.includes(id)).map((staffId) => ({ staffId, _count: { _all: 1 } })),
    },
    staffInvite: {
      groupBy: async ({ where }: { where: { staffId: { in: string[] } } }) =>
        Object.entries(opts.invites ?? {}).filter(([id]) => where.staffId.in.includes(id)).map(([staffId, createdAt]) => ({ staffId, _min: { createdAt } })),
    },
  } as unknown as Db;
}

const reason = (r: Awaited<ReturnType<typeof computeSeats>>, id: string) => r.seats.find((s) => s.staffId === id)?.reasonKey;

test('ассистент по галочке без услуг, графика и записей — бесплатно; с услугой, графиком или записями — платный мастер', async () => {
  const staff = [
    st('owner', { role: 'owner', serviceIds: [] }),
    st('free', { assistantOnly: true, serviceIds: [] }),
    st('withService', { assistantOnly: true }),
    st('withSchedule', { assistantOnly: true, serviceIds: [] }),
    st('withBookings', { assistantOnly: true, serviceIds: [] }),
    st('ani'),
  ];
  const r = await computeSeats(db(staff, { scheduled: ['withSchedule', 'ani'], bookings: ['withBookings'] }), 'b1', DEFAULT_PRICES);
  assert.equal(reason(r, 'free'), 'assistantFree');
  assert.equal(reason(r, 'withService'), 'assistantWorks');
  assert.equal(reason(r, 'withSchedule'), 'assistantWorks');
  assert.equal(reason(r, 'withBookings'), 'assistantWorks');
  assert.equal(r.paidMasters, 4);
  assert.equal(r.monthlyTotal, 4 * 4000);
});

test('должность «Ассистент…» без галочки места не освобождает', async () => {
  const r = await computeSeats(db([st('owner', { role: 'owner', serviceIds: [] }), st('a'), st('b')]), 'b1', DEFAULT_PRICES);
  assert.equal(reason(r, 'a'), 'master');
  assert.equal(r.monthlyTotal, 8000);
});

test('приглашённый, не вошедший — бесплатно до 14 дней с приглашения, потом платно; минимум 2 мастера', async () => {
  const now = Date.now();
  const staff = [
    st('owner', { role: 'owner', serviceIds: [] }),
    st('fresh', { status: 'invited', userId: null }),
    st('old', { status: 'invited', userId: null }),
  ];
  const r = await computeSeats(db(staff, { invites: { fresh: new Date(now - 3 * DAY), old: new Date(now - (INVITED_FREE_DAYS + 1) * DAY) } }), 'b1', DEFAULT_PRICES);
  assert.equal(reason(r, 'fresh'), 'invitedPending');
  assert.equal(r.seats.find((s) => s.staffId === 'fresh')?.price, 0);
  assert.equal(reason(r, 'old'), 'invitedLong');
  // 1 платный мастер + 1 до минимума = 8 000
  assert.equal(r.paidMasters, 2);
  assert.equal(r.monthlyTotal, 8000);
});

test('приглашённый без строки приглашения — срок от даты добавления', async () => {
  const r = await computeSeats(db([st('owner', { role: 'owner', serviceIds: [] }), st('x', { status: 'invited', userId: null, hiredAt: '2026-01-01' })]), 'b1', DEFAULT_PRICES);
  assert.equal(reason(r, 'x'), 'invitedLong');
});
