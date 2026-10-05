/**
 * Пуши персоналу (06.10.2026): о действиях персонала с записью мастера (типы 56/57/42/13/76, staff-notices.ts),
 * «заявка ждёт ответа» (F-00-067, jobs/notify-staff-request-reminders.ts) и «пришёл · сумма / не пришёл» после визита
 * (F-00-127, jobs/notify-staff-visit-mark.ts): кому, настройки, тихие часы, ключ дубля. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { notifyStaffOfStaffAction } = await import('./staff-notices.js');
const { staffRequestReminders, requestReminderTimes, requestReminderInboxEvents } = await import('../../jobs/notify-staff-request-reminders.js');
const { staffVisitMarkPrompts } = await import('../../jobs/notify-staff-visit-mark.js');
type Prisma = Parameters<typeof staffRequestReminders>[0];

type Row = Record<string, unknown>;
const OPS = new Set(['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte']);

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(r, w));
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const ops = Object.keys(v);
      if (!ops.some((o) => OPS.has(o))) return matches(r, v as Row); // составной ключ (businessId_area)
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(cur)) return false;
      if ('not' in o && (o.not === null ? cur === null || cur === undefined : cur === o.not)) return false;
      const t = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('gt' in o && !(t(cur) > t(o.gt))) return false;
      if ('gte' in o && !(t(cur) >= t(o.gte))) return false;
      if ('lt' in o && !(t(cur) < t(o.lt))) return false;
      if ('lte' in o && !(t(cur) <= t(o.lte))) return false;
      return true;
    }
    return cur === v;
  });
}

let seq = 0;
function memoryPrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { notifyOutbox: [], businessSetting: [], notifyTypeOverride: [], ...seed };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (name === 'notifyOutbox' && tables.notifyOutbox!.some((r) => r.dedupeKey === data.dedupeKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      // createdAt — как default(now()) базы, но по часам теста (sendAt = now прохода)
      const row = { status: 'queued', createdAt: data.sendAt ?? new Date(), ...data, id: `nob_${String(++seq).padStart(4, '0')}` };
      (tables[name] ??= []).push(row);
      return row;
    },
  });
  const names = ['notifyOutbox', 'businessSetting', 'notifyTypeOverride', 'staff', 'client', 'service', 'user', 'booking', 'location'];
  return { tables, prisma: Object.fromEntries(names.map((n) => [n, table(n)])) as unknown as Prisma };
}

const NOW = new Date('2026-10-06T10:00:00.000Z'); // 14:00 по Еревану
const MIN = 60_000;
const H = 60 * MIN;
const TZ = 'Asia/Yerevan';

function world(extra: { staff?: Row[]; settings?: Row[]; overrides?: Row[]; bookings?: Row[]; services?: Row[] } = {}) {
  return memoryPrisma({
    staff: extra.staff ?? [
      { id: 'st_master', businessId: 'biz_1', userId: 'us_master', role: 'master', status: 'active', name: 'Анна', pushPrefs: null, deletedAt: null },
      { id: 'st_admin', businessId: 'biz_1', userId: 'us_admin', role: 'admin', status: 'active', name: 'Лусине', pushPrefs: null, deletedAt: null },
      { id: 'st_owner', businessId: 'biz_1', userId: 'us_owner', role: 'owner', status: 'active', name: 'Арам', pushPrefs: null, deletedAt: null },
      { id: 'st_other', businessId: 'biz_1', userId: 'us_other', role: 'master', status: 'active', name: 'Гаяне', pushPrefs: null, deletedAt: null },
    ],
    client: [{ id: 'cl_1', name: 'Мариам' }],
    service: extra.services ?? [{ id: 'sv_1', name: { ru: 'Маникюр' }, kind: 'individual' }],
    user: [
      { id: 'us_master', locale: 'ru' },
      { id: 'us_admin', locale: 'ru' },
      { id: 'us_owner', locale: 'en' },
      { id: 'us_other', locale: 'ru' },
    ],
    location: [{ id: 'loc_1', tz: TZ }],
    businessSetting: extra.settings ?? [],
    notifyTypeOverride: extra.overrides ?? [],
    booking: extra.bookings ?? [],
  });
}

function booking(extra: Row = {}): Row {
  return {
    id: 'bk_1',
    businessId: 'biz_1',
    locationId: 'loc_1',
    staffId: 'st_master',
    clientId: 'cl_1',
    visitorName: null,
    status: 'scheduled',
    deletedAt: null,
    groupEventId: null,
    startAt: new Date(NOW.getTime() + 26 * H), // завтра 16:00 по Еревану
    endAt: new Date(NOW.getTime() + 27 * H),
    createdAt: new Date(NOW.getTime() - H),
    confirmDeadline: null,
    services: [{ serviceId: 'sv_1' }],
    ...extra,
  };
}

const prefs = (staffId: string, data: Row): Row => ({ businessId: 'biz_1', area: `nsp:${staffId}`, data });
type BookingArg = Parameters<typeof notifyStaffOfStaffAction>[1];
const act = (prisma: Prisma, events: Row[], by: string, b: Row = booking()) => notifyStaffOfStaffAction(prisma, b as unknown as BookingArg, events as never, by, TZ, NOW);
const to = (tables: Record<string, Row[]>, userId: string) => tables.notifyOutbox!.filter((r) => r.recipientUserId === userId);

// ─────────────────────────── действия персонала ───────────────────────────

test('администратор записал клиента к мастеру: мастеру «Вам назначена запись» (57), владельцу «Создана запись» (56), автору — ничего', async () => {
  const { prisma, tables } = world();
  const sent = await act(prisma, [{ id: 'ev_1', kind: 'created' }], 'st_admin');
  assert.equal(sent, 2);
  const [m] = to(tables, 'us_master');
  assert.equal(m!.kind, 'staff_assigned');
  assert.equal(m!.app, 'business');
  assert.equal(m!.url, '/biz/journal?date=2026-10-07&booking=bk_1');
  // «Отправлять имя клиента» по умолчанию снята (F-05-057) — без имени, услуга и время есть
  assert.equal(m!.body, 'Вам назначена запись: Маникюр, 07.10 16:00.');
  const [o] = to(tables, 'us_owner');
  assert.equal(o!.kind, 'staff_colleague_booked');
  assert.equal(o!.body, 'Booking created: Маникюр, 07.10 16:00, specialist: Анна.');
  assert.equal(to(tables, 'us_admin').length, 0, 'автору своё действие не шлём');
  assert.equal(to(tables, 'us_other').length, 0, 'чужому мастеру не шлём');
  // повтор того же события — без дублей
  assert.equal(await act(prisma, [{ id: 'ev_1', kind: 'created' }], 'st_admin'), 0);
  assert.equal(tables.notifyOutbox!.length, 2);
});

test('мастер сам записал клиента — себе не шлём; администраторам — «Коллега создал запись»; клиент и ночные серии — не наши', async () => {
  const { prisma, tables } = world();
  await act(prisma, [{ id: 'ev_1', kind: 'created' }], 'st_master');
  assert.equal(to(tables, 'us_master').length, 0);
  assert.equal(to(tables, 'us_admin').length, 1);
  assert.equal(to(tables, 'us_owner').length, 1);
  const w2 = world();
  assert.equal(await act(w2.prisma, [{ id: 'ev_2', kind: 'created' }], 'client'), 0);
  assert.equal(await act(w2.prisma, [{ id: 'ev_3', kind: 'created' }], 'system'), 0);
});

test('перенос, смена мастера, отмена, удаление и неявка — тексты каталога 42/13/76 и «передана другому мастеру»', async () => {
  const { prisma, tables } = world({ settings: [prefs('st_master', { sendClientContacts: true }), prefs('st_other', { sendClientContacts: true })] });
  await act(prisma, [{ id: 'ev_mv', kind: 'moved', prevStart: '2026-10-07T12:00' }], 'st_admin');
  await act(prisma, [{ id: 'ev_cn', kind: 'status', toStatus: 'cancelled_by_master' }], 'st_admin');
  await act(prisma, [{ id: 'ev_dl', kind: 'deleted' }], 'st_admin');
  await act(prisma, [{ id: 'ev_ns', kind: 'status', toStatus: 'no_show' }], 'system', booking({ startAt: new Date(NOW.getTime() - 3 * H) }));
  const bodies = to(tables, 'us_master').map((r) => `${r.kind}: ${r.body}`);
  assert.deepEqual(bodies, [
    'staff_booking_moved: Ваша запись перенесена. Клиент: Мариам. Новое время: 07.10 16:00.',
    'staff_booking_cancelled: Ваша запись отменена. Клиент: Мариам. Время: 07.10 16:00.',
    'staff_booking_cancelled: Ваша запись отменена. Клиент: Мариам. Время: 07.10 16:00.',
    'staff_client_no_show: Клиент не пришёл: Мариам, 06.10 11:00. Время свободно.',
  ]);
  // Запись передали другому мастеру: новому — «назначена», прежнему — «передана другому мастеру»
  const w = world({ settings: [prefs('st_other', { sendClientContacts: true })] });
  await act(w.prisma, [{ id: 'ev_re', kind: 'moved', prevStart: '2026-10-07T16:00', prevStaffId: 'st_master' }], 'st_admin', booking({ staffId: 'st_other' }));
  assert.equal(to(w.tables, 'us_other')[0]!.kind, 'staff_assigned');
  assert.equal(to(w.tables, 'us_master')[0]!.body, 'Ваша запись 07.10 в 16:00 передана другому мастеру.');
});

test('прошедшая запись: созданная задним числом и отменённая — молчим; групповые брони — молчим', async () => {
  const past = booking({ startAt: new Date(NOW.getTime() - 2 * H) });
  const { prisma, tables } = world();
  await act(prisma, [{ id: 'ev_1', kind: 'created' }], 'st_admin', past);
  await act(prisma, [{ id: 'ev_2', kind: 'status', toStatus: 'cancelled_by_master' }], 'st_admin', past);
  await act(prisma, [{ id: 'ev_3', kind: 'created' }], 'st_admin', booking({ groupEventId: 'ge_1' }));
  assert.equal(tables.notifyOutbox!.length, 0);
});

test('настройки: вид «Отключено», строка матрицы без Push, личный выключатель мастера, тип каталога выключен / без канала', async () => {
  const cases: { name: string; seed: Parameters<typeof world>[0] }[] = [
    { name: 'вид off', seed: { settings: [prefs('st_master', { view: 'off' })] } },
    { name: 'матрица', seed: { settings: [prefs('st_master', { matrix: { createdByAdmin: { sms: false, email: false, push: false } } })] } },
    { name: 'тип 57 выключен', seed: { overrides: [{ businessId: 'biz_1', code: 57, enabled: false, channels: null, templates: null }] } },
    { name: 'канал adminApp «Не отправлять»', seed: { overrides: [{ businessId: 'biz_1', code: 57, enabled: null, channels: [{ channel: 'adminApp', scenario: 'off' }], templates: null }] } },
  ];
  for (const c of cases) {
    const { prisma, tables } = world(c.seed);
    await act(prisma, [{ id: 'ev_1', kind: 'created' }], 'st_admin');
    assert.equal(to(tables, 'us_master').length, 0, c.name);
  }
  const personal = world();
  (personal.tables.staff![0] as Row).pushPrefs = { createdByAdmin: false };
  await act(personal.prisma, [{ id: 'ev_1', kind: 'created' }], 'st_admin');
  assert.equal(to(personal.tables, 'us_master').length, 0, 'личный выключатель');
  // Администратору «Для сотрудника» типы «Администратору» (56) не приходят
  const staffView = world({ settings: [prefs('st_owner', { view: 'staff' })] });
  await act(staffView.prisma, [{ id: 'ev_1', kind: 'created' }], 'st_admin');
  assert.equal(to(staffView.tables, 'us_owner').length, 0);
});

test('свой шаблон бизнеса для канала «Приложение администратора» на языке получателя', async () => {
  const { prisma, tables } = world({
    settings: [prefs('st_master', { sendClientContacts: true })],
    overrides: [{ businessId: 'biz_1', code: 42, enabled: null, channels: null, templates: { adminApp: { ru: 'Перенос! {clientName} теперь {date} в {time}' } } }],
  });
  await act(prisma, [{ id: 'ev_1', kind: 'moved', prevStart: '2026-10-07T10:00' }], 'st_admin');
  assert.equal(to(tables, 'us_master')[0]!.body, 'Перенос! Мариам теперь 07.10 в 16:00');
});

// ─────────────────────────── заявка без ответа (F-00-067) ───────────────────────────

function request(extra: Row = {}): Row {
  return booking({ id: 'bk_req', status: 'awaiting_confirmation', createdAt: new Date(NOW.getTime() - 31 * MIN), confirmDeadline: new Date(NOW.getTime() + 50 * MIN), ...extra });
}

test('заявка ждёт 31 мин — мастеру и администраторам «ответьте до HH:MM»; дальше раз в 30 мин, не больше трёх раз', async () => {
  const { prisma, tables } = world({ bookings: [request()] });
  const r1 = await staffRequestReminders(prisma, NOW);
  assert.deepEqual(r1, { sent: 3, bookings: 1 });
  const m = to(tables, 'us_master')[0]!;
  assert.equal(m.kind, 'staff_request_reminder');
  assert.equal(m.dedupeKey, 'staff:req_remind:bk_req:1:us_master');
  assert.equal(m.body, 'Заявка ждёт ответа: Мариам, Маникюр, 07.10 16:00. Ответьте до 14:50.');
  assert.equal(to(tables, 'us_other').length, 0);
  // повтор прохода в ту же минуту и через 10 минут — ничего
  assert.equal((await staffRequestReminders(prisma, NOW)).sent, 0);
  assert.equal((await staffRequestReminders(prisma, new Date(NOW.getTime() + 10 * MIN))).sent, 0);
  // +30 мин — второе, +60 — третье, +90 — больше нет
  assert.equal((await staffRequestReminders(prisma, new Date(NOW.getTime() + 30 * MIN))).sent, 3);
  assert.equal((await staffRequestReminders(prisma, new Date(NOW.getTime() + 60 * MIN))).sent, 3);
  assert.equal((await staffRequestReminders(prisma, new Date(NOW.getTime() + 90 * MIN))).sent, 0);
  assert.equal(to(tables, 'us_master').length, 3);
  // срок ответа прошёл к третьему напоминанию — без «ответьте до»
  assert.equal(to(tables, 'us_master')[2]!.body, 'Заявка всё ещё ждёт ответа: Мариам, Маникюр, 07.10 16:00.');
});

test('заявка моложе 30 мин, визит уже начался, тихие часы — не напоминаем', async () => {
  const young = world({ bookings: [request({ createdAt: new Date(NOW.getTime() - 20 * MIN) })] });
  assert.equal((await staffRequestReminders(young.prisma, NOW)).sent, 0);
  const started = world({ bookings: [request({ startAt: new Date(NOW.getTime() - MIN) })] });
  assert.equal((await staffRequestReminders(started.prisma, NOW)).sent, 0);
  const night = world({ bookings: [request()] });
  const res = await staffRequestReminders(night.prisma, new Date('2026-10-06T19:00:00.000Z')); // 23:00 по Еревану
  assert.equal(res.quiet, true);
  assert.equal(night.tables.notifyOutbox!.length, 0);
});

test('строка «Создание записи клиентом» без Push у мастера — напоминание только администраторам', async () => {
  const { prisma, tables } = world({ bookings: [request()], settings: [prefs('st_master', { matrix: { createdByClient: { sms: false, email: false, push: false } } })] });
  assert.equal((await staffRequestReminders(prisma, NOW)).sent, 2);
  assert.equal(to(tables, 'us_master').length, 0);
});

test('«напомнили в HH:MM» и колокольчик читают очередь; ответили на заявку — строка из колокольчика уходит', async () => {
  const { prisma, tables } = world({ bookings: [request()] });
  await staffRequestReminders(prisma, NOW);
  const later = new Date(NOW.getTime() + 30 * MIN);
  await staffRequestReminders(prisma, later);
  assert.deepEqual(await requestReminderTimes(prisma, 'biz_1', later), { bk_req: '2026-10-06T14:30' });
  const inbox = await requestReminderInboxEvents(prisma, 'biz_1', later);
  assert.equal(inbox.length, 2, 'одна строка на напоминание, не на адресата');
  assert.deepEqual(
    inbox.map((e) => [e.kind, e.bookingId, e.start, e.deadline]),
    [
      ['awaitingReminder', 'bk_req', '2026-10-07T16:00', '2026-10-06T14:50'],
      ['awaitingReminder', 'bk_req', '2026-10-07T16:00', '2026-10-06T14:50'],
    ],
  );
  (tables.booking![0] as Row).status = 'scheduled'; // мастер подтвердил
  assert.equal((await requestReminderInboxEvents(prisma, 'biz_1', later)).length, 0);
  // не дошедшее (skipped — нет токена) «напомнили» не показываем
  for (const r of tables.notifyOutbox!) r.status = 'skipped';
  assert.deepEqual(await requestReminderTimes(prisma, 'biz_1', later), {});
});

// ─────────────────────────── отметка после визита (F-00-127) ───────────────────────────

function visit(extra: Row = {}): Row {
  return booking({ id: 'bk_v', startAt: new Date(NOW.getTime() - 70 * MIN), endAt: new Date(NOW.getTime() - 10 * MIN), ...extra });
}

test('визит закончился — мастеру один пуш «Клиент пришёл?» со ссылкой на запись; повтор прохода не дублирует', async () => {
  const { prisma, tables } = world({ bookings: [visit()] });
  assert.deepEqual(await staffVisitMarkPrompts(prisma, NOW), { sent: 1, candidates: 1 });
  const [m] = tables.notifyOutbox!;
  assert.equal(m!.recipientUserId, 'us_master');
  assert.equal(m!.kind, 'staff_visit_mark');
  assert.equal(m!.url, '/biz/journal?date=2026-10-06&booking=bk_v');
  assert.equal(m!.body, 'Визит в 12:50 закончился (Мариам, Маникюр). Клиент пришёл? Отметьте «пришёл · сумма» или «не пришёл».');
  assert.equal((await staffVisitMarkPrompts(prisma, new Date(NOW.getTime() + 5 * MIN))).sent, 0);
  assert.equal(tables.notifyOutbox!.length, 1);
});

test('отмеченный, ещё идущий, давний визит, сдача заказа, тихие часы, мастер без аккаунта, вид «Отключено» — не спрашиваем', async () => {
  const cases: [string, Parameters<typeof world>[0]][] = [
    ['пришёл', { bookings: [visit({ status: 'arrived' })] }],
    ['не пришёл', { bookings: [visit({ status: 'no_show' })] }],
    ['ещё идёт', { bookings: [visit({ endAt: new Date(NOW.getTime() + 10 * MIN) })] }],
    ['давно', { bookings: [visit({ endAt: new Date(NOW.getTime() - 17 * H) })] }],
    ['сдача заказа', { bookings: [visit()], services: [{ id: 'sv_1', name: { ru: 'Сдача' }, kind: 'intake' }] }],
    ['вид off', { bookings: [visit()], settings: [prefs('st_master', { view: 'off' })] }],
  ];
  for (const [name, seed] of cases) {
    const { prisma, tables } = world(seed);
    await staffVisitMarkPrompts(prisma, NOW);
    assert.equal(tables.notifyOutbox!.length, 0, name);
  }
  const noAccount = world({ bookings: [visit()] });
  (noAccount.tables.staff![0] as Row).userId = null;
  assert.equal((await staffVisitMarkPrompts(noAccount.prisma, NOW)).sent, 0);
  const night = world({ bookings: [visit()] });
  assert.equal((await staffVisitMarkPrompts(night.prisma, new Date('2026-10-06T18:00:00.000Z'))).quiet, true);
  // утром (10:05) про вечерний визит без отметки спросим
  const morning = world({ bookings: [visit({ startAt: new Date('2026-10-06T16:00:00.000Z'), endAt: new Date('2026-10-06T17:00:00.000Z') })] });
  assert.equal((await staffVisitMarkPrompts(morning.prisma, new Date('2026-10-07T06:05:00.000Z'))).sent, 1);
});
