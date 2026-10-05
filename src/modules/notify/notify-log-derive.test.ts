/**
 * Журнал отправок (вывод строк): тип 73 «Просим подтвердить визит» и тип 1 «Напоминание» — пуш с приложением, Telegram
 * без него (как отправка: jobs/notify-confirm-requests.ts, modules/telegram/telegram-reminders.ts). Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveLogRows, type DBooking, type DClient, type DeriveContext } from './notify-log-derive.js';
import type { NotificationTypeOut } from './notify-rich-types.service.js';
import type { NotifyScenario } from './notify-type-registry.js';

const NOW = '2026-10-05T10:00';

function type73(scenarios: { push?: NotifyScenario; telegram?: NotifyScenario; sms?: NotifyScenario } = {}): NotificationTypeOut {
  const { push = 'always', telegram = 'always', sms = 'off' } = scenarios;
  return {
    id: 't73',
    code: 73,
    recipient: 'client',
    name: { ru: 'Просим подтвердить визит' },
    description: { ru: '' },
    enabled: true,
    availableChannels: ['push', 'telegram', 'email', 'sms', 'brandedApp'],
    channels: [
      { channel: 'push', scenario: push },
      { channel: 'telegram', scenario: telegram },
      { channel: 'sms', scenario: sms },
    ],
    templates: {},
    conditions: { timingHours: 24 },
  } as NotificationTypeOut;
}

function type1(scenarios: { push?: NotifyScenario; telegram?: NotifyScenario; sms?: NotifyScenario } = {}): NotificationTypeOut {
  return { ...type73(scenarios), id: 't1', code: 1, name: { ru: 'Напоминание о визите' }, conditions: { timingHours: 1 } } as NotificationTypeOut;
}

type World = { client?: Partial<DClient>; booking?: Partial<DBooking>; type?: NotificationTypeOut; types?: NotificationTypeOut[]; quietHours?: boolean };

function world(o: World = {}, code = 73) {
  const client: DClient = { id: 'c1', name: 'Анна', phone: '+37491000001', email: null, appUserId: null, birthday: null, ...o.client };
  // Визит завтра в 12:00 — запрос за 24 ч (сегодня 12:00) ещё впереди: строка «Запланировано»
  const booking: DBooking = {
    id: 'b1',
    locationId: 'l1',
    staffId: 's1',
    clientId: client.id,
    start: '2026-10-06T12:00',
    status: 'scheduled',
    serviceIds: [],
    total: 0,
    source: 'admin',
    visitorName: null,
    createdAt: '2026-10-01T09:00',
    deleted: false,
    override: null,
    ...o.booking,
  };
  const ctx: DeriveContext = {
    business: { slug: 'demo', name: 'Demo', phone: '', website: '' },
    locations: new Map(),
    staff: [],
    services: new Map(),
    bookings: new Map([[booking.id, booking]]),
    clients: new Map([[client.id, client]]),
    clientPrefs: new Map(),
    types: o.types ?? [o.type ?? type73()],
    settings: { language: 'ru', dateFormat: '24h', quietHours: { enabled: !!o.quietHours, from: '22:00', to: '09:00' } },
    now: NOW,
    clientsWithFutureBooking: new Set(),
    rebookedAfter: () => false,
  };
  return deriveLogRows(ctx, { events: [], arrived: [], birthdayClients: [], serviceReminderHours: {}, windowFrom: '2026-09-01T00:00' }).filter((r) => r.typeCode === code);
}

/** Строки напоминания (тип 1): только тип 1 в каталоге, если не сказано иначе */
const reminders = (o: World = {}) => world({ types: [type1()], ...o }, 1);
const brief = (rows: ReturnType<typeof world>) => rows.map((r) => `${r.channel}@${r.createdAt}`);

test('тип 73: без приложения, бот подключён — строка Telegram (бесплатно, «Запланировано»)', () => {
  const rows = world({ client: { telegramLinked: true } });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row!.channel, 'telegram');
  assert.equal(row!.costAmd, 0);
  assert.equal(row!.scheduled, true);
  assert.equal(row!.createdAt, '2026-10-05T12:00');
  assert.equal(row!.bookingId, 'b1');
});

test('тип 73: с приложением — пуш, в Telegram не дублируется', () => {
  const rows = world({ client: { appUserId: 'u1', telegramLinked: true } });
  assert.deepEqual(
    rows.map((r) => r.channel),
    ['push'],
  );
});

test('тип 73: без приложения и без бота — строки нет (SMS не шлём, пока сценарий «Не отправлять»)', () => {
  assert.equal(world().length, 0);
});

test('тип 73: Telegram выключен у записи или в типе — строки нет', () => {
  assert.equal(world({ client: { telegramLinked: true }, booking: { override: { telegramEnabled: false } } }).length, 0);
  assert.equal(world({ client: { telegramLinked: true }, type: type73({ telegram: 'off' }) }).length, 0);
});

test('тип 73: без бота, SMS «если не дошло» — уходит SMS (порядок каналов как у мока)', () => {
  const rows = world({ type: type73({ sms: 'fallback' }) });
  assert.deepEqual(
    rows.map((r) => r.channel),
    ['sms'],
  );
});

test('тип 73: только «Записан» — «Ждёт подтверждения» не спрашиваем и в Telegram', () => {
  assert.equal(world({ client: { telegramLinked: true }, booking: { status: 'awaiting_confirmation' } }).length, 0);
});

// ─────────── тип 1: Telegram за 24 ч и за 2 ч (telegram-reminders.ts) ───────────

test('тип 1: без приложения, бот подключён — две строки Telegram: за 24 ч и за 2 ч, бесплатно, текст бота', () => {
  const rows = reminders({ client: { telegramLinked: true } });
  assert.deepEqual(brief(rows), ['telegram@2026-10-05T12:00', 'telegram@2026-10-06T10:00']);
  assert.ok(rows.every((r) => r.costAmd === 0 && r.scheduled === true && r.bookingId === 'b1'));
  assert.notEqual(rows[0]!.key, rows[1]!.key);
  assert.match(rows[0]!.text.ru, /завтра у вас запись/);
  assert.match(rows[1]!.text.ru, /Через 2 часа/);
});

test('тип 1: момент за 24 ч прошёл — строка «отправлено», за 2 ч — «Запланировано»', () => {
  const rows = reminders({ client: { telegramLinked: true }, booking: { start: '2026-10-06T08:00' } });
  assert.deepEqual(brief(rows), ['telegram@2026-10-05T08:00', 'telegram@2026-10-06T06:00']);
  assert.equal(rows[0]!.scheduled, undefined);
  assert.notEqual(rows[0]!.status, 'sending');
  assert.equal(rows[1]!.status, 'sending');
});

test('тип 1: бот не подключён — Telegram нет (без приложения пуш не доходит, SMS «Не отправлять»)', () => {
  assert.deepEqual(brief(reminders()), []);
});

test('тип 1: с приложением — один пуш за время типа, Telegram не дублируется', () => {
  assert.deepEqual(brief(reminders({ client: { appUserId: 'u1', telegramLinked: true } })), ['push@2026-10-06T11:00']);
});

test('тип 1: Telegram выключен у записи или «Не отправлять» в типе — строк Telegram нет', () => {
  assert.deepEqual(brief(reminders({ client: { telegramLinked: true }, booking: { override: { telegramEnabled: false } } })), []);
  assert.deepEqual(brief(reminders({ client: { telegramLinked: true }, types: [type1({ telegram: 'off' })] })), []);
});

test('тип 1: выключатель Telegram у записи — действует обычный порядок каналов (SMS «если не дошло»)', () => {
  const rows = reminders({ client: { telegramLinked: true }, booking: { override: { telegramEnabled: false } }, types: [type1({ sms: 'fallback' })] });
  assert.deepEqual(brief(rows), ['sms@2026-10-06T11:00']);
});

test('тип 1: Telegram — только «Записан» и «Клиент подтвердил», как отправка', () => {
  assert.equal(reminders({ client: { telegramLinked: true }, booking: { status: 'client_confirmed' } }).length, 2);
  assert.deepEqual(brief(reminders({ client: { telegramLinked: true }, booking: { status: 'awaiting_confirmation' } })), []);
});

test('тип 1: запись создана позже момента за 24 ч — уходит только за 2 ч', () => {
  assert.deepEqual(brief(reminders({ client: { telegramLinked: true }, booking: { createdAt: '2026-10-05T13:00' } })), ['telegram@2026-10-06T10:00']);
});

test('тип 1: тихие часы Telegram-напоминание не сдвигают (отправка их не учитывает)', () => {
  const rows = reminders({ client: { telegramLinked: true }, booking: { start: '2026-10-07T08:00' }, quietHours: true });
  assert.deepEqual(brief(rows), ['telegram@2026-10-06T08:00', 'telegram@2026-10-07T06:00']);
});

test('тип 1 + тип 73: запрос подтверждения в Telegram заменяет напоминание за 24 ч, за 2 ч остаётся', () => {
  const o: World = { client: { telegramLinked: true }, types: [type1(), type73()] };
  assert.deepEqual(brief(world(o, 1)), ['telegram@2026-10-06T10:00']);
  assert.deepEqual(brief(world(o, 73)), ['telegram@2026-10-05T12:00']);
  // Запрос за 12 ч — позже напоминания за сутки: оба уходят
  const later = type73();
  later.conditions = { timingHours: 12 };
  assert.deepEqual(brief(world({ ...o, types: [type1(), later] }, 1)), ['telegram@2026-10-05T12:00', 'telegram@2026-10-06T10:00']);
  // «Клиент подтвердил» запроса не получает — напоминание за сутки на месте
  assert.equal(world({ ...o, booking: { status: 'client_confirmed' } }, 1).length, 2);
});
