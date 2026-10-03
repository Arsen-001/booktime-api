/** Тип 73 «Просим подтвердить визит»: кому, когда, каким каналом, выключатели и ключ дубля (база — в памяти). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { enqueueConfirmRequests, confirmRequestAt, confirmConfigOf, confirmTemplateOf } = await import('./notify-confirm-requests.js');
type Prisma = Parameters<typeof enqueueConfirmRequests>[0];

type Row = Record<string, unknown>;
const OPS = new Set(['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte']);

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
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

/** Ровно то подмножество Prisma, которым пользуются задача, bookingCard и очередь */
function memoryPrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { notifyOutbox: [], inboxItem: [], businessSetting: [], ...seed };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (name === 'notifyOutbox' && tables.notifyOutbox!.some((r) => r.dedupeKey === data.dedupeKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row = { status: 'queued', ...data };
      (tables[name] ??= []).push(row);
      return row;
    },
  });
  const names = ['notifyTypeOverride', 'booking', 'location', 'client', 'user', 'pushToken', 'telegramLink', 'notifyOutbox', 'inboxItem', 'business', 'staff', 'service', 'businessSetting'];
  return { tables, prisma: Object.fromEntries(names.map((n) => [n, table(n)])) as unknown as Prisma };
}

const NOW = new Date('2026-10-03T10:00:00.000Z'); // 14:00 по Еревану
const H = 3_600_000;

function world(extra: { booking?: Row; override?: Row | null; withApp?: boolean; telegram?: boolean } = {}) {
  const booking: Row = {
    id: 'bk_1',
    businessId: 'biz_1',
    locationId: 'loc_1',
    staffId: 'st_1',
    clientId: 'cl_1',
    appUserId: null,
    status: 'scheduled',
    deletedAt: null,
    groupEventId: null,
    startAt: new Date(NOW.getTime() + 24 * H),
    createdAt: new Date(NOW.getTime() - 72 * H),
    services: [{ serviceId: 'sv_1' }],
    notifyOverride: null,
    ...extra.booking,
  };
  return memoryPrisma({
    notifyTypeOverride: extra.override ? [{ businessId: 'biz_1', code: 73, enabled: null, channels: null, conditions: null, ...extra.override }] : [],
    booking: [booking],
    location: [{ id: 'loc_1', tz: 'Asia/Yerevan', phone: null }],
    client: [{ id: 'cl_1', phone: '+37491000001', appUserId: extra.withApp ? 'us_1' : null }],
    user: [{ id: 'us_1', phone: '+37491000001', locale: 'ru' }],
    pushToken: extra.withApp ? [{ userId: 'us_1', app: 'client', invalidAt: null }] : [],
    telegramLink: extra.telegram === false ? [] : [{ chatId: '777', phone: '+37491000001', blockedAt: null, languageCode: 'ru' }],
    business: [{ id: 'biz_1', name: 'Nuri Nail', brandName: null, slug: 'nuri', phone: null }],
    staff: [{ id: 'st_1', name: 'Анна', phone: null }],
    service: [{ id: 'sv_1', name: { ru: 'Маникюр', en: 'Manicure' } }],
  });
}

test('момент запроса: за N часов и «в выбранное время» накануне по поясу филиала', () => {
  const start = new Date('2026-10-04T14:00:00.000Z'); // 18:00 Ереван
  assert.equal(confirmRequestAt(start, 'Asia/Yerevan', { timingHours: 24 }).toISOString(), '2026-10-03T14:00:00.000Z');
  assert.equal(confirmRequestAt(start, 'Asia/Yerevan', { timingHours: 3 }).toISOString(), '2026-10-04T11:00:00.000Z');
  // накануне в 14:00 по Еревану = 10:00 UTC, независимо от «за N часов»
  assert.equal(confirmRequestAt(start, 'Asia/Yerevan', { timingHours: 3, useSpecificTime: true, specificTime: '14:00' }).toISOString(), '2026-10-03T10:00:00.000Z');
});

test('настройка: реестр по умолчанию — включён, пуш и Telegram; правка бизнеса поверх', () => {
  assert.deepEqual(confirmConfigOf(null), { enabled: true, push: true, telegram: true, conditions: { timingHours: 24, useSpecificTime: false, specificTime: '14:00' } });
  const c = confirmConfigOf({ enabled: false, channels: [{ channel: 'telegram', scenario: 'off' }], conditions: { timingHours: 6 } });
  assert.equal(c.enabled, false);
  assert.equal(c.push, true);
  assert.equal(c.telegram, false);
  assert.equal(c.conditions.timingHours, 6);
});

test('клиент с приложением: пуш + строка ленты confirm_request, в Telegram ничего; повторный проход не дублирует', async () => {
  const { prisma, tables } = world({ withApp: true });
  const res = await enqueueConfirmRequests(prisma, NOW);
  assert.equal(res.sent, 1);
  const out = tables.notifyOutbox!;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.app, 'client');
  assert.equal(out[0]!.kind, 'confirm_request');
  assert.equal(out[0]!.url, '/bookings/bk_1');
  assert.match(String(out[0]!.body), /Подтвердите визит: Маникюр 04\.10 в 14:00/);
  assert.equal(tables.inboxItem!.length, 1);
  assert.equal(tables.inboxItem![0]!.kind, 'confirm_request');
  assert.equal(tables.inboxItem![0]!.bookingId, 'bk_1');
  assert.equal((await enqueueConfirmRequests(prisma, NOW)).sent, 0);
  assert.equal(tables.notifyOutbox!.length, 1);
});

test('без приложения, с ботом: Telegram с кнопкой «Приду» (c:<id>), напоминание за сутки заменено', async () => {
  const { prisma, tables } = world();
  const res = await enqueueConfirmRequests(prisma, NOW);
  assert.equal(res.sent, 1);
  const tg = tables.notifyOutbox!.find((r) => r.kind === 'confirm_request')!;
  assert.equal(tg.app, 'telegram');
  assert.equal(tg.recipientUserId, '777');
  assert.match(String(tg.body), /Подтвердите, пожалуйста/);
  const keyboard = (tg.meta as { replyMarkup: { inline_keyboard: { callback_data?: string }[][] } }).replyMarkup.inline_keyboard;
  assert.ok(keyboard.flat().some((b) => b.callback_data === 'c:bk_1'), 'кнопка «Приду» → client_confirmed');
  const replaced = tables.notifyOutbox!.find((r) => r.dedupeKey === 'telegram:reminder24h:bk_1:777')!;
  assert.equal(replaced.status, 'skipped');
  assert.equal(replaced.lastError, 'replaced_by_confirm_request');
});

test('напоминание за сутки уже в очереди — не трогаем; без бота и без приложения — ничего', async () => {
  const a = world();
  a.tables.notifyOutbox!.push({ dedupeKey: 'telegram:reminder24h:bk_1:777', status: 'sent', kind: 'reminder24h' });
  await enqueueConfirmRequests(a.prisma, NOW);
  assert.equal(a.tables.notifyOutbox!.filter((r) => r.kind === 'reminder24h').length, 1);
  assert.equal(a.tables.notifyOutbox!.find((r) => r.kind === 'reminder24h')!.status, 'sent');

  const b = world({ telegram: false });
  assert.equal((await enqueueConfirmRequests(b.prisma, NOW)).sent, 0);
  assert.equal(b.tables.notifyOutbox!.length, 0);
});

test('рано, не тот статус, запись создана позже момента — запроса нет', async () => {
  const early = world({ withApp: true, booking: { startAt: new Date(NOW.getTime() + 30 * H) } });
  assert.equal((await enqueueConfirmRequests(early.prisma, NOW)).sent, 0);
  for (const status of ['awaiting_confirmation', 'client_confirmed', 'awaiting_prepayment']) {
    const w = world({ withApp: true, booking: { status } });
    assert.equal((await enqueueConfirmRequests(w.prisma, NOW)).sent, 0, status);
  }
  const late = world({ withApp: true, booking: { startAt: new Date(NOW.getTime() + 20 * H), createdAt: new Date(NOW.getTime() - 2 * H) } });
  assert.equal((await enqueueConfirmRequests(late.prisma, NOW)).sent, 0);
  // Опоздавший проход: момент прошёл, визит ещё впереди — запрос уходит
  const missed = world({ withApp: true, booking: { startAt: new Date(NOW.getTime() + 20 * H) } });
  assert.equal((await enqueueConfirmRequests(missed.prisma, NOW)).sent, 1);
});

test('выключатели: тип выключен, сценарий канала «Не отправлять», выключатель у записи', async () => {
  const off = world({ withApp: true, override: { enabled: false } });
  assert.equal((await enqueueConfirmRequests(off.prisma, NOW)).sent, 0);
  const pushOff = world({ withApp: true, override: { channels: [{ channel: 'push', scenario: 'off' }] } });
  assert.equal((await enqueueConfirmRequests(pushOff.prisma, NOW)).sent, 0, 'с приложением в Telegram не уходит и при выключенном пуше');
  const tgOff = world({ override: { channels: [{ channel: 'telegram', scenario: 'off' }] } });
  assert.equal((await enqueueConfirmRequests(tgOff.prisma, NOW)).sent, 0);
  const bookingPushOff = world({ withApp: true, booking: { notifyOverride: { pushEnabled: false } } });
  assert.equal((await enqueueConfirmRequests(bookingPushOff.prisma, NOW)).sent, 0);
  const bookingTgOff = world({ booking: { notifyOverride: { telegramEnabled: false } } });
  assert.equal((await enqueueConfirmRequests(bookingTgOff.prisma, NOW)).sent, 0);
});

test('условия бизнеса: за 3 часа — сутки до визита ещё рано, за 3 часа — пора', async () => {
  const day = world({ withApp: true, override: { conditions: { timingHours: 3 } } });
  assert.equal((await enqueueConfirmRequests(day.prisma, NOW)).sent, 0);
  const soon = world({ withApp: true, override: { conditions: { timingHours: 3 } }, booking: { startAt: new Date(NOW.getTime() + 3 * H) } });
  assert.equal((await enqueueConfirmRequests(soon.prisma, NOW)).sent, 1);
});

test('перенесённая запись спрашивается заново (ключ — запись + время)', async () => {
  const w = world({ withApp: true });
  await enqueueConfirmRequests(w.prisma, NOW);
  w.tables.booking![0]!.startAt = new Date(NOW.getTime() + 23 * H);
  assert.equal((await enqueueConfirmRequests(w.prisma, NOW)).sent, 1);
});

test('тем же проходом, что напоминание за сутки (окно 10 мин вперёд), — запрос уходит раньше него и заменяет его', async () => {
  const w = world({ booking: { startAt: new Date(NOW.getTime() + 24 * H + 5 * 60_000) } });
  assert.equal((await enqueueConfirmRequests(w.prisma, NOW)).sent, 1);
  assert.ok(w.tables.notifyOutbox!.some((r) => r.dedupeKey === 'telegram:reminder24h:bk_1:777' && r.status === 'skipped'));
});

test('шаблон бизнеса типа 73: язык получателя, запасной русский, пусто — наш текст', () => {
  const templates = { push: { ru: 'Привет {staff}', en: 'Hi {staff}' }, telegram: { ru: '  ' } };
  assert.equal(confirmTemplateOf(templates, 'push', 'en'), 'Hi {staff}');
  assert.equal(confirmTemplateOf(templates, 'push', 'hy'), 'Привет {staff}');
  assert.equal(confirmTemplateOf(templates, 'telegram', 'ru'), undefined);
  assert.equal(confirmTemplateOf(null, 'push', 'ru'), undefined);
});

test('пуш: текст из шаблона бизнеса с переменными, пустая переменная не оставляет «мастер: »', async () => {
  const { prisma, tables } = world({
    withApp: true,
    override: { templates: { push: { ru: '{companyName}: ждём вас {date} в {time} ({service}, мастер: {staff}). Подтвердить: {link}' } } },
  });
  assert.equal((await enqueueConfirmRequests(prisma, NOW)).sent, 1);
  const body = String(tables.notifyOutbox![0]!.body);
  assert.match(body, /^Nuri Nail: ждём вас 04\.10 в 14:00 \(Маникюр, мастер: Анна\)\. Подтвердить: https?:\/\/[^ ]+\/bookings\/bk_1$/);
  assert.doesNotMatch(body, /\{/);

  const noStaff = world({ withApp: true, override: { templates: { push: { ru: 'Ждём вас {date}. Мастер: {master}.' } } } });
  await enqueueConfirmRequests(noStaff.prisma, NOW);
  assert.equal(String(noStaff.tables.notifyOutbox![0]!.body), 'Ждём вас 04.10.');
});

test('Telegram: фраза из шаблона бизнеса (канал telegram), карточка и кнопка «Приду» остаются; шаблон пуша Telegram не трогает', async () => {
  const { prisma, tables } = world({ override: { templates: { telegram: { ru: '{companyName} просит подтвердить визит {date} в {time}' } } } });
  assert.equal((await enqueueConfirmRequests(prisma, NOW)).sent, 1);
  const tg = tables.notifyOutbox!.find((r) => r.kind === 'confirm_request')!;
  assert.match(String(tg.body), /^Nuri Nail просит подтвердить визит 04\.10 в 14:00\n\nNuri Nail\n/);
  assert.doesNotMatch(String(tg.body), /Подтвердите, пожалуйста/);
  const keyboard = (tg.meta as { replyMarkup: { inline_keyboard: { callback_data?: string }[][] } }).replyMarkup.inline_keyboard;
  assert.ok(keyboard.flat().some((b) => b.callback_data === 'c:bk_1'));

  const pushOnly = world({ override: { templates: { push: { ru: 'Только пуш' } } } });
  await enqueueConfirmRequests(pushOnly.prisma, NOW);
  assert.match(String(pushOnly.tables.notifyOutbox!.find((r) => r.kind === 'confirm_request')!.body), /Подтвердите, пожалуйста/);
});
