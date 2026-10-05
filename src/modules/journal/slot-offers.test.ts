/**
 * ⭐ «Найти окно → Предложить» на сервере (06.10.2026): кому уходит, по какому каналу, без повторов, журнал отправок,
 * отметки «Уведомлён», «уже предлагали». База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { offerSlots, previewSlotOffer, listSlotOffers } = await import('./slot-offers.js');
type Db = Parameters<typeof offerSlots>[0];
type Row = Record<string, unknown>;

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(r, w));
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Row;
      if ('in' in o) return (o.in as unknown[]).includes(cur);
      return matches(r, o);
    }
    return cur === v;
  });
}

function memoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { notifyOutbox: [], inboxItem: [], notifyLogEntry: [], businessSetting: [], clientNotifyPref: [], ...seed };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => {
      const w = (where.businessId_area as Row | undefined) ?? where;
      return (tables[name] ?? []).find((r) => matches(r, w)) ?? null;
    },
    create: async ({ data }: { data: Row }) => {
      (tables[name] ??= []).push({ status: name === 'notifyOutbox' ? 'queued' : undefined, ...data });
      return data;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      (tables[name] ??= []).push(...data);
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => Object.assign((tables[name] ?? []).find((r) => matches(r, where))!, data),
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const w = where.businessId_area as Row;
      const row = (tables[name] ?? []).find((r) => matches(r, w));
      if (row) return Object.assign(row, update);
      (tables[name] ??= []).push({ ...create });
      return create;
    },
  });
  const names = ['location', 'staff', 'service', 'waitlistEntry', 'favorite', 'businessSetting', 'business', 'clientNotifyPref', 'user', 'pushToken', 'telegramLink', 'notifyOutbox', 'inboxItem', 'notifyLogEntry'];
  return { tables, db: Object.fromEntries(names.map((n) => [n, table(n)])) as unknown as Db };
}

const NOW = new Date('2026-10-06T08:00:00.000Z'); // 12:00 Ереван
const entry = (extra: Row): Row => ({
  id: 'wl_1',
  businessId: 'biz_1',
  bookingId: null,
  clientName: 'Анна',
  clientPhone: '+37491000001',
  clientId: 'cl_1',
  appUserId: null,
  serviceIds: ['sv_1'],
  staffIds: [],
  wishes: [],
  notifiedTimes: null,
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  ...extra,
});

function world(o: { entries?: Row[]; favorites?: Row[]; promo?: number; prefs?: Row[] } = {}) {
  return memoryDb({
    location: [{ id: 'loc_1', businessId: 'biz_1', tz: 'Asia/Yerevan' }],
    staff: [
      { id: 'st_1', businessId: 'biz_1', name: 'Мари' },
      { id: 'st_2', businessId: 'biz_1', name: 'Лусине' },
    ],
    service: [
      { id: 'sv_1', businessId: 'biz_1', durationMin: 60, name: { ru: 'Маникюр', en: 'Manicure', hy: 'Մատնահարդարում' } },
      { id: 'sv_long', businessId: 'biz_1', durationMin: 120, name: { ru: 'Наращивание' } },
    ],
    waitlistEntry: o.entries ?? [],
    favorite: o.favorites ?? [],
    businessSetting: o.promo ? [{ businessId: 'biz_1', area: 'client-promotion', data: { hotSlotDiscountPercent: o.promo } }] : [],
    business: [{ id: 'biz_1', name: 'Nuri Nail', brandName: null, slug: 'nuri' }],
    clientNotifyPref: o.prefs ?? [],
    user: [
      { id: 'us_1', locale: 'ru' },
      { id: 'us_2', locale: 'hy' },
      { id: 'us_3', locale: 'en' },
    ],
    pushToken: [
      { userId: 'us_1', app: 'client', invalidAt: null },
      { userId: 'us_2', app: 'client', invalidAt: null },
      { userId: 'us_3', app: 'client', invalidAt: null },
    ],
    telegramLink: [{ chatId: '777', phone: '+37491000002', blockedAt: null, languageCode: 'hy' }],
  });
}

const slot = (extra: Row = {}) => ({ staffId: 'st_1', serviceId: 'sv_1', date: '2026-10-06', time: '15:00', freeMin: 60, ...extra }) as never;

test('лист ожидания: приложение — пуш с кнопкой на окно, без приложения — Telegram, иначе «Не доставлено»; отметка «Уведомлён»', async () => {
  const { db, tables } = world({
    entries: [
      entry({ id: 'wl_app', appUserId: 'us_1' }),
      entry({ id: 'wl_tg', clientPhone: '+374 91 000002', clientId: 'cl_2' }),
      entry({ id: 'wl_none', clientPhone: '+37491000003', clientId: 'cl_3' }),
      entry({ id: 'wl_dup', clientPhone: '+37491000003', clientId: 'cl_3' }), // тот же телефон — одно сообщение
      entry({ id: 'wl_other', staffIds: ['st_2'] }), // ждёт другого мастера
      entry({ id: 'wl_long', serviceIds: ['sv_long'], clientPhone: '+37491000004' }), // услуга в окно не помещается
      entry({ id: 'wl_closed', bookingId: 'bk_9', clientPhone: '+37491000005' }),
    ],
  });
  const preview = await previewSlotOffer(db, 'biz_1', [slot()], NOW);
  assert.deepEqual(preview.counts, { waitlist: 3, hot: 0 });
  assert.equal(preview.hotAvailable, true);
  assert.equal(preview.offeredAt, undefined);

  const res = await offerSlots(db, 'biz_1', [slot()], ['waitlist'], NOW);
  assert.equal(res.sent, 3);
  const push = tables.notifyOutbox!.find((r) => r.app === 'client')!;
  assert.equal(push.recipientUserId, 'us_1');
  assert.match(String(push.body), /Освободилось окно у Мари: 06\.10 15:00, Маникюр/);
  assert.equal(push.url, '/book?staff=st_1&slot=2026-10-06T15%3A00&service=sv_1');
  assert.equal(tables.inboxItem![0]!.kind, 'waitlist_slot');
  const tg = tables.notifyOutbox!.find((r) => r.app === 'telegram')!;
  assert.equal(tg.recipientUserId, '777');
  assert.match(String(tg.body), /https:\/\/booktime\.am\/b\/nuri\/book/);
  const log = tables.notifyLogEntry!;
  assert.deepEqual(log.map((r) => [r.channel, r.status]).sort(), [['push', 'notDelivered'], ['push', 'sending'], ['telegram', 'sending']]);
  const notified = tables.waitlistEntry!.filter((e) => e.notifiedAt).map((e) => e.id).sort();
  assert.deepEqual(notified, ['wl_app', 'wl_none', 'wl_tg']);
  // «уже предлагали» — и в превью, и в «Найти окно»
  assert.deepEqual(await listSlotOffers(db, 'biz_1', '2026-10-06'), { 'st_1|15:00': '2026-10-06T12:00' });
  assert.equal((await previewSlotOffer(db, 'biz_1', [slot()], NOW)).offeredAt, '2026-10-06T12:00');
});

test('горящее окно: только сегодня, подписчики мастера и салона без приглушённых, одно сообщение со скидкой; повторов с листом нет', async () => {
  const favorites = [
    { appUserId: 'us_1', targetType: 'staff', targetId: 'st_1', newsMuted: false, createdAt: NOW },
    { appUserId: 'us_2', targetType: 'business', targetId: 'biz_1', newsMuted: false, createdAt: NOW },
    { appUserId: 'us_3', targetType: 'staff', targetId: 'st_2', newsMuted: true, createdAt: NOW },
    { appUserId: 'us_9', targetType: 'business', targetId: 'biz_other', newsMuted: false, createdAt: NOW },
  ];
  const { db, tables } = world({ favorites, promo: 15, entries: [entry({ id: 'wl_app', appUserId: 'us_1' })] });
  const preview = await previewSlotOffer(db, 'biz_1', [slot(), slot({ date: '2026-10-07' })], NOW);
  assert.deepEqual(preview.counts, { waitlist: 1, hot: 1 });
  assert.equal(preview.hotDiscountPercent, 15);
  const res = await offerSlots(db, 'biz_1', [slot(), slot({ time: '17:00', staffId: 'st_2' })], ['waitlist', 'hot'], NOW);
  assert.equal(res.sent, 2);
  const hot = tables.notifyOutbox!.filter((r) => String(r.dedupeKey).startsWith('hotSlot:'));
  assert.equal(hot.length, 1);
  assert.equal(hot[0]!.recipientUserId, 'us_2');
  assert.match(String(hot[0]!.body), /15:00 Մատնահարդարում · Մարի|15:00 Մատնահարդարում · Мари/);
  assert.match(String(hot[0]!.body), /17:00/);
  assert.match(String(hot[0]!.body), /15%/);
  const hotLog = tables.notifyLogEntry!.find((r) => String(r.dedupeKey).startsWith('hotSlot:'))!;
  assert.equal(hotLog.contact, '1');
  assert.equal(res.offers[0]!.hotDiscountPercent, 15);

  // не сегодня — горящего нет
  const tomorrow = world({ favorites });
  const r2 = await offerSlots(tomorrow.db, 'biz_1', [slot({ date: '2026-10-07' })], ['hot'], NOW);
  assert.equal(r2.sent, 0);
  assert.equal(tomorrow.tables.notifyOutbox!.length, 0);
});

test('клиент выключил пуши — в приложение не шлём, остаётся Telegram или «Не доставлено»; чужой мастер — 404', async () => {
  const { db, tables } = world({ entries: [entry({ id: 'wl_app', appUserId: 'us_1' })], prefs: [{ clientId: 'cl_1', channels: { push: false }, disabledTypeCodes: [], marketingOptOut: false }] });
  await offerSlots(db, 'biz_1', [slot()], ['waitlist'], NOW);
  assert.equal(tables.notifyOutbox!.length, 0);
  assert.equal(tables.notifyLogEntry![0]!.status, 'notDelivered');
  await assert.rejects(offerSlots(db, 'biz_1', [slot({ staffId: 'st_x' })], ['waitlist'], NOW), /staff not found/);
});
