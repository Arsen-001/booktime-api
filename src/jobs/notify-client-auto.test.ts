/**
 * ⭐ Автоматические уведомления клиенту (06.10.2026): «Клиент не пришёл» (75), «Зовём вернуться» (72), «Спрашиваем
 * впечатление» (6/20), «С днём рождения» (3), «Пора снова» (55) — кому, когда, каким каналом, настройки бизнеса и клиента,
 * тихие часы, «один раз». База и SMS-провайдер — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { notifyClientEvents, notifyClientDaily } = await import('./notify-client-auto.js');
type Prisma = Parameters<typeof notifyClientEvents>[0];
type Messenger = Parameters<typeof notifyClientEvents>[1];

type Row = Record<string, unknown>;
const OPS = new Set(['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'endsWith']);

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(r, w));
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const ops = Object.keys(v);
      if (!ops.some((o) => OPS.has(o))) return matches(r, v as Row); // составной ключ (businessId_code)
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(cur)) return false;
      if ('not' in o && (o.not === null ? cur === null || cur === undefined : cur === o.not)) return false;
      if ('endsWith' in o && !(typeof cur === 'string' && cur.endsWith(o.endsWith as string))) return false;
      const t = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('gt' in o && !(t(cur) > t(o.gt))) return false;
      if ('gte' in o && !(t(cur) >= t(o.gte))) return false;
      if ('lt' in o && !(t(cur) < t(o.lt))) return false;
      if ('lte' in o && !(t(cur) <= t(o.lte))) return false;
      return true;
    }
    return (cur ?? null) === v;
  });
}

const UNIQUE = new Set(['notifyOutbox', 'notifyLogEntry']);

function memoryPrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { notifyOutbox: [], inboxItem: [], notifyLogEntry: [], ...seed };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (UNIQUE.has(name) && (tables[name] ?? []).some((r) => r.dedupeKey === data.dedupeKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row = name === 'notifyOutbox' ? { status: 'queued', ...data } : { ...data };
      (tables[name] ??= []).push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = (tables[name] ?? []).find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: not found`);
      Object.assign(row, data);
      return row;
    },
  });
  const names = [
    'notifyTypeOverride', 'booking', 'bookingEvent', 'location', 'client', 'user', 'pushToken', 'telegramLink', 'notifyOutbox', 'inboxItem',
    'business', 'staff', 'service', 'businessSetting', 'clientNotifyPref', 'notifyLogEntry', 'starRating', 'staffReview', 'locationReview', 'bookingReminder',
  ];
  return { tables, prisma: Object.fromEntries(names.map((n) => [n, table(n)])) as unknown as Prisma };
}

function fakeMessenger(delivered = true) {
  const sent: { to: string; text: string; channel: string }[] = [];
  const messenger: Messenger = { send: async (m) => (sent.push(m), { delivered }) };
  return { sent, messenger };
}

const NOW = new Date('2026-10-06T08:00:00.000Z'); // 12:00 по Еревану
const H = 3_600_000;
const DAY = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

interface WorldOpts {
  bookings?: Row[];
  events?: Row[];
  overrides?: Row[];
  withApp?: boolean;
  telegram?: boolean;
  client?: Row;
  prefs?: Row;
  sms?: { connected: boolean; channel?: 'sms' | 'whatsapp' };
  services?: Row[];
  stars?: Row[];
  reminders?: Row[];
}

function world(o: WorldOpts = {}) {
  return memoryPrisma({
    notifyTypeOverride: (o.overrides ?? []).map((r) => ({ businessId: 'biz_1', enabled: null, channels: null, templates: null, emailExtra: null, conditions: null, ...r })),
    booking: o.bookings ?? [],
    bookingEvent: o.events ?? [],
    location: [{ id: 'loc_1', businessId: 'biz_1', tz: 'Asia/Yerevan' }],
    client: [{ id: 'cl_1', businessId: 'biz_1', name: 'Анна Петросян', phone: '+37491000001', locale: 'ru', appUserId: o.withApp ? 'us_1' : null, deletedAt: null, purgedAt: null, birthday: null, birthdayGreetingOptOut: null, discountPercent: 0, ...o.client }],
    user: [{ id: 'us_1', phone: o.withApp ? '+37491000001' : '+37499999999', locale: 'ru' }],
    pushToken: o.withApp ? [{ id: 'pt_1', userId: 'us_1', app: 'client', invalidAt: null }] : [],
    telegramLink: o.telegram ? [{ chatId: '777', phone: '+37491000001', blockedAt: null, languageCode: 'hy' }] : [],
    business: [{ id: 'biz_1', name: 'Nuri Nail', brandName: null, slug: 'nuri', leftAt: null }],
    staff: [{ id: 'st_1', name: 'Мари' }, { id: 'st_2', name: 'Лусине' }],
    service: o.services ?? [{ id: 'sv_1', name: { ru: 'Маникюр', en: 'Manicure', hy: 'Մատնահարդարում' }, repeatIntervalDays: null, winbackReminder: null }],
    businessSetting: o.sms ? [{ businessId: 'biz_1', area: 'notify-sms', data: o.sms }] : [],
    clientNotifyPref: o.prefs ? [{ clientId: 'cl_1', marketingOptOut: false, channels: {}, disabledTypeCodes: [], ...o.prefs }] : [],
    starRating: o.stars ?? [],
    staffReview: [],
    locationReview: [],
    bookingReminder: o.reminders ?? [],
  });
}

function booking(extra: Row = {}): Row {
  return {
    id: 'bk_1',
    businessId: 'biz_1',
    locationId: 'loc_1',
    staffId: 'st_1',
    clientId: 'cl_1',
    appUserId: null,
    status: 'no_show',
    services: [{ serviceId: 'sv_1' }],
    source: 'journal',
    deletedAt: null,
    groupEventId: null,
    notifyOverride: null,
    reminderOverride: null,
    startAt: ago(-2 * H),
    endAt: ago(-3 * H),
    ...extra,
  };
}

const ev = (extra: Row): Row => ({ id: `ev_${Math.random().toString(36).slice(2)}`, bookingId: 'bk_1', businessId: 'biz_1', kind: 'status', fromStatus: 'scheduled', toStatus: 'no_show', byRef: 'st_1', at: ago(10 * 60_000), ...extra });

// ─────────── 75 ───────────

test('75: «Не пришёл» до начала визита — пуш клиенту с приложением, строка журнала «отправлено»; повтор ничего не шлёт', async () => {
  const { prisma, tables } = world({ withApp: true, bookings: [booking()], events: [ev({})] });
  const { messenger } = fakeMessenger();
  const res = await notifyClientEvents(prisma, messenger, NOW);
  assert.equal(res.noShow.push, 1);
  const push = tables.notifyOutbox!.find((r) => r.kind === 'client_no_show')!;
  assert.equal(push.app, 'client');
  assert.equal(push.recipientUserId, 'us_1');
  assert.match(String(push.body), /^Nuri Nail: вы не пришли на запись 06\.10 в 14:00\. Будем рады видеть в другой раз: https:\/\/booktime\.am\/b\/nuri\/book$/);
  const log = tables.notifyLogEntry!;
  assert.equal(log.length, 1);
  assert.equal(log[0]!.typeCode, 75);
  assert.equal(log[0]!.channel, 'push');
  assert.equal(log[0]!.status, 'sent');
  assert.equal(log[0]!.bookingId, 'bk_1');
  const again = await notifyClientEvents(prisma, messenger, NOW);
  assert.equal(again.noShow.push, undefined);
  assert.equal(again.noShow.duplicate, 1);
  assert.equal(tables.notifyOutbox!.length, 1);
  assert.equal(tables.notifyLogEntry!.length, 1);
});

test('75: статус после начала визита или запись вернули в работу — ничего', async () => {
  for (const o of [{ b: booking({ startAt: ago(H) }), e: ev({}) }, { b: booking({ status: 'arrived' }), e: ev({}) }]) {
    const { prisma, tables } = world({ withApp: true, bookings: [o.b], events: [o.e] });
    await notifyClientEvents(prisma, fakeMessenger().messenger, NOW);
    assert.equal(tables.notifyOutbox!.length, 0);
    assert.equal(tables.notifyLogEntry!.length, 0);
  }
});

test('75: без приложения — Telegram-бот (на языке чата); без бота и без SMS — «Не доставлено» в журнале', async () => {
  const tg = world({ telegram: true, bookings: [booking()], events: [ev({})] });
  const r1 = await notifyClientEvents(tg.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r1.noShow.telegram, 1);
  const row = tg.tables.notifyOutbox![0]!;
  assert.equal(row.app, 'telegram');
  assert.equal(row.recipientUserId, '777');
  assert.match(String(row.body), /դուք չեկաք գրանցմանը/);
  assert.equal(tg.tables.notifyLogEntry![0]!.channel, 'telegram');

  const none = world({ bookings: [booking()], events: [ev({})] });
  const r2 = await notifyClientEvents(none.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r2.noShow.notDelivered, 1);
  assert.equal(none.tables.notifyOutbox!.length, 0);
  assert.equal(none.tables.notifyLogEntry![0]!.status, 'notDelivered');
  assert.equal(none.tables.notifyLogEntry![0]!.costAmd, 0);
});

test('75: SMS — только если в типе включён сценарий SMS и провайдер подключён; провайдер не доставил — «Не доставлено»', async () => {
  const smsOn = { code: 75, channels: [{ channel: 'push', scenario: 'always' }, { channel: 'sms', scenario: 'fallback' }] };
  // провайдер подключён, но сценарий SMS «Не отправлять» (по умолчанию) — SMS нет
  const off = world({ sms: { connected: true }, bookings: [booking()], events: [ev({})] });
  const m0 = fakeMessenger();
  await notifyClientEvents(off.prisma, m0.messenger, NOW);
  assert.equal(m0.sent.length, 0);

  const on = world({ sms: { connected: true, channel: 'whatsapp' }, overrides: [smsOn], bookings: [booking()], events: [ev({})] });
  const m1 = fakeMessenger();
  const r = await notifyClientEvents(on.prisma, m1.messenger, NOW);
  assert.equal(r.noShow.whatsapp, 1);
  assert.equal(m1.sent.length, 1);
  assert.equal(m1.sent[0]!.channel, 'whatsapp');
  assert.equal(on.tables.notifyLogEntry![0]!.status, 'sent');

  const fail = world({ sms: { connected: true }, overrides: [smsOn], bookings: [booking()], events: [ev({})] });
  const m2 = fakeMessenger(false);
  const r2 = await notifyClientEvents(fail.prisma, m2.messenger, NOW);
  assert.equal(r2.noShow.notDelivered, 1);
  assert.equal(fail.tables.notifyLogEntry![0]!.channel, 'sms');
  assert.equal(fail.tables.notifyLogEntry![0]!.status, 'notDelivered');
  // повторный проход SMS не шлёт второй раз
  await notifyClientEvents(fail.prisma, m2.messenger, NOW);
  assert.equal(m2.sent.length, 1);
});

test('75: тип выключен бизнесом, клиент выключил тип у себя, пуш выключен клиентом — как положено', async () => {
  const off = world({ withApp: true, overrides: [{ code: 75, enabled: false }], bookings: [booking()], events: [ev({})] });
  await notifyClientEvents(off.prisma, fakeMessenger().messenger, NOW);
  assert.equal(off.tables.notifyLogEntry!.length, 0);

  const mine = world({ withApp: true, prefs: { disabledTypeCodes: [75] }, bookings: [booking()], events: [ev({})] });
  await notifyClientEvents(mine.prisma, fakeMessenger().messenger, NOW);
  assert.equal(mine.tables.notifyLogEntry!.length, 0);

  // клиент выключил пуши — пуша нет, уходит в Telegram
  const pushOff = world({ withApp: true, telegram: true, prefs: { channels: { push: false } }, bookings: [booking()], events: [ev({})] });
  const r = await notifyClientEvents(pushOff.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.noShow.telegram, 1);
  assert.equal(pushOff.tables.notifyOutbox!.every((x) => x.app === 'telegram'), true);
});

test('тихие часы 21:00–10:00 по Еревану — проход пропущен целиком', async () => {
  const { prisma, tables } = world({ withApp: true, bookings: [booking()], events: [ev({})] });
  const night = new Date('2026-10-05T19:30:00.000Z'); // 23:30 Ереван
  const res = await notifyClientEvents(prisma, fakeMessenger().messenger, night);
  assert.equal(res.quiet, true);
  const daily = await notifyClientDaily(prisma, fakeMessenger().messenger, night);
  assert.equal(daily.quiet, true);
  assert.equal(tables.notifyLogEntry!.length, 0);
});

// ─────────── 72 ───────────

const inviteOn = (cond: Row = {}) => ({ code: 72, enabled: true, conditions: { inviteAfterHours: 2, inviteStatusFilter: 'all', ...cond } });

test('72: по умолчанию выключен; включён — через N часов после отмены зовём записаться, раньше — нет', async () => {
  const cancelled = booking({ status: 'cancelled_by_client', startAt: ago(-DAY) });
  const def = world({ withApp: true, bookings: [cancelled], events: [ev({ toStatus: 'cancelled_by_client', byRef: 'client', at: ago(3 * H) })] });
  await notifyClientEvents(def.prisma, fakeMessenger().messenger, NOW);
  assert.equal(def.tables.notifyLogEntry!.length, 0);

  const early = world({ withApp: true, overrides: [inviteOn()], bookings: [cancelled], events: [ev({ toStatus: 'cancelled_by_client', byRef: 'client', at: ago(H) })] });
  await notifyClientEvents(early.prisma, fakeMessenger().messenger, NOW);
  assert.equal(early.tables.notifyLogEntry!.length, 0);

  const due = world({ withApp: true, overrides: [inviteOn()], bookings: [cancelled], events: [ev({ toStatus: 'cancelled_by_client', byRef: 'client', at: ago(3 * H) })] });
  const r = await notifyClientEvents(due.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.noShowInvite.push, 1);
  const row = due.tables.notifyOutbox!.find((x) => x.kind === 'noshow_invite')!;
  assert.match(String(row.body), /заметили, что вы не смогли прийти/);
  assert.equal(due.tables.notifyLogEntry![0]!.typeCode, 72);
});

test('72: у клиента есть будущая запись, фильтр статуса, системная отмена, отказ от рекламы — не зовём', async () => {
  const cancelled = booking({ status: 'cancelled_by_client', startAt: ago(-DAY) });
  const e = ev({ toStatus: 'cancelled_by_client', byRef: 'client', at: ago(3 * H) });
  const future = booking({ id: 'bk_2', status: 'scheduled', startAt: ago(-3 * DAY), endAt: ago(-3 * DAY - H) });
  const cases: WorldOpts[] = [
    { overrides: [inviteOn()], bookings: [cancelled, future], events: [e] },
    { overrides: [inviteOn({ inviteStatusFilter: 'noShow' })], bookings: [cancelled], events: [e] },
    { overrides: [inviteOn()], bookings: [booking({ status: 'cancelled_by_master' })], events: [ev({ toStatus: 'cancelled_by_master', byRef: 'system', at: ago(3 * H) })] },
    { overrides: [inviteOn()], bookings: [cancelled], events: [e], prefs: { marketingOptOut: true } },
  ];
  for (const c of cases) {
    const w = world({ withApp: true, ...c });
    await notifyClientEvents(w.prisma, fakeMessenger().messenger, NOW);
    assert.equal(w.tables.notifyLogEntry!.filter((x) => x.typeCode === 72).length, 0);
  }
});

test('72: «Не пришёл» по фильтру «Клиент не пришёл» — зовём; несколько отмен за день — одно приглашение', async () => {
  const b1 = booking({ id: 'bk_1', status: 'no_show', startAt: ago(4 * H) });
  const b2 = booking({ id: 'bk_2', status: 'no_show', startAt: ago(3 * H) });
  const w = world({
    withApp: true,
    overrides: [inviteOn({ inviteStatusFilter: 'noShow' })],
    bookings: [b1, b2],
    events: [ev({ bookingId: 'bk_1', at: ago(3 * H) }), ev({ bookingId: 'bk_2', at: ago(2.5 * H) })],
  });
  const r = await notifyClientEvents(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.noShowInvite.push, 1);
  assert.equal(w.tables.notifyLogEntry!.filter((x) => x.typeCode === 72).length, 1);
});

// ─────────── 6 / 20 ───────────

const visited = (extra: Row = {}) => booking({ status: 'arrived', appUserId: 'us_1', startAt: ago(2 * H), endAt: ago(10 * 60_000), ...extra });
const arrivedEv = (at: Date, bookingId = 'bk_1') => ev({ bookingId, toStatus: 'arrived', at });

test('6/20: через 5 мин после визита «Пришёл» — «понравилось? ★» со ссылкой на запись и строкой ленты; онлайн-запись — тип 6', async () => {
  const w = world({ withApp: true, bookings: [visited({ source: 'app' })], events: [arrivedEv(ago(30 * 60_000))] });
  const r = await notifyClientEvents(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.review.push, 1);
  const push = w.tables.notifyOutbox!.find((x) => x.kind === 'review_request')!;
  assert.equal(push.url, '/bookings/bk_1');
  assert.match(String(push.body), /Оцените ★: https:\/\/booktime\.am\/bookings\/bk_1/);
  assert.equal(w.tables.inboxItem![0]!.kind, 'review_request');
  assert.equal(w.tables.notifyLogEntry![0]!.typeCode, 6);
  // запись из журнала — тип 20, выключили его — не спрашиваем
  const j = world({ withApp: true, overrides: [{ code: 20, enabled: false }], bookings: [visited()], events: [arrivedEv(ago(30 * 60_000))] });
  await notifyClientEvents(j.prisma, fakeMessenger().messenger, NOW);
  assert.equal(j.tables.notifyLogEntry!.length, 0);
});

test('6/20: рано, нет человека приложения, исключённая услуга, ★ мастеру уже стоит, отметка «Пришёл» задним числом — не спрашиваем', async () => {
  const cases: WorldOpts[] = [
    { bookings: [visited({ endAt: ago(2 * 60_000) })], events: [arrivedEv(ago(30 * 60_000))] },
    { bookings: [visited({ appUserId: null })], events: [arrivedEv(ago(30 * 60_000))] },
    { overrides: [{ code: 20, conditions: { reviewDelayMinutes: 5, reviewExcludeServiceIds: ['sv_1'] } }], bookings: [visited()], events: [arrivedEv(ago(30 * 60_000))] },
    { stars: [{ appUserId: 'us_1', staffId: 'st_1', bookingId: 'bk_old' }], bookings: [visited()], events: [arrivedEv(ago(30 * 60_000))] },
    { bookings: [visited({ endAt: ago(2 * DAY) })], events: [arrivedEv(ago(5 * 60_000))] },
  ];
  for (const c of cases) {
    const w = world({ withApp: true, ...c });
    await notifyClientEvents(w.prisma, fakeMessenger().messenger, NOW);
    assert.equal(w.tables.notifyLogEntry!.length, 0, JSON.stringify(c.overrides ?? c.bookings?.[0]));
  }
});

test('6/20: «Пришёл» отметили позже момента (в пределах суток) — спрашиваем при отметке', async () => {
  const w = world({ withApp: true, bookings: [visited({ endAt: ago(5 * H) })], events: [arrivedEv(ago(2 * 60_000))] });
  const r = await notifyClientEvents(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.review.push, 1);
});

test('6/20: уже оценил место — правило «На локацию» (по умолчанию) не спрашивает снова', async () => {
  const w = world({
    withApp: true,
    bookings: [visited(), booking({ id: 'bk_old', status: 'arrived', appUserId: 'us_1', staffId: 'st_2', startAt: ago(40 * DAY), endAt: ago(40 * DAY - H) })],
    events: [arrivedEv(ago(30 * 60_000))],
    stars: [{ appUserId: 'us_1', staffId: 'st_2', bookingId: 'bk_old' }],
  });
  const r = await notifyClientEvents(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.review.push, undefined);
  assert.equal(w.tables.notifyLogEntry!.filter((x) => x.bookingId === 'bk_1').length, 0);
});

// ─────────── 3 ───────────

test('3: в день рождения с 10:00 по поясу филиала — поздравление, строка ленты birthday_greeting; раз в год', async () => {
  const w = world({ withApp: true, client: { birthday: '1990-10-06', discountPercent: 10 } });
  const r = await notifyClientDaily(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.birthday.push, 1);
  const push = w.tables.notifyOutbox!.find((x) => x.kind === 'birthday')!;
  assert.match(String(push.body), /^С днём рождения, Анна! Желаем хорошего настроения/);
  assert.deepEqual(w.tables.inboxItem![0]!.params, { discountPercent: 10 });
  assert.equal(w.tables.notifyLogEntry![0]!.typeCode, 3);
  await notifyClientDaily(w.prisma, fakeMessenger().messenger, new Date(NOW.getTime() + 4 * H));
  assert.equal(w.tables.notifyLogEntry!.length, 1);
});

test('3: время ещё не наступило, «за N дней», 29 февраля, отказ от поздравлений', async () => {
  // 09:30 — по умолчанию шлём с 10:00; тихие часы до 10:00 тоже не дают
  const early = world({ withApp: true, client: { birthday: '1990-10-06' }, overrides: [{ code: 3, conditions: { birthdayMode: 'onDay', birthdayTimeOfDay: '11:00' } }] });
  await notifyClientDaily(early.prisma, fakeMessenger().messenger, new Date('2026-10-06T06:45:00.000Z')); // 10:45
  assert.equal(early.tables.notifyLogEntry!.length, 0);

  const before = world({ withApp: true, client: { birthday: '1990-10-09' }, overrides: [{ code: 3, conditions: { birthdayMode: 'daysBefore', birthdayDaysBefore: 3, birthdayTimeOfDay: '10:00' } }] });
  const r = await notifyClientDaily(before.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.birthday.push, 1);

  const leap = world({ withApp: true, client: { birthday: '2000-02-29' } });
  const r2 = await notifyClientDaily(leap.prisma, fakeMessenger().messenger, new Date('2027-02-28T08:00:00.000Z'));
  assert.equal(r2.birthday.push, 1);

  const optOut = world({ withApp: true, client: { birthday: '1990-10-06', birthdayGreetingOptOut: true } });
  await notifyClientDaily(optOut.prisma, fakeMessenger().messenger, NOW);
  assert.equal(optOut.tables.notifyLogEntry!.length, 0);
});

// ─────────── 55 ───────────

const lastVisit = (daysAgo: number, extra: Row = {}) => booking({ status: 'arrived', startAt: ago(daysAgo * DAY), endAt: ago(daysAgo * DAY - H), ...extra });

test('55 / «Пора снова»: интервал услуги (21 день) наступил — пуш с кнопкой записи к тому же мастеру на ту же услугу', async () => {
  const services = [{ id: 'sv_1', name: { ru: 'Маникюр' }, repeatIntervalDays: 21, winbackReminder: null }];
  const w = world({ withApp: true, services, bookings: [lastVisit(21)] });
  const r = await notifyClientDaily(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.repeat.push, 1);
  const push = w.tables.notifyOutbox!.find((x) => x.kind === 'repeat_invite')!;
  assert.equal(push.url, '/book?staff=st_1&service=sv_1');
  assert.match(String(push.body), /пора снова на «Маникюр»/);
  assert.equal(w.tables.inboxItem![0]!.kind, 'repeat_invite');
  assert.equal(w.tables.inboxItem![0]!.staffId, 'st_1');
  // рано (20 дней) — нет
  const early = world({ withApp: true, services, bookings: [lastVisit(20)] });
  await notifyClientDaily(early.prisma, fakeMessenger().messenger, NOW);
  assert.equal(early.tables.notifyLogEntry!.length, 0);
  // повтор — не дублирует
  await notifyClientDaily(w.prisma, fakeMessenger().messenger, new Date(NOW.getTime() + H));
  assert.equal(w.tables.notifyLogEntry!.length, 1);
});

test('55: уже записался (к тому же мастеру или на ту же услугу), «Не отправлять после визита», срок давно прошёл — не зовём', async () => {
  const sv = (extra: Row = {}) => [{ id: 'sv_1', name: { ru: 'Маникюр' }, repeatIntervalDays: 21, winbackReminder: null, ...extra }];
  const cases: WorldOpts[] = [
    { services: sv(), bookings: [lastVisit(21), booking({ id: 'bk_2', status: 'scheduled', startAt: ago(-2 * DAY), endAt: ago(-2 * DAY - H) })] },
    { services: sv(), bookings: [lastVisit(21), booking({ id: 'bk_2', staffId: 'st_2', status: 'scheduled', startAt: ago(-2 * DAY), endAt: ago(-2 * DAY - H) })] },
    { services: sv({ winbackReminder: 'off' }), bookings: [lastVisit(21)] },
    { services: sv(), bookings: [lastVisit(30)] },
  ];
  for (const c of cases) {
    const w = world({ withApp: true, ...c });
    await notifyClientDaily(w.prisma, fakeMessenger().messenger, NOW);
    assert.equal(w.tables.notifyLogEntry!.length, 0);
  }
  // отменённая новая запись — не считается: зовём
  const w = world({ withApp: true, services: sv(), bookings: [lastVisit(21), booking({ id: 'bk_2', status: 'cancelled_by_client', startAt: ago(-2 * DAY), endAt: ago(-2 * DAY - H) })] });
  const r = await notifyClientDaily(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.repeat.push, 1);
});

test('55: без интервала у услуги — общий срок типа (14 дней); свой срок у записи главнее', async () => {
  const w = world({ withApp: true, bookings: [lastVisit(14)] });
  assert.equal((await notifyClientDaily(w.prisma, fakeMessenger().messenger, NOW)).repeat.push, 1);
  const typed = world({ withApp: true, overrides: [{ code: 55, conditions: { winbackAfterDays: 30 } }], bookings: [lastVisit(14)] });
  assert.equal((await notifyClientDaily(typed.prisma, fakeMessenger().messenger, NOW)).repeat.push, undefined);
  const own = world({ withApp: true, overrides: [{ code: 55, conditions: { winbackAfterDays: 30 } }], bookings: [lastVisit(10)], reminders: [{ bookingId: 'bk_1', revisitInviteDays: 10 }] });
  assert.equal((await notifyClientDaily(own.prisma, fakeMessenger().messenger, NOW)).repeat.push, 1);
});

test('55: два мастера, визиты созрели в один день — одно сообщение с обеими услугами', async () => {
  const services = [
    { id: 'sv_1', name: { ru: 'Маникюр' }, repeatIntervalDays: 21, winbackReminder: null },
    { id: 'sv_2', name: { ru: 'Брови' }, repeatIntervalDays: 21, winbackReminder: null },
  ];
  const w = world({ withApp: true, services, bookings: [lastVisit(21), lastVisit(21, { id: 'bk_2', staffId: 'st_2', services: [{ serviceId: 'sv_2' }], startAt: ago(21 * DAY + H) })] });
  const r = await notifyClientDaily(w.prisma, fakeMessenger().messenger, NOW);
  assert.equal(r.repeat.push, 1);
  assert.match(String(w.tables.notifyOutbox![0]!.body), /«Брови, Маникюр»/);
});
