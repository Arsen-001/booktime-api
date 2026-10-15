/**
 * Пуши о записи из logEvents (QA приложений 15.10.2026): у пуша есть data.url — клиенту `/bookings/<id>`, персоналу
 * `/biz/journal?date=…&booking=…`; запись не на сегодня — в тексте день («завтра в 12:00», «16 окт в 12:00»);
 * заголовок пуша персоналу — название бизнеса. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { notifyClientOfBooking, notifyStaffOfClientAction } = await import('./booking-notify.js');
const { whenPhrase } = await import('../../common/i18n/when.js');
type Tx = Parameters<typeof notifyClientOfBooking>[0];
type Booking = Parameters<typeof notifyClientOfBooking>[2]['next'];

type Row = Record<string, unknown>;

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = r[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('in' in o) return (o.in as unknown[]).includes(cur);
      if ('not' in o) return o.not === null ? cur !== null && cur !== undefined : cur !== o.not;
      return matches(r, o);
    }
    return cur === v;
  });
}

function memory(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { notifyOutbox: [], inboxItem: [], businessSetting: [], staffNotifyPref: [], ...seed };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      (tables[name] ??= []).push(data);
      return data;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      (tables[name] ??= []).push(...data);
      return { count: data.length };
    },
  });
  const names = ['notifyOutbox', 'inboxItem', 'businessSetting', 'staffNotifyPref', 'staff', 'client', 'service', 'user', 'business'];
  return { tables, db: Object.fromEntries(names.map((n) => [n, table(n)])) as unknown as Tx };
}

const TZ = 'Asia/Yerevan';
const NOW = new Date('2026-10-15T08:00:00.000Z'); // 12:00 по Еревану, 15 октября

function world() {
  return memory({
    business: [{ id: 'biz_1', name: 'Салон Лилит' }],
    staff: [
      { id: 'st_master', businessId: 'biz_1', userId: 'us_master', role: 'master', status: 'active' },
      { id: 'st_owner', businessId: 'biz_1', userId: 'us_owner', role: 'owner', status: 'active' },
    ],
    client: [{ id: 'cl_1', name: 'Мариам' }],
    service: [{ id: 'sv_1', name: { ru: 'Маникюр' } }],
    user: [
      { id: 'us_client', locale: 'ru' },
      { id: 'us_master', locale: 'ru' },
      { id: 'us_owner', locale: 'en' },
    ],
  });
}

function booking(startAt: Date, extra: Row = {}): Booking {
  return {
    id: 'bk_1',
    businessId: 'biz_1',
    locationId: 'loc_1',
    staffId: 'st_master',
    clientId: 'cl_1',
    appUserId: 'us_client',
    source: 'journal',
    status: 'scheduled',
    services: [{ serviceId: 'sv_1' }],
    startAt,
    ...extra,
  } as unknown as Booking;
}

const event = (b: Booking, kind: string, extra: Row = {}) => ({
  id: `ev_${kind}`,
  bookingId: b.id,
  businessId: b.businessId,
  staffId: b.staffId,
  startLocal: '',
  kind,
  ...extra,
});

const TOMORROW_12 = new Date('2026-10-16T08:00:00.000Z'); // 16.10 12:00 Ереван
const TODAY_18 = new Date('2026-10-15T14:00:00.000Z'); // 15.10 18:00
const LATER_12 = new Date('2026-10-20T08:00:00.000Z'); // 20.10 12:00

test('whenPhrase: сегодня — только время, завтра — «завтра в», дальше — день и месяц; три языка', () => {
  assert.equal(whenPhrase('ru', '2026-10-15T18:00', '2026-10-15'), 'в 18:00');
  assert.equal(whenPhrase('ru', '2026-10-16T12:00', '2026-10-15T23:59'), 'завтра в 12:00');
  assert.equal(whenPhrase('ru', '2026-10-20T12:00', '2026-10-15'), '20 окт в 12:00');
  assert.equal(whenPhrase('ru', '2027-01-03T09:30', '2026-12-30'), '3 янв 2027 в 09:30');
  assert.equal(whenPhrase('en', '2026-10-16T12:00', '2026-10-15'), 'tomorrow at 12:00');
  assert.equal(whenPhrase('en', '2026-10-20T12:00', '2026-10-15'), 'Oct 20 at 12:00');
  assert.equal(whenPhrase('hy', '2026-10-15T18:00', '2026-10-15'), 'ժամը 18:00-ին');
  assert.equal(whenPhrase('hy', '2026-10-16T12:00', '2026-10-15'), 'վաղը՝ ժամը 12:00-ին');
  assert.equal(whenPhrase('hy', '2026-10-20T12:00', '2026-10-15'), 'հոկտեմբերի 20-ին՝ ժամը 12:00-ին');
  // Конец месяца: завтра — 1 ноября
  assert.equal(whenPhrase('ru', '2026-11-01T10:00', '2026-10-31'), 'завтра в 10:00');
});

test('клиенту: салон записал / перенёс / подтвердил / отменил — пуш со ссылкой на запись и днём в тексте', async () => {
  const { db, tables } = world();
  const b = booking(TOMORROW_12);
  const events = [
    event(b, 'created', { startLocal: '2026-10-16T12:00' }),
    event(b, 'moved', { startLocal: '2026-10-16T12:00' }),
    event(b, 'status', { startLocal: '2026-10-16T12:00', fromStatus: 'awaiting_confirmation', toStatus: 'scheduled' }),
    event(b, 'status', { id: 'ev_cancel', startLocal: '2026-10-16T12:00', toStatus: 'cancelled_by_master' }),
  ];
  await notifyClientOfBooking(db, db as never, { next: b, events: events as never, appUserId: 'us_client', by: 'st_owner', tz: TZ, now: NOW });
  const rows = tables.notifyOutbox!;
  assert.deepEqual(rows.map((r) => r.kind), ['booking_created', 'salon_moved', 'salon_confirmed', 'cancelled_by_master']);
  for (const r of rows) {
    assert.equal(r.app, 'client');
    assert.equal(r.url, '/bookings/bk_1');
    assert.equal(r.title, 'Салон Лилит');
    assert.match(String(r.body), /завтра в 12:00/);
  }
  assert.equal(rows[0]!.body, 'Вы записаны: Маникюр завтра в 12:00, Салон Лилит.');
  assert.equal(rows[1]!.body, 'Ваш визит перенесён: теперь завтра в 12:00, Салон Лилит.');
  assert.equal(tables.inboxItem!.length, 4);
});

test('клиенту: запись сегодня — только время; на другой день — дата; удалённая запись — без ссылки', async () => {
  const { db, tables } = world();
  const today = booking(TODAY_18);
  await notifyClientOfBooking(db, db as never, { next: today, events: [event(today, 'created', { startLocal: '2026-10-15T18:00' })] as never, appUserId: 'us_client', by: 'st_owner', tz: TZ, now: NOW });
  assert.equal(tables.notifyOutbox![0]!.body, 'Вы записаны: Маникюр в 18:00, Салон Лилит.');

  const later = booking(LATER_12, { id: 'bk_2' });
  await notifyClientOfBooking(db, db as never, { next: later, events: [event(later, 'moved', { id: 'ev_m2', startLocal: '2026-10-20T12:00' })] as never, appUserId: 'us_client', by: 'st_owner', tz: TZ, now: NOW });
  assert.equal(tables.notifyOutbox![1]!.body, 'Ваш визит перенесён: теперь 20 окт в 12:00, Салон Лилит.');
  assert.equal(tables.notifyOutbox![1]!.url, '/bookings/bk_2');

  await notifyClientOfBooking(db, db as never, { next: later, events: [event(later, 'deleted', { id: 'ev_d2', startLocal: '2026-10-20T12:00' })] as never, appUserId: 'us_client', by: 'st_owner', tz: TZ, now: NOW });
  const deleted = tables.notifyOutbox![2]!;
  assert.equal(deleted.kind, 'salon_deleted');
  assert.equal(deleted.url, undefined);
});

test('клиенту: своё действие клиента (создал/перенёс сам) — без пуша', async () => {
  const { db, tables } = world();
  const b = booking(TOMORROW_12);
  await notifyClientOfBooking(db, db as never, { next: b, events: [event(b, 'created', { startLocal: '2026-10-16T12:00' }), event(b, 'moved', { startLocal: '2026-10-16T12:00' })] as never, appUserId: 'us_client', by: 'client', tz: TZ, now: NOW });
  assert.equal(tables.notifyOutbox!.length, 0);
});

test('персоналу: онлайн-запись клиента — мастеру и владельцу, ссылка на журнал дня записи, заголовок — салон, день в тексте', async () => {
  const { db, tables } = world();
  const b = booking(TOMORROW_12, { source: 'app' });
  await notifyStaffOfClientAction(db, db as never, { next: b, events: [event(b, 'created')] as never, by: 'client', tz: TZ, now: NOW });
  const rows = tables.notifyOutbox!;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.app, 'business');
    assert.equal(r.kind, 'staff_new_booking');
    assert.equal(r.url, '/biz/journal?date=2026-10-16&booking=bk_1');
    assert.equal(r.title, 'Салон Лилит');
  }
  assert.equal(rows.find((r) => r.recipientUserId === 'us_master')!.body, 'Мариам записался(-лась) на Маникюр завтра в 12:00.');
  assert.equal(rows.find((r) => r.recipientUserId === 'us_owner')!.body, 'Мариам booked Маникюр tomorrow at 12:00.');
});

test('персоналу: клиент перенёс и отменил — ссылка и дата; запись сегодня — только время', async () => {
  const { db, tables } = world();
  const later = booking(LATER_12);
  await notifyStaffOfClientAction(db, db as never, { next: later, events: [event(later, 'moved')] as never, by: 'client', tz: TZ, now: NOW });
  const moved = tables.notifyOutbox!.find((r) => r.recipientUserId === 'us_master')!;
  assert.equal(moved.kind, 'staff_client_rescheduled');
  assert.equal(moved.body, 'Мариам перенёс(ла) визит: теперь 20 окт в 12:00.');
  assert.equal(moved.url, '/biz/journal?date=2026-10-20&booking=bk_1');

  const today = booking(TODAY_18, { id: 'bk_t', status: 'cancelled_by_client' });
  await notifyStaffOfClientAction(db, db as never, { next: today, events: [event(today, 'status', { id: 'ev_c', toStatus: 'cancelled_by_client' })] as never, by: 'client', tz: TZ, now: NOW });
  const cancelled = tables.notifyOutbox!.find((r) => r.kind === 'staff_client_cancelled' && r.recipientUserId === 'us_master')!;
  assert.equal(cancelled.body, 'Мариам отменил(а) визит в 18:00.');
  assert.equal(cancelled.url, '/biz/journal?date=2026-10-15&booking=bk_t');
});

test('персоналу: правка самого персонала — не здесь (staff-notices), запись из журнала — без пуша «онлайн»', async () => {
  const { db, tables } = world();
  const b = booking(TOMORROW_12, { source: 'journal' });
  await notifyStaffOfClientAction(db, db as never, { next: b, events: [event(b, 'created'), event(b, 'moved')] as never, by: 'st_owner', tz: TZ, now: NOW });
  assert.equal(tables.notifyOutbox!.length, 0);
});
