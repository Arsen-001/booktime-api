/**
 * ⭐ Честный журнал отправок (06.10.2026): строки — из очереди отправки, статус — настоящий; самописные строки
 * (автоуведомления, разовые, рассылки) получают итог из очереди; выключатели каталога и клиента действуют у отправителя.
 * База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { materializeOutbox, refreshSendingRows, logStatusOf } = await import('./notify-log-outbox.js');
const { CatalogGate } = await import('./catalog-gate.js');
type Db = Parameters<typeof materializeOutbox>[0];

type Row = Record<string, unknown>;
const t = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(r, w));
    const cur = r[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Row;
      if (k === 'businessId_code') return matches(r, o);
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('not' in o && cur === o.not) return false;
      if ('startsWith' in o && !(typeof cur === 'string' && cur.startsWith(o.startsWith as string))) return false;
      if ('gte' in o && !(t(cur) >= t(o.gte))) return false;
      if ('lte' in o && !(t(cur) <= t(o.lte))) return false;
      return true;
    }
    return (cur ?? null) === v;
  });
}

function memoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { notifyLogEntry: [], notifyOutbox: [], notifyTypeOverride: [], clientNotifyPref: [], ...seed };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    createMany: async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const d of data) {
        if ((tables[name] ??= []).some((r) => r.dedupeKey === d.dedupeKey)) continue;
        tables[name]!.push({ ...d });
        count++;
      }
      return { count };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = (tables[name] ?? []).find((r) => matches(r, where))!;
      Object.assign(row, data);
      return row;
    },
  });
  const names = ['notifyLogEntry', 'notifyOutbox', 'user', 'telegramLink', 'booking', 'staff', 'client', 'notifyTypeOverride', 'clientNotifyPref'];
  return { tables, db: Object.fromEntries(names.map((n) => [n, table(n)])) as unknown as Db };
}

const NOW = new Date('2026-10-06T08:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function outbox(extra: Row): Row {
  const id = String(extra.id ?? `ob_${Math.random().toString(36).slice(2, 10)}`);
  return {
    id,
    dedupeKey: `client:x:${id}`,
    businessId: 'biz_1',
    app: 'client',
    kind: 'booking_created',
    recipientUserId: 'us_1',
    title: 'Nuri',
    body: 'Вы записаны на маникюр в 14:00',
    sendAt: ago(5 * MIN),
    createdAt: ago(5 * MIN),
    sentAt: ago(4 * MIN),
    status: 'sent',
    lastError: null,
    meta: { bookingId: 'bk_1', clientId: 'cl_1', typeCode: 8 },
    ...extra,
  };
}

const world = (rows: Row[], extra: Record<string, Row[]> = {}) =>
  memoryDb({
    notifyOutbox: rows,
    user: [
      { id: 'us_1', phone: '+37491000001', locale: 'hy' },
      { id: 'us_admin', phone: '+37491000009', locale: 'ru' },
    ],
    telegramLink: [{ chatId: '777', phone: '+37491000002', languageCode: 'ru' }],
    booking: [{ id: 'bk_1', clientId: 'cl_1', staffId: 'st_1' }],
    staff: [{ id: 'st_admin', businessId: 'biz_1', userId: 'us_admin' }],
    client: [
      { id: 'cl_1', businessId: 'biz_1', phone: '+37491000001', deletedAt: null },
      { id: 'cl_2', businessId: 'biz_1', phone: '+37491000002', deletedAt: null },
    ],
    ...extra,
  });

test('очередь → журнал: тип каталога, канал, получатель, настоящий статус; «Доставлено» не выдумываем', async () => {
  const { db, tables } = world([
    outbox({ id: 'ob_sent' }),
    outbox({ id: 'ob_queued', status: 'queued', sentAt: null, kind: 'salon_moved', meta: { bookingId: 'bk_1', typeCode: 74 } }),
    outbox({ id: 'ob_notoken', status: 'skipped', lastError: 'no_push_token', kind: 'salon_deleted', meta: {} }),
    outbox({ id: 'ob_tg', app: 'telegram', recipientUserId: '777', kind: 'reminder24h', meta: {} }),
    outbox({ id: 'ob_admin', app: 'business', recipientUserId: 'us_admin', kind: 'staff_new_booking', meta: { bookingId: 'bk_1', staffId: 'st_admin', typeCode: 10 } }),
  ]);
  assert.equal(await materializeOutbox(db, 'biz_1', ago(60 * MIN), NOW), 5);
  const by = (id: string) => tables.notifyLogEntry!.find((r) => r.dedupeKey === `ob:${id}`)!;
  assert.deepEqual([by('ob_sent').status, by('ob_sent').typeCode, by('ob_sent').channel, by('ob_sent').contact, by('ob_sent').clientId], ['sent', 8, 'push', '+37491000001', 'cl_1']);
  assert.equal(by('ob_sent').sentLanguage, 'hy');
  assert.deepEqual(by('ob_sent').text, { ru: 'Вы записаны на маникюр в 14:00', hy: 'Вы записаны на маникюр в 14:00' });
  assert.equal(by('ob_queued').status, 'sending');
  assert.equal(by('ob_queued').typeCode, 74);
  assert.equal(by('ob_notoken').status, 'notDelivered');
  assert.equal(by('ob_notoken').typeCode, 4);
  assert.deepEqual([by('ob_tg').channel, by('ob_tg').typeCode, by('ob_tg').clientId], ['telegram', 1, 'cl_2']);
  assert.deepEqual([by('ob_admin').channel, by('ob_admin').typeCode, by('ob_admin').staffId, by('ob_admin').clientId], ['adminApp', 10, 'st_admin', null]);
  assert.ok(tables.notifyLogEntry!.every((r) => r.source === 'outbox' && !['delivered', 'read'].includes(String(r.status))));
  // повтор прохода ничего не дублирует
  assert.equal(await materializeOutbox(db, 'biz_1', ago(60 * MIN), NOW), 0);
});

test('не в журнал: самописные строки, намеренные пропуски, чужой бизнес и платформа', async () => {
  const { db } = world([
    outbox({ dedupeKey: 'auto:75:bk_1:push' }),
    outbox({ dedupeKey: 'oneOff:x1' }),
    outbox({ dedupeKey: 'ml:m1:cl_1' }),
    outbox({ status: 'skipped', lastError: 'type_disabled' }),
    outbox({ status: 'skipped', lastError: 'client_push_off' }),
    outbox({ status: 'skipped', lastError: 'replaced_by_confirm_request', app: 'telegram', recipientUserId: '777' }),
    outbox({ businessId: 'biz_2' }),
    outbox({ businessId: null }),
  ]);
  assert.equal(await materializeOutbox(db, 'biz_1', ago(60 * MIN), NOW), 0);
});

test('«Отправляется» у самописных строк → итог из очереди с тем же ключом', async () => {
  const { db, tables } = world(
    [
      outbox({ dedupeKey: 'auto:75:bk_1:push', status: 'sent' }),
      outbox({ dedupeKey: 'auto:3:cl_1:2026:tg:777', status: 'skipped', lastError: 'telegram_blocked' }),
      outbox({ dedupeKey: 'oneOff:a', status: 'queued' }),
      outbox({ dedupeKey: 'ml:m1:cl_1', status: 'failed', lastError: 'send_failed' }),
      outbox({ dedupeKey: 'ml:m1:cl_2', status: 'sent' }),
    ],
    {
      notifyLogEntry: [
        { id: 'l1', businessId: 'biz_1', dedupeKey: 'auto:75:bk_1', status: 'sending', sentAt: ago(10 * MIN) },
        { id: 'l2', businessId: 'biz_1', dedupeKey: 'auto:3:cl_1:2026', status: 'sending', sentAt: ago(10 * MIN) },
        { id: 'l3', businessId: 'biz_1', dedupeKey: 'oneOff:a', status: 'sending', sentAt: ago(10 * MIN) },
        { id: 'l4', businessId: 'biz_1', dedupeKey: 'ml:m1', status: 'sending', sentAt: ago(10 * MIN) },
        { id: 'l5', businessId: 'biz_1', dedupeKey: 'auto:75:bk_9', status: 'sending', sentAt: ago(10 * MIN) },
      ],
    },
  );
  assert.equal(await refreshSendingRows(db, 'biz_1', NOW), 3);
  const st = (id: string) => tables.notifyLogEntry!.find((r) => r.id === id)!.status;
  assert.deepEqual([st('l1'), st('l2'), st('l3'), st('l4'), st('l5')], ['sent', 'notDelivered', 'sending', 'sent', 'sending']);
});

test('статусы очереди: queued → sending, sent → sent, неудача → notDelivered, намеренный пропуск → не показываем', () => {
  assert.equal(logStatusOf({ status: 'queued', lastError: null }), 'sending');
  assert.equal(logStatusOf({ status: 'sent', lastError: null }), 'sent');
  assert.equal(logStatusOf({ status: 'failed', lastError: 'send_failed' }), 'notDelivered');
  assert.equal(logStatusOf({ status: 'skipped', lastError: 'telegram_blocked' }), 'notDelivered');
  assert.equal(logStatusOf({ status: 'skipped', lastError: 'type_disabled' }), null);
});

test('выключатели каталога и клиента у отправителя очереди: тип выключен, канал «Не отправлять», клиент выключил тип или пуши', async () => {
  const row = (extra: Row = {}) => ({ businessId: 'biz_1', app: 'client', meta: { typeCode: 8, clientId: 'cl_1' }, ...extra });
  const base = memoryDb({});
  assert.equal(await new CatalogGate(base.db as never).check(row()), null);
  // без typeCode («Запись подтверждена», лист ожидания…) — не проверяем
  const off = memoryDb({ notifyTypeOverride: [{ businessId: 'biz_1', code: 8, enabled: false, channels: null, templates: null, emailExtra: null, conditions: null }] });
  assert.equal(await new CatalogGate(off.db as never).check(row()), 'type_disabled');
  assert.equal(await new CatalogGate(off.db as never).check(row({ meta: { clientId: 'cl_1' } })), null);
  const pushOff = memoryDb({
    notifyTypeOverride: [{ businessId: 'biz_1', code: 8, enabled: true, channels: [{ channel: 'push', scenario: 'off' }, { channel: 'brandedApp', scenario: 'off' }], templates: null, emailExtra: null, conditions: null }],
  });
  assert.equal(await new CatalogGate(pushOff.db as never).check(row()), 'type_disabled');
  const adminOff = memoryDb({ notifyTypeOverride: [{ businessId: 'biz_1', code: 10, enabled: true, channels: [{ channel: 'adminApp', scenario: 'off' }], templates: null, emailExtra: null, conditions: null }] });
  assert.equal(await new CatalogGate(adminOff.db as never).check({ businessId: 'biz_1', app: 'business', meta: { typeCode: 10 } }), 'type_disabled');
  const client = (prefs: Row) => memoryDb({ clientNotifyPref: [{ clientId: 'cl_1', marketingOptOut: false, channels: {}, disabledTypeCodes: [], ...prefs }] });
  assert.equal(await new CatalogGate(client({ disabledTypeCodes: [8] }).db as never).check(row()), 'client_type_off');
  assert.equal(await new CatalogGate(client({ channels: { push: false } }).db as never).check(row()), 'client_push_off');
  // «Подписка скоро закончится» (43): выключатель типа и канал «Приложение администратора» действуют
  const t43 = memoryDb({ notifyTypeOverride: [{ businessId: 'biz_1', code: 43, enabled: false, channels: null, templates: null, emailExtra: null, conditions: null }] });
  assert.equal(await new CatalogGate(t43.db as never).check({ businessId: 'biz_1', app: 'business', meta: { typeCode: 43, businessId: 'biz_1' } }), 'type_disabled');
  assert.equal(await new CatalogGate(base.db as never).check({ businessId: 'biz_1', app: 'business', meta: { typeCode: 43 } }), null);
  // Telegram — не пуш: выключенные пуши его не трогают
  assert.equal(await new CatalogGate(client({ channels: { push: false } }).db as never).check(row({ app: 'telegram' })), null);
});
