/** ⭐ Выдача по времени (06.10.2026): «Выдача заказа» вслед за приёмом, окна и запись по ссылке заказа, «Забирают сегодня». Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const rules = await import('./order-rules.js');
const { OrderIntakeService } = await import('./order-intake.service.js');
const { OrderPickupService, pickupPublicInfo } = await import('./order-pickup.service.js');
const { OrdersService } = await import('./orders.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');
const { nowLocal, localToUtc } = await import('../../common/time/time.js');
const { notifyOrderReady } = await import('./order-notify.js');

type Row = Record<string, unknown>;
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

function memoryPrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { order: [], service: [], booking: [], ...seed };
  const t = (name: string) => (tables[name] ??= []);
  const apply = (r: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? ((r[k] as number) ?? 0) + ((v as Row).increment as number) : v;
  };
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => t(name).filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => t(name).find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => t(name).find((r) => matches(r, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Row }) => {
      const r = t(name).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      return r;
    },
    create: async ({ data }: { data: Row }) => {
      const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
      t(name).push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = t(name).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error('nf'), { code: 'P2025' });
      apply(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = t(name).filter((x) => matches(x, where));
      rows.forEach((r) => apply(r, data));
      return { count: rows.length };
    },
    createMany: async ({ data }: { data: Row[] }) => {
      t(name).push(...data);
      return { count: data.length };
    },
    upsert: async ({ where, create }: { where: Row; create: Row }) => {
      const r = t(name).find((x) => matches(x, where));
      if (r) return r;
      t(name).push(create);
      return create;
    },
  });
  const names = ['order', 'orderCounter', 'service', 'booking', 'business', 'location', 'staff', 'client', 'user', 'pushToken', 'telegramLink', 'notifyOutbox', 'notifyLogEntry', 'businessSetting'];
  const prisma: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, table(n)]));
  prisma.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
  return { tables, prisma };
}

const audit = { record: async () => undefined };
const ctx = {
  requestId: 'r',
  member: { businessId: 'biz_1', staffId: 'st_1', role: 'owner', permissions: new Set(['journal.view', 'journal.edit', 'clients.phones', 'settings.manage']) },
} as never;

const today = nowLocal().slice(0, 10);
const plusDays = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const tomorrow = plusDays(1);

const INTAKE: Row = { id: 'svc_i', businessId: 'biz_1', kind: 'intake', active: true, onlineBookable: true, durationMin: 15, staffIds: ['st_1', 'st_2'], createdAt: new Date('2026-01-01') };
const PICKUP: Row = { id: 'svc_p', businessId: 'biz_1', kind: 'pickup', active: true, onlineBookable: false, durationMin: 15, staffIds: ['st_1', 'st_2'], createdAt: new Date('2026-01-02') };
const ORDER: Row = {
  id: 'ord_1',
  businessId: 'biz_1',
  locationId: 'loc_1',
  number: 1024,
  code: 'AbCdEf1234',
  clientId: 'cl_1',
  clientName: 'Ани',
  clientPhone: '+37400160001',
  items: [{ title: 'iPhone 14 — замена экрана', qty: 1 }, { title: 'Защитное стекло', qty: 2 }],
  photos: [],
  staffId: 'st_2',
  status: 'ready',
  dueDate: null,
  price: 52000,
  prepaid: 20000,
  comment: null,
  history: [],
  readyNotifiedAt: new Date(),
  issuedAt: null,
  pickupBookingId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Окна: staffId → date → starts */
function world(opts: { seed?: Record<string, Row[]>; free?: Record<string, Record<string, string[]>> } = {}) {
  const m = memoryPrisma({
    business: [{ id: 'biz_1', sphereIds: ['repair'], ordersEnabled: null }],
    staff: [
      { id: 'st_1', businessId: 'biz_1', deletedAt: null, status: 'active', onlineBookingEnabled: true, serviceIds: [] },
      { id: 'st_2', businessId: 'biz_1', deletedAt: null, status: 'active', onlineBookingEnabled: true, serviceIds: [] },
    ],
    service: [{ ...INTAKE }, { ...PICKUP }],
    order: [{ ...ORDER }],
    ...opts.seed,
  });
  const free = opts.free ?? { st_1: { [tomorrow]: [`${tomorrow}T10:00`, `${tomorrow}T10:15`] }, st_2: { [tomorrow]: [`${tomorrow}T10:15`, `${tomorrow}T11:00`] } };
  const availability = { freeSlots: async (_b: string, q: { staffId: string; date: string }) => (free[q.staffId]?.[q.date] ?? []).map((start) => ({ start })) };
  const placed: Row[] = [];
  const statusCalls: string[] = [];
  const bookings = {
    place: async (_actor: unknown, input: Row) => {
      const id = `bk_${m.tables.booking!.length + 1}`;
      const row = {
        id,
        businessId: input.businessId,
        staffId: input.staffId,
        clientId: 'cl_1',
        startAt: localToUtc(input.start as string, 'Asia/Yerevan'),
        durationMin: 15,
        status: 'scheduled',
        services: (input.services as Row[]).map((l) => ({ ...l, staffId: input.staffId })),
        comment: input.comment,
        visitorName: null,
        deletedAt: null,
      };
      m.tables.booking!.push(row);
      placed.push(input);
      return { booking: { id } };
    },
    changeStatus: async (_a: unknown, _b: string[], id: string, status: string) => {
      statusCalls.push(`${id}:${status}`);
      const r = m.tables.booking!.find((b) => b.id === id);
      if (r) r.status = status;
      return {};
    },
  };
  const pickup = new OrderPickupService(m.prisma as never, availability as never, bookings as never);
  const orders = new OrdersService(m.prisma as never, audit as never, { send: async () => ({ delivered: true }) } as never);
  return { ...m, pickup, orders, placed, statusCalls };
}

// ─────────── правила ───────────

test('правила: «Выдача заказа» — скрытая услуга заказов; комментарий записи — номер и что забирают', () => {
  assert.equal(rules.isOrderServiceKind('pickup'), true);
  assert.equal(rules.isOrderServiceKind('intake'), true);
  assert.equal(rules.isOrderServiceKind('individual'), false);
  assert.equal(rules.canBookPickup('ready'), true);
  assert.equal(rules.canBookPickup('in_progress'), false);
  assert.equal(rules.pickupBookingComment(1024, ORDER.items), '№1024 · iPhone 14 — замена экрана · Защитное стекло ×2');
  assert.equal(rules.pickupBookingComment(7, []), '№7');
  assert.ok(rules.pickupBookingComment(1, [{ title: 'x'.repeat(400), qty: 1 }]).length <= rules.PICKUP_COMMENT_MAX);
});

// ─────────── настройка вслед за приёмом ───────────

test('настройка приёма заводит и «Выдачу заказа»: то же окно и люди, не онлайн; выключение выключает обе', async () => {
  const m = memoryPrisma({
    business: [{ id: 'biz_1', sphereIds: ['repair'] }],
    staff: [{ id: 'st_1', businessId: 'biz_1', deletedAt: null, status: 'active', serviceIds: [] }],
  });
  const intake = new OrderIntakeService(m.prisma as never, audit as never);
  await intake.setSettings(ctx, 'biz_1', { enabled: true, slotMin: 20 });
  const p = m.tables.service!.find((s) => s.kind === 'pickup')!;
  assert.ok(p, '«Выдача заказа» создана');
  assert.equal(p.durationMin, 20);
  assert.deepEqual(p.staffIds, ['st_1']);
  assert.equal(p.active, true);
  assert.equal(p.onlineBookable, false, 'в общем потоке онлайн-записи её нет');
  assert.equal((p.name as Row).ru, 'Выдача заказа');
  assert.deepEqual(m.tables.staff![0]!.serviceIds, [m.tables.service!.find((s) => s.kind === 'intake')!.id], 'мастеру назначается только приём');
  await intake.setSettings(ctx, 'biz_1', { enabled: false, slotMin: 30 });
  assert.equal(m.tables.service!.filter((s) => s.kind === 'pickup').length, 1, 'та же услуга, не вторая');
  assert.equal(p.active, false);
  assert.equal(p.durationMin, 30);
});

// ─────────── публичная страница ───────────

test('/o/<code>: у готового заказа — можно выбрать время; не готов, выключены «Заказы» или приём — нет', async () => {
  const w = world();
  const info = await pickupPublicInfo(w.prisma as never, ORDER as never);
  assert.deepEqual(info, { enabled: true, slotMin: 15, booking: null });
  assert.equal(await pickupPublicInfo(w.prisma as never, { ...ORDER, status: 'in_progress' } as never), null);
  const off = world({ seed: { business: [{ id: 'biz_1', sphereIds: ['repair'], ordersEnabled: false }] } });
  assert.equal(await pickupPublicInfo(off.prisma as never, ORDER as never), null);
  const noIntake = world({ seed: { service: [] } });
  assert.equal(await pickupPublicInfo(noIntake.prisma as never, ORDER as never), null);
  // Приём включили до 06.10.2026 — «Выдачи заказа» ещё нет, но выбрать время уже можно (настройки — от приёма)
  const legacy = world({ seed: { service: [{ ...INTAKE }] } });
  assert.deepEqual(await pickupPublicInfo(legacy.prisma as never, ORDER as never), { enabled: true, slotMin: 15, booking: null });
  const pub = await w.orders.publicByCode('AbCdEf1234');
  assert.deepEqual(pub.pickup, { enabled: true, slotMin: 15, booking: null });
});

test('окна: на неделю вперёд, общие для всех, кто выдаёт; дни без окон не приходят; не готов — order_not_ready, выключено — pickup_disabled', async () => {
  const w = world();
  const view = await w.pickup.slots('AbCdEf1234');
  assert.equal(view.slotMin, 15);
  assert.deepEqual(view.days, [{ date: tomorrow, slots: [`${tomorrow}T10:00`, `${tomorrow}T10:15`, `${tomorrow}T11:00`] }]);
  const notReady = world({ seed: { order: [{ ...ORDER, status: 'in_progress' }] } });
  await assert.rejects(notReady.pickup.slots('AbCdEf1234'), (e: unknown) => e instanceof ApiError && e.code === 'order_not_ready');
  const off = world({ seed: { service: [{ ...INTAKE, active: false, onlineBookable: false }, { ...PICKUP, active: false }] } });
  await assert.rejects(off.pickup.slots('AbCdEf1234'), (e: unknown) => e instanceof ApiError && e.code === 'pickup_disabled');
  await assert.rejects(w.pickup.slots('nope'), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
  await assert.rejects(w.pickup.slots('ZZZZZZZZZZ'), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});

test('запись: мастер заказа первым, «Выдача заказа» с номером заказа, ссылка на заказе; тот же выбор — без второй записи', async () => {
  const w = world();
  await w.pickup.book('AbCdEf1234', `${tomorrow}T10:15`);
  assert.equal(w.placed.length, 1);
  const input = w.placed[0]!;
  assert.equal(input.staffId, 'st_2', 'свободен и мастер заказа, и другой — берём мастера заказа');
  assert.equal(input.orderPickup, true);
  assert.equal(input.source, 'link');
  assert.deepEqual(input.services, [{ serviceId: 'svc_p' }]);
  assert.equal(input.comment, '№1024 · iPhone 14 — замена экрана · Защитное стекло ×2');
  assert.deepEqual(input.client, { phone: '+37400160001', name: 'Ани' });
  assert.equal(w.tables.order![0]!.pickupBookingId, 'bk_1');
  await w.pickup.book('AbCdEf1234', `${tomorrow}T10:15`);
  assert.equal(w.placed.length, 1, 'повтор того же — без изменений');
  const info = await pickupPublicInfo(w.prisma as never, w.tables.order![0] as never);
  assert.deepEqual(info?.booking, { start: `${tomorrow}T10:15`, status: 'scheduled' });
  // Окно только у другого мастера — к нему
  await w.pickup.book('AbCdEf1234', `${tomorrow}T10:00`);
  assert.equal(w.placed[1]!.staffId, 'st_1');
});

test('другое время: новая запись, прежняя снята «Отменил клиент»; занято или вне недели — slot_taken', async () => {
  const w = world();
  await w.pickup.book('AbCdEf1234', `${tomorrow}T10:15`);
  await w.pickup.book('AbCdEf1234', `${tomorrow}T11:00`);
  assert.equal(w.tables.order![0]!.pickupBookingId, 'bk_2');
  assert.deepEqual(w.statusCalls, ['bk_1:cancelled_by_client']);
  await assert.rejects(w.pickup.book('AbCdEf1234', `${tomorrow}T12:00`), (e: unknown) => e instanceof ApiError && e.code === 'slot_taken');
  await assert.rejects(w.pickup.book('AbCdEf1234', `${plusDays(9)}T10:00`), (e: unknown) => e instanceof ApiError && e.code === 'slot_taken');
  await assert.rejects(w.pickup.book('AbCdEf1234', 'завтра'), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  assert.equal(w.tables.order![0]!.pickupBookingId, 'bk_2', 'неудачная попытка ничего не поменяла');
});

test('гонка двух устройств: ссылку заказа успели поменять — новая запись снимается, pickup_changed', async () => {
  const w = world();
  const orderTable = (w.prisma as Record<string, Record<string, unknown>>).order!;
  const realUpdateMany = orderTable.updateMany as (a: unknown) => Promise<{ count: number }>;
  orderTable.updateMany = async () => ({ count: 0 });
  await assert.rejects(w.pickup.book('AbCdEf1234', `${tomorrow}T10:15`), (e: unknown) => e instanceof ApiError && e.code === 'pickup_changed');
  assert.deepEqual(w.statusCalls, ['bk_1:cancelled_by_client']);
  orderTable.updateMany = realUpdateMany;
});

test('не готов — order_not_ready; приём выключен — pickup_disabled; ничего не записано', async () => {
  const notReady = world({ seed: { order: [{ ...ORDER, status: 'issued' }] } });
  await assert.rejects(notReady.pickup.book('AbCdEf1234', `${tomorrow}T10:15`), (e: unknown) => e instanceof ApiError && e.code === 'order_not_ready');
  const off = world({ seed: { business: [{ id: 'biz_1', sphereIds: ['repair'], ordersEnabled: false }] } });
  await assert.rejects(off.pickup.book('AbCdEf1234', `${tomorrow}T10:15`), (e: unknown) => e instanceof ApiError && e.code === 'pickup_disabled');
  assert.equal(notReady.placed.length + off.placed.length, 0);
});

test('приём включили до 06.10.2026: «Выдача заказа» заводится при первой записи — с окном и людьми приёма', async () => {
  const w = world({ seed: { service: [{ ...INTAKE }] } });
  await w.pickup.book('AbCdEf1234', `${tomorrow}T10:15`);
  const p = w.tables.service!.find((s) => s.kind === 'pickup')!;
  assert.ok(p);
  assert.deepEqual(p.staffIds, ['st_1', 'st_2']);
  assert.equal(p.onlineBookable, false);
  assert.deepEqual(w.placed[0]!.services, [{ serviceId: p.id }]);
});

test('«Не смогу»: запись снята, ссылка очищена; записи нет — без изменений', async () => {
  const w = world();
  await w.pickup.book('AbCdEf1234', `${tomorrow}T10:15`);
  await w.pickup.cancel('AbCdEf1234');
  assert.equal(w.tables.order![0]!.pickupBookingId, null);
  assert.deepEqual(w.statusCalls, ['bk_1:cancelled_by_client']);
  await w.pickup.cancel('AbCdEf1234');
  assert.equal(w.statusCalls.length, 1);
  // Мастерская сама отменила запись в журнале — на странице снова «выберите время»
  const again = world();
  await again.pickup.book('AbCdEf1234', `${tomorrow}T10:15`);
  again.tables.booking![0]!.status = 'cancelled_by_master';
  assert.equal((await pickupPublicInfo(again.prisma as never, again.tables.order![0] as never))?.booking, null);
});

// ─────────── кабинет: «Забирают сегодня» ───────────

test('«Забирают сегодня»: записи на выдачу дня с номером и статусом заказа; приём и отменённые — не здесь', async () => {
  const at = (time: string) => localToUtc(`${today}T${time}`, 'Asia/Yerevan');
  const line = (serviceId: string) => [{ serviceId, staffId: 'st_1', price: 0, durationMin: 15, qty: 1 }];
  const w = world({
    seed: {
      order: [{ ...ORDER, pickupBookingId: 'bk_p1' }],
      client: [{ id: 'cl_1', businessId: 'biz_1', name: 'Ани Мелкумян', phone: '+37400160001' }],
      booking: [
        { id: 'bk_p1', businessId: 'biz_1', staffId: 'st_2', clientId: 'cl_1', startAt: at('18:30'), durationMin: 15, status: 'scheduled', services: line('svc_p'), comment: '№1024 · iPhone 14', visitorName: null, deletedAt: null },
        { id: 'bk_i1', businessId: 'biz_1', staffId: 'st_1', clientId: 'cl_1', startAt: at('11:00'), durationMin: 15, status: 'scheduled', services: line('svc_i'), comment: 'MacBook', visitorName: null, deletedAt: null },
        { id: 'bk_p2', businessId: 'biz_1', staffId: 'st_1', clientId: 'cl_1', startAt: at('12:00'), durationMin: 15, status: 'cancelled_by_client', services: line('svc_p'), comment: '№1', visitorName: null, deletedAt: null },
      ],
    },
  });
  const list = await w.pickup.bookingsOn(ctx, 'biz_1', today);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.bookingId, 'bk_p1');
  assert.equal(list[0]!.start, `${today}T18:30`);
  assert.equal(list[0]!.orderNumber, 1024);
  assert.equal(list[0]!.orderStatus, 'ready');
  assert.equal(list[0]!.items, 'iPhone 14 — замена экрана · Защитное стекло ×2');
  assert.equal(list[0]!.clientPhone, '+37400160001');
  // Сдают сегодня — только приём
  const intake = new OrderIntakeService(w.prisma as never, audit as never);
  assert.deepEqual((await intake.bookingsOn(ctx, 'biz_1', today)).map((b) => b.bookingId), ['bk_i1']);
});

// ─────────── «Заказ готов» зовёт выбрать время ───────────

test('«Заказ готов»: мастерская принимает по времени — «выберите, когда удобно забрать» и та же ссылка /o/<code>', async () => {
  const m = memoryPrisma({ telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'ru', blockedAt: null }] });
  const input = { order: { id: 'ord_1', businessId: 'biz_1', number: 1024, code: 'AbCdEf1234', clientId: null, clientPhone: '+37400160001', staffId: null }, businessName: 'FixPoint', siteUrl: 'https://booktime.am' };
  const messenger = { send: async () => ({ delivered: true }) } as never;
  await notifyOrderReady(m.prisma as never, messenger, { ...input, pickup: true });
  await notifyOrderReady(m.prisma as never, messenger, input);
  const [withPickup, plain] = m.tables.notifyLogEntry!.map((l) => l.text as Record<string, string>);
  assert.equal(withPickup!.ru, 'Ваш заказ №1024 в «FixPoint» готов. Выберите, когда удобно забрать: https://booktime.am/o/AbCdEf1234');
  assert.match(withPickup!.hy!, /Ընտրեք/);
  assert.match(withPickup!.en!, /Choose when to pick it up: https:\/\/booktime\.am\/o\/AbCdEf1234/);
  assert.equal(plain!.ru, 'Ваш заказ №1024 в «FixPoint» готов. Статус: https://booktime.am/o/AbCdEf1234');
  assert.equal(m.tables.notifyOutbox!.length, 2, 'тот же вид order_ready и тот же канал');
});

test('«Заказ готов» из кабинета: текст с выбором времени только когда мастерская принимает по времени', async () => {
  const w = world({ seed: { telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'ru', blockedAt: null }], order: [{ ...ORDER, status: 'in_progress', history: [] }] } });
  await w.orders.setStatus(ctx, 'biz_1', 'ord_1', 'ready');
  assert.match(String(w.tables.notifyOutbox![0]!.body), /Выберите, когда удобно забрать/);
  const off = world({ seed: { service: [], telegramLink: [{ chatId: '777', phone: '+37400160001', languageCode: 'ru', blockedAt: null }], order: [{ ...ORDER, status: 'in_progress', history: [] }] } });
  await off.orders.setStatus(ctx, 'biz_1', 'ord_1', 'ready');
  assert.match(String(off.tables.notifyOutbox![0]!.body), /Статус:/);
});
