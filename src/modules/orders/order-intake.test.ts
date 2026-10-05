/** ⭐ Запись на сдачу по времени (05.10.2026): настройка-услуга «Приём заказа», список дня, «Принять заказ» по записи. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const rules = await import('./order-rules.js');
const { OrderIntakeService } = await import('./order-intake.service.js');
const { OrdersService } = await import('./orders.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

type Row = Record<string, unknown>;
type Prisma = ConstructorParameters<typeof OrdersService>[0];
const OPS = new Set(['in', 'notIn', 'not', 'gte', 'lt']);

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date) && Object.keys(v).some((o) => OPS.has(o))) {
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(cur)) return false;
      if ('not' in o && cur === o.not) return false;
      if ('gte' in o && !((cur as Date) >= (o.gte as Date))) return false;
      if ('lt' in o && !((cur as Date) < (o.lt as Date))) return false;
      return true;
    }
    return cur === v;
  });
}

/** Подмножество Prisma, которым пользуются запись на сдачу и создание заказа */
function memoryPrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { order: [], orderCounter: [], service: [], booking: [], ...seed };
  const uniq: Record<string, string[]> = { order: ['code', 'bookingId'], orderCounter: ['businessId'] };
  const t = (name: string) => (tables[name] ??= []);
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => t(name).find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => t(name).find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      for (const k of uniq[name] ?? []) {
        if (data[k] != null && t(name).some((r) => r[k] === data[k])) throw Object.assign(new Error('dup'), { code: 'P2002', meta: { target: `orders_${k === 'bookingId' ? 'booking_id' : k}_key` } });
      }
      const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
      t(name).push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = t(name).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? ((r[k] as number) ?? 0) + ((v as Row).increment as number) : v;
      return r;
    },
  });
  const names = ['order', 'orderCounter', 'service', 'booking', 'business', 'location', 'staff', 'client'];
  const prisma: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, table(n)]));
  prisma.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
  return { tables, prisma: prisma as unknown as Prisma };
}

const audit = { record: async () => undefined } as unknown as ConstructorParameters<typeof OrdersService>[1];
const messenger = { send: async () => ({ delivered: true }) } as unknown as ConstructorParameters<typeof OrdersService>[2];
const ctx = {
  requestId: 'r',
  member: { businessId: 'biz_1', staffId: 'st_1', role: 'owner', permissions: new Set(['journal.view', 'journal.edit', 'clients.phones', 'settings.manage']) },
} as unknown as Parameters<InstanceType<typeof OrdersService>['create']>[0];

function world(extra: Record<string, Row[]> = {}) {
  const m = memoryPrisma({
    business: [{ id: 'biz_1', sphereIds: ['repair'] }],
    location: [{ id: 'loc_1', businessId: 'biz_1', deletedAt: null }],
    staff: [
      { id: 'st_1', businessId: 'biz_1', deletedAt: null, status: 'active', serviceIds: [] },
      { id: 'st_2', businessId: 'biz_1', deletedAt: null, status: 'active', serviceIds: ['svc_other'] },
      { id: 'st_3', businessId: 'biz_1', deletedAt: null, status: 'fired', serviceIds: [] },
    ],
    client: [{ id: 'cl_1', businessId: 'biz_1', name: 'Ани', phone: '+37400160001', deletedAt: null }],
    ...extra,
  });
  return { ...m, intake: new OrderIntakeService(m.prisma as never, audit as never), orders: new OrdersService(m.prisma, audit, messenger) };
}

// ─────────── правила ───────────

test('правила: длина окна — из списка, иначе ближайшая разрешённая; нет услуги — выключено, 15 мин', () => {
  assert.equal(rules.intakeSlotOf(15), 15);
  assert.equal(rules.intakeSlotOf(25), 20);
  assert.equal(rules.intakeSlotOf(90), 60);
  assert.equal(rules.intakeSlotOf(0), rules.DEFAULT_INTAKE_SLOT_MIN);
  assert.deepEqual(rules.intakeSettingsView(null), { enabled: false, slotMin: 15, staffIds: [], serviceId: null });
  assert.equal(rules.isIntakeBooking([{ serviceId: 'svc_i' }], 'svc_i'), true);
  assert.equal(rules.isIntakeBooking([{ serviceId: 'svc_x' }], 'svc_i'), false);
  assert.equal(rules.isIntakeBooking([{ serviceId: 'svc_i' }], null), false);
});

// ─────────── настройка ───────────

test('настройка: включение создаёт скрытую услугу «Приём заказа» на всех активных сотрудников, в паре со Staff.serviceIds', async () => {
  const { intake, tables } = world();
  const s = await intake.setSettings(ctx, 'biz_1', { enabled: true, slotMin: 20 });
  assert.equal(s.enabled, true);
  assert.equal(s.slotMin, 20);
  assert.deepEqual(s.staffIds, ['st_1', 'st_2'], 'уволенный не принимает');
  const svc = tables.service!.find((x) => x.kind === 'intake')!;
  assert.ok(svc, 'услуга создана');
  assert.equal(svc.durationMin, 20);
  assert.equal(svc.priceMin, 0n);
  assert.equal(svc.active, true);
  assert.equal(svc.onlineBookable, true);
  assert.deepEqual((svc.name as Row).ru, 'Приём заказа');
  assert.deepEqual(tables.staff!.find((x) => x.id === 'st_2')!.serviceIds, ['svc_other', svc.id]);
  assert.deepEqual(tables.staff!.find((x) => x.id === 'st_3')!.serviceIds, []);
});

test('настройка: правка и выключение — та же услуга (не вторая), снятый сотрудник теряет её', async () => {
  const { intake, tables } = world();
  const first = await intake.setSettings(ctx, 'biz_1', { enabled: true, slotMin: 15 });
  const second = await intake.setSettings(ctx, 'biz_1', { enabled: false, slotMin: 30, staffIds: ['st_1'] });
  assert.equal(second.serviceId, first.serviceId);
  assert.equal(tables.service!.filter((x) => x.kind === 'intake').length, 1);
  assert.equal(second.enabled, false);
  assert.equal(second.slotMin, 30);
  assert.deepEqual(second.staffIds, ['st_1']);
  assert.deepEqual(tables.staff!.find((x) => x.id === 'st_2')!.serviceIds, ['svc_other']);
  const svc = tables.service!.find((x) => x.kind === 'intake')!;
  assert.equal(svc.active, false, 'выключено — не видна и не записывает');
  assert.equal(svc.onlineBookable, false);
});

test('настройка: только чужие/уволенные сотрудники — отказ; включить некому — intake_no_staff', async () => {
  const { intake } = world();
  await assert.rejects(intake.setSettings(ctx, 'biz_1', { enabled: true, slotMin: 15, staffIds: ['st_3', 'st_x'] }), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  const empty = world({ staff: [] });
  await assert.rejects(empty.intake.setSettings(ctx, 'biz_1', { enabled: true, slotMin: 15 }), (e: unknown) => e instanceof ApiError && e.code === 'intake_no_staff');
});

// ─────────── список дня и «Принять заказ» ───────────

const INTAKE_SVC: Row = { id: 'svc_i', businessId: 'biz_1', kind: 'intake', active: true, onlineBookable: true, durationMin: 15, staffIds: ['st_1'], createdAt: new Date('2026-01-01') };
const bookingRow = (id: string, startUtc: string, over: Row = {}): Row => ({
  id,
  businessId: 'biz_1',
  locationId: 'loc_1',
  staffId: 'st_1',
  clientId: 'cl_1',
  startAt: new Date(startUtc),
  durationMin: 15,
  status: 'scheduled',
  services: [{ serviceId: 'svc_i', staffId: 'st_1', price: 0, durationMin: 15, qty: 1 }],
  comment: 'iPhone 13 — не заряжается',
  visitorName: null,
  deletedAt: null,
  ...over,
});

test('список дня: только записи на сдачу этого дня (по Еревану), без отменённых; заказ уже принят — номер', async () => {
  const { intake, orders } = world({
    service: [INTAKE_SVC],
    booking: [
      bookingRow('bk_1', '2026-10-05T07:00:00Z'), // 11:00 Ереван
      bookingRow('bk_2', '2026-10-05T09:30:00Z', { status: 'cancelled_by_client' }),
      bookingRow('bk_3', '2026-10-05T10:00:00Z', { services: [{ serviceId: 'svc_other', staffId: 'st_1', price: 5000, durationMin: 60, qty: 1 }] }),
      bookingRow('bk_4', '2026-10-06T07:00:00Z'),
      bookingRow('bk_5', '2026-10-04T21:30:00Z'), // 01:30 5 октября по Еревану
    ],
  });
  await orders.create(ctx, 'biz_1', { clientName: 'Ани', clientPhone: '+37400160001', items: [{ title: 'iPhone 13', qty: 1 }], price: 0, bookingId: 'bk_5' });
  const list = await intake.bookingsOn(ctx, 'biz_1', '2026-10-05');
  assert.deepEqual(list.map((b) => b.bookingId), ['bk_5', 'bk_1']);
  assert.equal(list[1]!.start, '2026-10-05T11:00');
  assert.equal(list[1]!.description, 'iPhone 13 — не заряжается');
  assert.equal(list[1]!.clientName, 'Ани');
  assert.equal(list[1]!.orderId, null);
  assert.equal(list[0]!.orderNumber, 1001);
});

test('список дня: без права clients.phones — номер маской; нет услуги приёма — пусто', async () => {
  const { intake } = world({ service: [INTAKE_SVC], booking: [bookingRow('bk_1', '2026-10-05T07:00:00Z')] });
  const noPhones = { ...ctx, member: { ...(ctx as unknown as { member: Row }).member, permissions: new Set(['journal.view']) } } as unknown as typeof ctx;
  const [row] = await intake.bookingsOn(noPhones, 'biz_1', '2026-10-05');
  assert.notEqual(row!.clientPhone, '+37400160001');
  assert.deepEqual(await world().intake.bookingsOn(ctx, 'biz_1', '2026-10-05'), []);
});

test('«Принять заказ» по записи: мастер и филиал из записи, ссылка bookingId; второй раз — intake_already_accepted', async () => {
  const { orders, tables } = world({ service: [INTAKE_SVC], booking: [bookingRow('bk_1', '2026-10-05T07:00:00Z')], location: [{ id: 'loc_1', businessId: 'biz_1', deletedAt: null }] });
  const body = { clientName: 'Ани', clientPhone: '+37400160001', clientId: 'cl_1', items: [{ title: 'iPhone 13 — не заряжается', qty: 1 }], price: 0, bookingId: 'bk_1' };
  const o = await orders.create(ctx, 'biz_1', body);
  assert.equal(o.bookingId, 'bk_1');
  assert.equal(o.staffId, 'st_1');
  assert.equal(o.locationId, 'loc_1');
  assert.equal(o.status, 'received');
  await assert.rejects(orders.create(ctx, 'biz_1', body), (e: unknown) => e instanceof ApiError && e.code === 'intake_already_accepted');
  assert.equal(tables.order!.length, 1);
  // Мастер выбран в форме явно (или «никто») — главнее записи
  const other = world({ service: [INTAKE_SVC], booking: [bookingRow('bk_1', '2026-10-05T07:00:00Z')] });
  assert.equal((await other.orders.create(ctx, 'biz_1', { ...body, staffId: null })).staffId, null);
});

test('«Принять заказ»: гонка двух нажатий — уникальный booking_id превращается в intake_already_accepted', async () => {
  const { orders, tables } = world({ service: [INTAKE_SVC], booking: [bookingRow('bk_1', '2026-10-05T07:00:00Z')] });
  // Проверка «уже принят» прошла у обоих, а сосед успел вставить заказ раньше
  const orderTable = (orders as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma.order!;
  const realFindFirst = orderTable.findFirst as (a: unknown) => Promise<Row | null>;
  orderTable.findFirst = async () => null;
  tables.order!.push({ id: 'ord_other', businessId: 'biz_1', code: 'x', bookingId: 'bk_1' });
  await assert.rejects(
    orders.create(ctx, 'biz_1', { clientName: 'Ани', clientPhone: '+37400160001', items: [{ title: 'Ноутбук', qty: 1 }], price: 0, bookingId: 'bk_1' }),
    (e: unknown) => e instanceof ApiError && e.code === 'intake_already_accepted',
  );
  orderTable.findFirst = realFindFirst;
});

test('«Принять заказ»: обычная запись, отменённая, удалённая и чужая — отказ', async () => {
  const { orders } = world({
    service: [INTAKE_SVC],
    booking: [
      bookingRow('bk_plain', '2026-10-05T07:00:00Z', { services: [{ serviceId: 'svc_other', staffId: 'st_1', price: 5000, durationMin: 60, qty: 1 }] }),
      bookingRow('bk_cancel', '2026-10-05T08:00:00Z', { status: 'cancelled_by_master' }),
      bookingRow('bk_del', '2026-10-05T08:30:00Z', { deletedAt: new Date() }),
      bookingRow('bk_foreign', '2026-10-05T09:00:00Z', { businessId: 'biz_2' }),
    ],
  });
  const body = (bookingId: string) => ({ clientName: 'Ани', clientPhone: '+37400160001', items: [{ title: 'X', qty: 1 }], price: 0, bookingId });
  await assert.rejects(orders.create(ctx, 'biz_1', body('bk_plain')), (e: unknown) => e instanceof ApiError && e.code === 'not_intake_booking');
  await assert.rejects(orders.create(ctx, 'biz_1', body('bk_cancel')), (e: unknown) => e instanceof ApiError && e.code === 'booking_cancelled');
  await assert.rejects(orders.create(ctx, 'biz_1', body('bk_del')), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
  await assert.rejects(orders.create(ctx, 'biz_1', body('bk_foreign')), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});

test('«Принять заказ» отмечает запись «Пришёл» (переход журнала); уже пришёл, отменена, нет прав — не трогает; ошибка перехода не мешает', async () => {
  const calls: string[] = [];
  const bookings = { changeStatus: async (_a: unknown, _b: string[], id: string, status: string) => { calls.push(`${id}:${status}`); if (id === 'bk_err') throw new Error('invalid_transition'); return {}; } };
  const m = memoryPrisma({
    booking: [
      bookingRow('bk_1', '2026-10-05T07:00:00Z'),
      bookingRow('bk_done', '2026-10-05T07:00:00Z', { status: 'arrived' }),
      bookingRow('bk_cancel', '2026-10-05T07:00:00Z', { status: 'cancelled_by_client' }),
      bookingRow('bk_err', '2026-10-05T07:00:00Z', { status: 'awaiting_confirmation' }),
    ],
  });
  const intake = new OrderIntakeService(m.prisma as never, audit as never, bookings as never);
  for (const id of ['bk_1', 'bk_done', 'bk_cancel', 'bk_err', 'bk_missing']) await intake.markArrived(ctx, 'biz_1', id);
  assert.deepEqual(calls, ['bk_1:arrived', 'bk_err:arrived']);
  // Без сотрудника в запросе (нет ctx.member) — ничего
  await intake.markArrived({ ...ctx, member: null } as unknown as typeof ctx, 'biz_1', 'bk_1');
  assert.equal(calls.length, 2);
});
