/** Заказы (03.10.2026): номер, публичный код, переходы статусов, публичный вид, «готов» клиенту (база — в памяти). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const rules = await import('./order-rules.js');
const { OrdersService, nextOrderNumber, insertOrderWithCode } = await import('./orders.service.js');
const { notifyOrderReady } = await import('./order-notify.js');
const { ordersPickupReminders } = await import('../../jobs/orders-pickup-reminders.js');
const { ordersEstimateReminders } = await import('../../jobs/orders-estimate-reminders.js');
const { ApiError } = await import('../../common/errors/api-error.js');
type Svc = InstanceType<typeof OrdersService>;
type Prisma = ConstructorParameters<typeof OrdersService>[0];

type Row = Record<string, unknown>;
const OPS = new Set(['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte']);

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (!Object.keys(v).some((o) => OPS.has(o))) return matches(r, v as Row); // составной ключ (businessId_area)
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(cur)) return false;
      if ('not' in o && (o.not === null ? cur === null || cur === undefined : cur === o.not)) return false;
      if ('lt' in o && !((cur as number) < (o.lt as number))) return false;
      if ('gte' in o && !((cur as number) >= (o.gte as number))) return false;
      if ('lte' in o && !(cur !== null && cur !== undefined && (cur as number) <= (o.lte as number))) return false;
      return true;
    }
    return cur === v;
  });
}

const dup = () => Object.assign(new Error('dup'), { code: 'P2002', meta: { target: 'orders_code_key' } });

/** Ровно то подмножество Prisma, которым пользуются заказы и очередь уведомлений */
function memoryPrisma(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { order: [], orderCounter: [], notifyOutbox: [], notifyLogEntry: [], inboxItem: [], businessSetting: [], auditEvent: [], ...seed };
  const uniq: Record<string, string[]> = { notifyOutbox: ['dedupeKey'], order: ['code'], orderCounter: ['businessId'] };
  const t = (name: string) => (tables[name] ??= []);
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => t(name).find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => t(name).find((r) => matches(r, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Row }) => {
      const r = t(name).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      return r;
    },
    count: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      for (const k of uniq[name] ?? []) if (t(name).some((r) => r[k] === data[k])) throw dup();
      const row = name === 'notifyOutbox' ? { status: 'queued', ...data } : name === 'order' ? { readyNotifiedAt: null, issuedAt: null, pickupReminderCount: 0, pickupRemindedAt: null, estimate: null, estimateStatus: null, estimateSentAt: null, estimateRemindedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data } : { ...data };
      t(name).push(row);
      return row;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) t(name).push({ ...d });
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = t(name).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? (r[k] as number) + ((v as Row).increment as number) : v;
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = t(name).filter((x) => matches(x, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  });
  const names = ['order', 'orderCounter', 'business', 'location', 'staff', 'client', 'user', 'pushToken', 'telegramLink', 'notifyOutbox', 'notifyLogEntry', 'inboxItem', 'businessSetting', 'auditEvent', 'service', 'booking'];
  const prisma: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, table(n)]));
  prisma.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
  return { tables, prisma: prisma as unknown as Prisma };
}

const audit = { record: async () => undefined } as unknown as ConstructorParameters<typeof OrdersService>[1];
function messengerSpy() {
  const sent: Row[] = [];
  return { sent, messenger: { send: async (m: Row) => (sent.push(m), { delivered: true }) } as unknown as ConstructorParameters<typeof OrdersService>[2] };
}

const ctx = {
  requestId: 'r',
  ip: '127.0.0.1',
  device: 'test',
  session: null,
  member: { businessId: 'biz_1', staffId: 'st_1', role: 'owner', permissions: new Set(['journal.view', 'journal.edit', 'clients.phones']), name: 'Owner', userId: 'au_o', kind: 'salon', networkId: null },
} as unknown as Parameters<Svc['create']>[0];

function world(seed: Record<string, Row[]> = {}) {
  const m = memoryPrisma({
    business: [{ id: 'biz_1', status: 'active', leftAt: null, name: 'Ателье Нарине', brandName: null, phone: '+37410000000', slug: 'narine' }],
    location: [{ id: 'loc_1', businessId: 'biz_1', address: { ru: 'Ереван, Абовяна 1' }, phone: '+37410111111', deletedAt: null, sortOrder: 0 }],
    staff: [{ id: 'st_1', businessId: 'biz_1', deletedAt: null }],
    client: [{ id: 'cl_1', businessId: 'biz_1', phone: '+37400160001', appUserId: null, deletedAt: null }],
    ...seed,
  });
  const spy = messengerSpy();
  return { ...m, ...spy, svc: new OrdersService(m.prisma, audit, spy.messenger) };
}

const BODY = { clientName: 'Ани', clientPhone: '+374 00 160 001', items: [{ title: 'Платье', qty: 1, note: 'укоротить' }], price: 8000, prepaid: 2000, comment: 'ткань тонкая', staffId: 'st_1' };

// ─────────── номер ───────────

test('номер: с 1001 и дальше по одному, у каждого бизнеса свой', async () => {
  const { prisma } = memoryPrisma();
  assert.equal(await nextOrderNumber(prisma, 'biz_a'), 1001);
  assert.equal(await nextOrderNumber(prisma, 'biz_a'), 1002);
  assert.equal(await nextOrderNumber(prisma, 'biz_b'), 1001);
  assert.equal(await nextOrderNumber(prisma, 'biz_a'), 1003);
});

test('номер: гонка двух первых заказов — проигравшая вставка берёт следующий номер', async () => {
  const { prisma, tables } = memoryPrisma();
  // update не нашёл строку (её ещё нет), а пока он думал, сосед вставил 1001 — create падает P2002, повтор update → 1002
  const counter = (prisma as unknown as Record<string, Record<string, unknown>>).orderCounter!;
  const realUpdate = counter.update as (a: unknown) => Promise<Row>;
  let first = true;
  counter.update = async (a: unknown) => {
    if (first) {
      first = false;
      tables.orderCounter!.push({ businessId: 'biz_a', lastNumber: 1001 });
      throw Object.assign(new Error('nf'), { code: 'P2025' });
    }
    return realUpdate(a);
  };
  assert.equal(await nextOrderNumber(prisma, 'biz_a'), 1002);
});

test('создание: номера 1001, 1002 подряд, статус received и первая запись истории', async () => {
  const { svc } = world();
  const a = await svc.create(ctx, 'biz_1', BODY);
  const b = await svc.create(ctx, 'biz_1', { ...BODY, clientName: 'Карен', clientPhone: '099123456' });
  assert.equal(a.number, 1001);
  assert.equal(b.number, 1002);
  assert.equal(a.status, 'received');
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0]!.status, 'received');
  assert.equal(a.history[0]!.by, 'st_1');
  assert.equal(a.clientPhone, '+37400160001');
  assert.equal(a.clientId, 'cl_1', 'номер совпал с клиентом бизнеса — заказ привязан к нему');
  assert.equal(b.clientId, null);
  assert.deepEqual(a.items, [{ title: 'Платье', qty: 1, note: 'укоротить' }]);
});

test('создание: предоплата больше цены и чужой номер — отказ', async () => {
  const { svc } = world();
  await assert.rejects(svc.create(ctx, 'biz_1', { ...BODY, prepaid: 9000 }), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  await assert.rejects(svc.create(ctx, 'biz_1', { ...BODY, clientPhone: '+7 999 123 45 67' }), (e: unknown) => e instanceof ApiError && e.code === 'invalid_phone');
  await assert.rejects(svc.create(ctx, 'biz_1', { ...BODY, staffId: 'st_other' }), (e: unknown) => e instanceof ApiError && e.code === 'staff_not_found');
});

// ─────────── код ───────────

test('код: 10 знаков base62, тысячи кодов без повторов', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const c = rules.newOrderCode();
    assert.match(c, /^[0-9A-Za-z]{10}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 5000);
});

test('код: совпадение с существующим — новая попытка, у заказов разные коды', async () => {
  const { prisma, tables } = memoryPrisma();
  const orderTable = (prisma as unknown as Record<string, Record<string, unknown>>).order!;
  const realCreate = orderTable.create as (a: { data: Row }) => Promise<Row>;
  let calls = 0;
  orderTable.create = async (a: { data: Row }) => {
    calls++;
    if (calls === 1) throw dup(); // первый код «уже занят»
    return realCreate(a);
  };
  const base = { id: 'ord_x', businessId: 'b', number: 1001, clientName: 'A', clientPhone: '+37400000001', items: [], photos: [], status: 'received', price: 0, prepaid: 0, history: [] };
  const row = await insertOrderWithCode(prisma, base as never);
  assert.equal(calls, 2);
  assert.match(row.code, rules.ORDER_CODE_RE);
  assert.equal(tables.order!.length, 1);
});

// ─────────── статусы ───────────

test('переходы: таблица разрешённых и запрещённых', () => {
  const ok: [string, string][] = [
    ['received', 'in_progress'],
    ['received', 'ready'],
    ['received', 'cancelled'],
    ['in_progress', 'ready'],
    ['in_progress', 'cancelled'],
    ['ready', 'issued'],
    ['ready', 'in_progress'],
  ];
  for (const [a, b] of ok) assert.ok(rules.canTransition(a, b), `${a} → ${b}`);
  const bad: [string, string][] = [
    ['received', 'issued'],
    ['received', 'received'],
    ['in_progress', 'received'],
    ['in_progress', 'issued'],
    ['ready', 'cancelled'],
    ['ready', 'received'],
    ['issued', 'ready'],
    ['issued', 'cancelled'],
    ['cancelled', 'received'],
    ['cancelled', 'in_progress'],
  ];
  for (const [a, b] of bad) assert.ok(!rules.canTransition(a, b), `${a} ↛ ${b}`);
});

test('статус: недопустимый переход — 422 invalid_order_transition, заказ не меняется', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', BODY);
  await assert.rejects(svc.setStatus(ctx, 'biz_1', o.id, 'issued'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_order_transition' && e.status === 422);
  assert.equal((await svc.get(ctx, 'biz_1', o.id)).status, 'received');
});

test('статус: цепочка до выдачи — история, readyNotifiedAt, issuedAt; после выдачи — конец', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', BODY);
  await svc.setStatus(ctx, 'biz_1', o.id, 'in_progress');
  const ready = await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  assert.ok(ready.readyNotifiedAt);
  const issued = await svc.setStatus(ctx, 'biz_1', o.id, 'issued');
  assert.ok(issued.issuedAt);
  assert.deepEqual(issued.history.map((h) => h.status), ['received', 'in_progress', 'ready', 'issued']);
  await assert.rejects(svc.setStatus(ctx, 'biz_1', o.id, 'in_progress'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_order_transition');
});

test('чужой бизнес не видит заказ', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', BODY);
  await assert.rejects(svc.get(ctx, 'biz_2', o.id), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});

// ─────────── публичный вид ───────────

test('публичный вид: ни телефона клиента, ни комментария, ни сотрудников', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', BODY);
  const pub = await svc.publicByCode(o.code);
  assert.deepEqual(Object.keys(pub).sort(), ['business', 'dueDate', 'estimate', 'items', 'number', 'pickup', 'prepaid', 'price', 'readyAt', 'status']);
  assert.equal(pub.estimate, null);
  assert.deepEqual(pub.items, [{ title: 'Платье', qty: 1 }], 'заметка к вещи — внутренняя');
  assert.deepEqual(pub.business, { name: 'Ателье Нарине', phone: '+37410111111', address: 'Ереван, Абовяна 1', slug: 'narine' });
  const json = JSON.stringify(pub);
  for (const secret of ['160001', 'ткань тонкая', 'st_1', 'cl_1', o.id, 'укоротить']) assert.ok(!json.includes(secret), `не утекает: ${secret}`);
  assert.equal(pub.readyAt, null);
  await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  assert.ok((await svc.publicByCode(o.code)).readyAt);
});

test('публичный вид: неверный или чужой код — 404', async () => {
  const { svc } = world();
  await assert.rejects(svc.publicByCode('short'), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
  await assert.rejects(svc.publicByCode('AAAAAAAAAA'), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});

test('без права clients.phones телефон — маской, поиск по номеру не находит', async () => {
  const { svc } = world();
  await svc.create(ctx, 'biz_1', BODY);
  const master = { ...ctx, member: { ...ctx.member!, permissions: new Set(['journal.view', 'journal.edit']) } } as typeof ctx;
  const list = await svc.list(master, 'biz_1', { status: 'all', page: 1, pageSize: 50 });
  assert.equal(list.total, 1);
  assert.ok(!list.items[0]!.clientPhone.includes('160001'));
  assert.equal((await svc.list(master, 'biz_1', { status: 'all', q: '160001', page: 1, pageSize: 50 })).total, 0);
  assert.equal((await svc.list(ctx, 'biz_1', { status: 'all', q: '160001', page: 1, pageSize: 50 })).total, 1);
});

test('список: active / статус / поиск по номеру и вещи, новые сверху', async () => {
  const { svc } = world();
  const a = await svc.create(ctx, 'biz_1', BODY);
  const b = await svc.create(ctx, 'biz_1', { ...BODY, items: [{ title: 'iPhone 13 — экран', qty: 1 }], clientName: 'Карен', clientPhone: '099123456' });
  await svc.setStatus(ctx, 'biz_1', a.id, 'cancelled');
  assert.equal((await svc.list(ctx, 'biz_1', { status: 'active', page: 1, pageSize: 50 })).total, 1);
  assert.equal((await svc.list(ctx, 'biz_1', { status: 'cancelled', page: 1, pageSize: 50 })).items[0]!.id, a.id);
  assert.equal((await svc.list(ctx, 'biz_1', { status: 'all', q: 'iphone', page: 1, pageSize: 50 })).items[0]!.id, b.id);
  assert.equal((await svc.list(ctx, 'biz_1', { status: 'all', q: '№1002', page: 1, pageSize: 50 })).items[0]!.id, b.id);
  assert.equal((await svc.list(ctx, 'biz_1', { status: 'all', q: 'карен', page: 1, pageSize: 50 })).total, 1);
});

// ─────────── «готов» клиенту ───────────

test('ready: клиенту с Telegram-ботом — сообщение в очередь со ссылкой /o/<code>, строка журнала', async () => {
  const { svc, tables } = world({ telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'ru', blockedAt: null }] });
  const o = await svc.create(ctx, 'biz_1', BODY);
  await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  const rows = tables.notifyOutbox!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.app, 'telegram');
  assert.equal(rows[0]!.kind, 'order_ready');
  assert.equal(rows[0]!.recipientUserId, '777');
  assert.equal(rows[0]!.body, `Ваш заказ №1001 в «Ателье Нарине» готов. Статус: https://booktime.am/o/${o.code}`);
  assert.equal(tables.notifyLogEntry!.length, 1);
  assert.equal(tables.notifyLogEntry![0]!.status, 'sent');
  // «Напомнить ещё раз» — новое сообщение, а не дубль
  await svc.resendReady(ctx, 'biz_1', o.id);
  assert.equal(rows.length, 2);
});

test('ready: клиенту с приложением — пуш на его языке', async () => {
  const { svc, tables } = world({
    client: [{ id: 'cl_1', businessId: 'biz_1', phone: '+37400160001', appUserId: 'au_1', deletedAt: null }],
    user: [{ id: 'au_1', phone: '+37400160001', locale: 'en' }],
    pushToken: [{ id: 'pt_1', userId: 'au_1', app: 'client', invalidAt: null }],
  });
  const o = await svc.create(ctx, 'biz_1', BODY);
  await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  const push = tables.notifyOutbox!.find((r) => r.app === 'client');
  assert.ok(push);
  assert.equal(push.recipientUserId, 'au_1');
  assert.equal(push.url, `/o/${o.code}`);
  assert.match(String(push.body), /^Your order No\. 1001/);
});

test('ready: некуда слать — успех, «Не доставлено» в журнале; SMS провайдера бизнеса, если подключён', async () => {
  const w1 = world();
  const o1 = await w1.svc.create(ctx, 'biz_1', BODY);
  const r1 = await w1.svc.setStatus(ctx, 'biz_1', o1.id, 'ready');
  assert.equal(r1.status, 'ready');
  assert.equal(w1.tables.notifyOutbox!.length, 0);
  assert.equal(w1.tables.notifyLogEntry![0]!.status, 'notDelivered');

  const w2 = world({ businessSetting: [{ businessId: 'biz_1', area: 'notify-sms', data: { connected: true, channel: 'sms' } }] });
  const o2 = await w2.svc.create(ctx, 'biz_1', BODY);
  await w2.svc.setStatus(ctx, 'biz_1', o2.id, 'ready');
  assert.equal(w2.sent.length, 1);
  assert.equal(w2.sent[0]!.to, '+37400160001');
  assert.equal(w2.tables.notifyLogEntry![0]!.channel, 'sms');
});

test('ready: notifyOrderReady зовётся ровно на переходе в ready и на «напомнить»', async () => {
  const { svc, tables } = world({ telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'hy', blockedAt: null }] });
  const o = await svc.create(ctx, 'biz_1', BODY);
  await svc.setStatus(ctx, 'biz_1', o.id, 'in_progress');
  assert.equal(tables.notifyOutbox!.length, 0, 'в работе — клиенту не пишем');
  await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  assert.equal(tables.notifyOutbox!.length, 1);
  assert.match(String(tables.notifyOutbox![0]!.body), /պատրաստ է/, 'язык чата — армянский');
  await svc.setStatus(ctx, 'biz_1', o.id, 'issued');
  assert.equal(tables.notifyOutbox!.length, 1, 'выдача — без сообщения');
  await assert.rejects(svc.resendReady(ctx, 'biz_1', o.id), (e: unknown) => e instanceof ApiError && e.code === 'order_not_ready' && e.status === 422);
});

test('ready: тип order_ready выключен бизнесом — ничего не шлём', async () => {
  const { prisma, tables } = memoryPrisma({
    businessSetting: [{ businessId: 'biz_1', area: 'notify-types', data: { order_ready: { enabled: false } } }],
    telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'ru', blockedAt: null }],
  });
  const res = await notifyOrderReady(prisma, messengerSpy().messenger, {
    order: { id: 'ord_1', businessId: 'biz_1', number: 1001, code: 'AbCdEfGhIj', clientId: null, clientPhone: '+37400160001', staffId: null },
    businessName: 'X',
    siteUrl: 'https://booktime.am',
  });
  assert.deepEqual(res.channels, []);
  assert.equal(tables.notifyOutbox!.length, 0);
});

test('ordersEnabled: по умолчанию включён у четырёх новых сфер, своё значение важнее', () => {
  for (const s of ['tailor', 'repair', 'drycleaning', 'detailing']) assert.equal(rules.ordersEnabledOf(null, [s]), true, s);
  assert.equal(rules.ordersEnabledOf(null, ['nails']), false);
  assert.equal(rules.ordersEnabledOf(null, ['nails', 'repair']), true);
  assert.equal(rules.ordersEnabledOf(false, ['repair']), false);
  assert.equal(rules.ordersEnabledOf(true, ['nails']), true);
});

// ─────────── «заказ ждёт вас»: напоминание, если не забрали (04.10.2026) ───────────

const DAY = 86_400_000;
/** «Готов» в 12:00 по Еревану (08:00 UTC) — от него считаем 3 и 7 дней; все «сейчас» ниже — днём, вне тихих часов */
const READY_AT = new Date('2026-10-01T08:00:00.000Z');
const after = (ms: number) => new Date(READY_AT.getTime() + ms);

function readyRow(over: Row = {}): Row {
  return {
    id: 'ord_r1',
    businessId: 'biz_1',
    locationId: null,
    number: 1007,
    code: 'AbCdEfGhIj',
    clientId: 'cl_1',
    clientName: 'Ани',
    clientPhone: '+37400160001',
    items: [{ title: 'Платье', qty: 1 }],
    photos: [],
    staffId: 'st_1',
    status: 'ready',
    dueDate: null,
    price: 8000,
    prepaid: 0,
    comment: null,
    history: [
      { at: new Date(READY_AT.getTime() - DAY).toISOString(), status: 'received', by: 'st_1' },
      { at: READY_AT.toISOString(), status: 'ready', by: 'st_1' },
    ],
    readyNotifiedAt: READY_AT,
    issuedAt: null,
    pickupReminderCount: 0,
    pickupRemindedAt: null,
    createdAt: new Date(READY_AT.getTime() - DAY),
    updatedAt: READY_AT,
    ...over,
  };
}

const TG = { telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'ru', blockedAt: null }] };

test('напоминание: сроки 3 и 7 дней, режимы off / 3 / 3_7, только у «Готов»', () => {
  const r = (over: Row = {}) => readyRow(over) as unknown as Parameters<typeof rules.pickupReminderDue>[0];
  assert.equal(rules.pickupReminderDue(r(), '3_7', after(3 * DAY - 60_000)), null, 'ещё нет трёх дней');
  assert.deepEqual(rules.pickupReminderDue(r(), '3_7', after(3 * DAY)), { nextCount: 1 });
  assert.equal(rules.pickupReminderDue(r({ pickupReminderCount: 1 }), '3_7', after(6 * DAY)), null, 'второе — на седьмой день');
  assert.deepEqual(rules.pickupReminderDue(r({ pickupReminderCount: 1 }), '3_7', after(7 * DAY)), { nextCount: 2 });
  assert.equal(rules.pickupReminderDue(r({ pickupReminderCount: 2 }), '3_7', after(30 * DAY)), null, 'больше двух — никогда');
  assert.equal(rules.pickupReminderDue(r({ pickupReminderCount: 1 }), '3', after(8 * DAY)), null, 'режим «3 дня» — одно');
  assert.equal(rules.pickupReminderDue(r(), 'off', after(8 * DAY)), null);
  assert.deepEqual(rules.pickupReminderDue(r(), '3_7', after(8 * DAY)), { nextCount: 2 }, 'воркер лежал — одно сообщение, не два подряд');
  for (const status of ['issued', 'cancelled', 'in_progress', 'received']) assert.equal(rules.pickupReminderDue(r({ status }), '3_7', after(8 * DAY)), null, status);
  // Бизнес сам «Отправить ещё раз» вчера вечером — авто-напоминание ждёт сутки с того раза
  const manual = r({ readyNotifiedAt: after(3 * DAY - 2 * 3_600_000) });
  assert.equal(rules.pickupReminderDue(manual, '3_7', after(3 * DAY)), null);
  assert.deepEqual(rules.pickupReminderDue(manual, '3_7', after(4 * DAY)), { nextCount: 1 });
  assert.equal(rules.pickupReminderModeOf(null), '3_7');
  assert.equal(rules.pickupReminderModeOf('junk'), '3_7');
  assert.equal(rules.pickupReminderModeOf('off'), 'off');
});

test('напоминание: задача шлёт на 3-й и 7-й день, повтор прохода — без дубля', async () => {
  const { prisma, tables, sent } = world({ ...TG, order: [readyRow()] });
  const messenger = messengerSpy().messenger;
  assert.deepEqual(await ordersPickupReminders(prisma, messenger, after(2 * DAY)), { sent: 0, undelivered: 0, quiet: false });
  assert.equal(tables.notifyOutbox!.length, 0);

  const r1 = await ordersPickupReminders(prisma, messenger, after(3 * DAY + 60_000));
  assert.equal(r1.sent, 1);
  const out = tables.notifyOutbox!;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'order_pickup_reminder');
  assert.equal(out[0]!.body, 'Напоминаем: заказ №1007 в «Ателье Нарине» готов и ждёт вас. Статус: https://booktime.am/o/AbCdEfGhIj');
  assert.equal(tables.order![0]!.pickupReminderCount, 1);
  assert.deepEqual(tables.order![0]!.pickupRemindedAt, after(3 * DAY + 60_000));
  assert.deepEqual(tables.notifyLogEntry!.map((e) => (e.typeLabel as { ru: string }).ru), ['Заказ ждёт клиента']);

  // Тот же момент ещё раз (повтор задачи, второй воркер) и через час — ничего нового
  await ordersPickupReminders(prisma, messenger, after(3 * DAY + 60_000));
  await ordersPickupReminders(prisma, messenger, after(3 * DAY + 3_600_000));
  assert.equal(out.length, 1);

  await ordersPickupReminders(prisma, messenger, after(7 * DAY + 60_000));
  assert.equal(out.length, 2);
  assert.equal(tables.order![0]!.pickupReminderCount, 2);
  await ordersPickupReminders(prisma, messenger, after(20 * DAY));
  assert.equal(out.length, 2, 'после второго — тишина');
  assert.equal(sent.length, 0, 'SMS не нужен — есть Telegram');
});

test('напоминание: выданные и отменённые не трогаем, режим «выключено» — тоже', async () => {
  const w = world({
    ...TG,
    order: [readyRow({ id: 'o1', status: 'issued', issuedAt: after(DAY) }), readyRow({ id: 'o2', code: 'BbCdEfGhIj', status: 'cancelled' }), readyRow({ id: 'o3', code: 'CbCdEfGhIj', status: 'in_progress' })],
  });
  await ordersPickupReminders(w.prisma, w.messenger, after(8 * DAY));
  assert.equal(w.tables.notifyOutbox!.length, 0);
  assert.ok(w.tables.order!.every((o) => o.pickupReminderCount === 0));

  const off = world({ ...TG, order: [readyRow()] });
  (off.tables.business![0] as Row).orderPickupReminders = 'off';
  await ordersPickupReminders(off.prisma, off.messenger, after(8 * DAY));
  assert.equal(off.tables.notifyOutbox!.length, 0);

  const one = world({ ...TG, order: [readyRow({ pickupReminderCount: 1 })] });
  (one.tables.business![0] as Row).orderPickupReminders = '3';
  await ordersPickupReminders(one.prisma, one.messenger, after(8 * DAY));
  assert.equal(one.tables.notifyOutbox!.length, 0, 'режим «3 дня» — второго нет');
});

test('напоминание: вид order_pickup_reminder выключен бизнесом — не шлём и не перебираем заказ снова', async () => {
  const { prisma, tables, messenger } = world({
    ...TG,
    order: [readyRow()],
    businessSetting: [{ businessId: 'biz_1', area: 'notify-types', data: { order_pickup_reminder: { enabled: false } } }],
  });
  const res = await ordersPickupReminders(prisma, messenger, after(3 * DAY));
  assert.equal(tables.notifyOutbox!.length, 0);
  assert.equal(tables.notifyLogEntry!.length, 0);
  assert.equal(res.undelivered, 1);
  assert.equal(tables.order![0]!.pickupReminderCount, 1);
});

test('напоминание: тихие часы 21:00–10:00 по Еревану — проход пропущен, утром уходит', async () => {
  const { prisma, tables, messenger } = world({ ...TG, order: [readyRow()] });
  const night = new Date('2026-10-04T19:30:00.000Z'); // 23:30 по Еревану, срок уже наступил
  assert.deepEqual(await ordersPickupReminders(prisma, messenger, night), { sent: 0, undelivered: 0, quiet: true });
  assert.equal(tables.notifyOutbox!.length, 0);
  await ordersPickupReminders(prisma, messenger, new Date('2026-10-05T06:05:00.000Z')); // 10:05
  assert.equal(tables.notifyOutbox!.length, 1);
});

test('напоминание: новый переход в «Готов» обнуляет счётчик — отсчёт заново', async () => {
  const { svc, tables } = world();
  const o = await svc.create(ctx, 'biz_1', BODY);
  await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  const row = tables.order!.find((r) => r.id === o.id)!;
  row.pickupReminderCount = 2;
  row.pickupRemindedAt = new Date();
  await svc.setStatus(ctx, 'biz_1', o.id, 'in_progress');
  const again = await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  assert.equal(again.pickupReminderCount, 0);
  assert.equal(again.pickupRemindedAt, null);
});

// ─────────── ⭐ смета и согласование цены (05.10.2026) ───────────

const DIAG = { ...BODY, items: [{ title: 'iPhone 13 — не включается', qty: 1 }], price: 3000, prepaid: 0, comment: 'диагностика' };
const LINES = [
  { title: 'Замена контроллера питания', price: 18000 },
  { title: 'Работа', price: 7000 },
];

test('смета: отправка — ждём ответа, версия 1, сообщение клиенту со ссылкой и суммой, событие в истории', async () => {
  const { svc, tables } = world(TG);
  const o = await svc.create(ctx, 'biz_1', DIAG);
  const v = await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES, comment: 'Запчасть 2 дня' });
  assert.equal(v.status, 'received', 'статус заказа не меняется, пока клиент не ответил');
  assert.equal(v.price, 3000, 'цена — прежняя до согласия');
  assert.ok(v.estimate);
  assert.equal(v.estimate.status, 'pending');
  assert.equal(v.estimate.version, 1);
  assert.equal(v.estimate.total, 25000);
  assert.equal(v.estimate.comment, 'Запчасть 2 дня');
  const last = v.history.at(-1)!;
  assert.equal(last.event, 'estimate_sent');
  assert.equal(last.amount, 25000);
  const out = tables.notifyOutbox!;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, 'order_estimate');
  assert.equal(out[0]!.body, `Смета по заказу №1001 в «Ателье Нарине»: 25 000 ֏. Согласуйте или откажитесь по ссылке: https://booktime.am/o/${o.code}`);
  assert.equal((tables.notifyLogEntry!.at(-1)!.typeLabel as { ru: string }).ru, 'Смета по заказу');
  // Одна сумма без строк; новая смета — версия 2, снова «ждём»
  const v2 = await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: [], total: 20000, comment: null });
  assert.equal(v2.estimate!.version, 2);
  assert.equal(v2.estimate!.total, 20000);
  assert.deepEqual(v2.estimate!.lines, []);
  assert.equal(out.length, 2);
});

test('смета: нельзя у готового/выданного/отменённого и меньше предоплаты', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', { ...DIAG, prepaid: 3000 });
  await assert.rejects(svc.sendEstimate(ctx, 'biz_1', o.id, { lines: [], total: 2000 }), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  await svc.setStatus(ctx, 'biz_1', o.id, 'ready');
  await assert.rejects(svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES }), (e: unknown) => e instanceof ApiError && e.code === 'order_estimate_not_allowed' && e.status === 422);
});

test('смета: клиент согласен по ссылке — в работу, цена = смета, без утечек, повтор нажатия — без изменений', async () => {
  const { svc, tables } = world();
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES, comment: 'Запчасть 2 дня' });
  const pub = await svc.publicByCode(o.code);
  assert.ok(pub.estimate);
  assert.deepEqual(Object.keys(pub.estimate).sort(), ['clientComment', 'comment', 'decidedAt', 'lines', 'sentAt', 'status', 'total', 'version']);
  const res = await svc.decideEstimatePublic(o.code, 'approve', 1, 'Делайте, спасибо');
  assert.equal(res.status, 'in_progress');
  assert.equal(res.price, 25000);
  assert.equal(res.estimate!.status, 'approved');
  assert.equal(res.estimate!.clientComment, 'Делайте, спасибо');
  const json = JSON.stringify(res);
  for (const secret of ['160001', 'диагностика', 'st_1', 'cl_1', o.id]) assert.ok(!json.includes(secret), `не утекает: ${secret}`);
  const order = await svc.get(ctx, 'biz_1', o.id);
  assert.equal(order.estimate!.decidedBy, 'client');
  const tail = order.history.slice(-2);
  assert.deepEqual(tail.map((h) => [h.event ?? null, h.status, h.by]), [['estimate_approved', 'received', null], [null, 'in_progress', null]]);
  assert.equal(tail[0]!.note, 'Делайте, спасибо');
  // Второе нажатие (двойной тап, второе устройство) — успех, ничего не меняется
  const historyLen = order.history.length;
  const again = await svc.decideEstimatePublic(o.code, 'approve', 1);
  assert.equal(again.estimate!.status, 'approved');
  assert.equal((await svc.get(ctx, 'biz_1', o.id)).history.length, historyLen);
  // А передумать по ссылке уже нельзя
  await assert.rejects(svc.decideEstimatePublic(o.code, 'decline', 1), (e: unknown) => e instanceof ApiError && e.code === 'estimate_already_decided' && e.status === 409);
  assert.equal(tables.order!.length, 1);
});

test('смета: отказ — заказ не в работе, «Выдать без ремонта» из «Принят» разрешено', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await assert.rejects(svc.setStatus(ctx, 'biz_1', o.id, 'issued'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_order_transition');
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
  const res = await svc.decideEstimatePublic(o.code, 'decline', 1, 'Дорого');
  assert.equal(res.status, 'received');
  assert.equal(res.price, 3000, 'цена не меняется — только диагностика');
  assert.equal(res.estimate!.status, 'declined');
  const issued = await svc.setStatus(ctx, 'biz_1', o.id, 'issued');
  assert.equal(issued.status, 'issued');
  assert.ok(rules.canTransition('in_progress', 'issued', 'declined'));
  assert.ok(!rules.canTransition('in_progress', 'issued', 'pending'));
  assert.ok(!rules.canTransition('ready', 'cancelled', 'declined'));
});

test('смета: устаревшая версия — 409 estimate_changed; нет сметы — 409; неверный код — 404', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await assert.rejects(svc.decideEstimatePublic(o.code, 'approve', 1), (e: unknown) => e instanceof ApiError && e.code === 'estimate_not_pending' && e.status === 409);
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: [], total: 30000 });
  await assert.rejects(svc.decideEstimatePublic(o.code, 'approve', 1), (e: unknown) => e instanceof ApiError && e.code === 'estimate_changed');
  assert.equal((await svc.get(ctx, 'biz_1', o.id)).estimate!.status, 'pending');
  await assert.rejects(svc.decideEstimatePublic('short', 'approve', 1), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
  await assert.rejects(svc.decideEstimatePublic('AAAAAAAAAA', 'approve', 1), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
  // Отменённый заказ — ответ не принимается, на публичной странице сметы нет
  await svc.setStatus(ctx, 'biz_1', o.id, 'cancelled');
  await assert.rejects(svc.decideEstimatePublic(o.code, 'approve', 2), (e: unknown) => e instanceof ApiError && e.code === 'estimate_not_pending');
  assert.equal((await svc.publicByCode(o.code)).estimate, null);
});

test('смета: сотрудник отмечает ответ по телефону; «Отправить ещё раз» — только пока ждём', async () => {
  const { svc, tables } = world(TG);
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await assert.rejects(svc.resendEstimate(ctx, 'biz_1', o.id), (e: unknown) => e instanceof ApiError && e.code === 'estimate_not_pending');
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
  await svc.resendEstimate(ctx, 'biz_1', o.id);
  assert.equal(tables.notifyOutbox!.length, 2);
  const v = await svc.decideEstimateByStaff(ctx, 'biz_1', o.id, 'approve', null);
  assert.equal(v.status, 'in_progress');
  assert.equal(v.estimate!.decidedBy, 'staff');
  assert.equal(v.history.at(-2)!.by, 'st_1');
  await assert.rejects(svc.resendEstimate(ctx, 'biz_1', o.id), (e: unknown) => e instanceof ApiError && e.code === 'estimate_not_pending');
});

test('смета: два ответа одновременно — записан ровно один', async () => {
  const { svc } = world();
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
  const results = await Promise.allSettled([svc.decideEstimatePublic(o.code, 'approve', 1), svc.decideEstimatePublic(o.code, 'decline', 1)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1);
  const order = await svc.get(ctx, 'biz_1', o.id);
  assert.equal(order.history.filter((h) => h.event === 'estimate_approved' || h.event === 'estimate_declined').length, 1);
});

test('смета: напоминание через сутки — одно на версию, тихие часы, только пока ждём', async () => {
  const { svc, tables, messenger, prisma } = world(TG);
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
  const row = tables.order!.find((r) => r.id === o.id)!;
  const sentAt = new Date('2026-10-05T08:00:00.000Z'); // 12:00 по Еревану
  row.estimateSentAt = sentAt;
  const at = (ms: number) => new Date(sentAt.getTime() + ms);
  const out = tables.notifyOutbox!;
  const before = out.length;
  assert.deepEqual(await ordersEstimateReminders(prisma, messenger, at(DAY - 60_000)), { sent: 0, undelivered: 0, quiet: false });
  const r1 = await ordersEstimateReminders(prisma, messenger, at(DAY + 60_000));
  assert.equal(r1.sent, 1);
  assert.equal(out.length, before + 1);
  assert.equal(out.at(-1)!.kind, 'order_estimate_reminder');
  assert.equal(out.at(-1)!.body, `«Ателье Нарине» ждёт вашего ответа по смете заказа №1001 (25 000 ֏). Ответить: https://booktime.am/o/${o.code}`);
  await ordersEstimateReminders(prisma, messenger, at(DAY + 3_600_000));
  await ordersEstimateReminders(prisma, messenger, at(3 * DAY));
  assert.equal(out.length, before + 1, 'одно напоминание на версию');
  // Новая версия — новый отсчёт; ночью — пропуск
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: [], total: 20000 });
  row.estimateSentAt = sentAt;
  const n = out.length;
  assert.equal((await ordersEstimateReminders(prisma, messenger, new Date('2026-10-06T18:30:00.000Z'))).quiet, true); // 22:30
  assert.equal(out.length, n);
  await ordersEstimateReminders(prisma, messenger, new Date('2026-10-07T06:30:00.000Z')); // 10:30
  assert.equal(out.length, n + 1);
  // Клиент ответил — больше не напоминаем
  const w = world(TG);
  const o2 = await w.svc.create(ctx, 'biz_1', DIAG);
  await w.svc.sendEstimate(ctx, 'biz_1', o2.id, { lines: LINES });
  await w.svc.decideEstimatePublic(o2.code, 'decline', 1);
  w.tables.order![0]!.estimateSentAt = sentAt;
  const m = w.tables.notifyOutbox!.length;
  await ordersEstimateReminders(w.prisma, w.messenger, at(2 * DAY));
  assert.equal(w.tables.notifyOutbox!.length, m);
  assert.ok(!rules.estimateReminderDue({ status: 'ready', estimateStatus: 'pending', estimateSentAt: sentAt, estimateRemindedAt: null }, at(2 * DAY)), 'заказ уже готов — не напоминаем');
});

test('ссылка заказа бизнеса-черновика или ушедшего с платформы: статус и смета — 404 not_found, ничего не меняется', async () => {
  for (const patch of [{ status: 'draft' }, { leftAt: new Date() }]) {
    const { svc, tables } = world();
    const o = await svc.create(ctx, 'biz_1', DIAG);
    await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
    Object.assign(tables.business![0]!, patch);
    await assert.rejects(svc.publicByCode(o.code), (e: unknown) => e instanceof ApiError && e.code === 'not_found', JSON.stringify(patch));
    await assert.rejects(svc.decideEstimatePublic(o.code, 'approve', 1), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
    assert.equal(tables.order![0]!.estimateStatus, 'pending');
  }
});

test('замороженный бизнес (не оплатил подписку) — вещь клиента у него: статус и смета по ссылке работают', async () => {
  const { svc, tables } = world();
  const o = await svc.create(ctx, 'biz_1', DIAG);
  await svc.sendEstimate(ctx, 'biz_1', o.id, { lines: LINES });
  tables.business![0]!.status = 'frozen';
  assert.equal((await svc.publicByCode(o.code)).number, o.number);
  assert.equal((await svc.decideEstimatePublic(o.code, 'approve', 1)).estimate!.status, 'approved');
});
