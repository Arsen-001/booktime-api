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
      const row = name === 'notifyOutbox' ? { status: 'queued', ...data } : name === 'order' ? { readyNotifiedAt: null, issuedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data } : { ...data };
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
  const names = ['order', 'orderCounter', 'business', 'location', 'staff', 'client', 'user', 'pushToken', 'telegramLink', 'notifyOutbox', 'notifyLogEntry', 'inboxItem', 'businessSetting', 'auditEvent'];
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
    business: [{ id: 'biz_1', name: 'Ателье Нарине', brandName: null, phone: '+37410000000', slug: 'narine' }],
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
  assert.deepEqual(Object.keys(pub).sort(), ['business', 'dueDate', 'items', 'number', 'prepaid', 'price', 'readyAt', 'status']);
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
