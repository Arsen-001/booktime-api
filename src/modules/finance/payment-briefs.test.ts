/**
 * «Оплачено / к оплате» пачкой (страница «Записи», проход кабинета 17.11.2026): те же числа, что итог одной записи
 * (`getSummary`), — услуги + товары склада визита, остаток, статус; чужой бизнес не отдаётся. База в памяти.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { BookingPaymentsService } = await import('./booking-payments.service.js');
type Ctor = ConstructorParameters<typeof BookingPaymentsService>;
type Row = Record<string, unknown>;

const bookings: Row[] = [
  { id: 'bk_unpaid', businessId: 'b1', total: 10000n, paidAmount: 0n, extras: null, services: [{ price: 10000, qty: 1 }] },
  { id: 'bk_partial', businessId: 'b1', total: 8000n, paidAmount: 3000n, extras: null, services: [{ price: 8000, qty: 1 }] },
  // Услуга 6000 + шампунь 2 × 1500 со скидкой 10 % = 2700; оплачено 8700 — оплачено полностью
  { id: 'bk_goods', businessId: 'b1', total: 6000n, paidAmount: 8700n, extras: { goodsLines: [{ itemId: 'pr_1', qty: 2, price: 1500, discountPct: 10 }] }, services: [{ price: 6000, qty: 1 }] },
  { id: 'bk_free', businessId: 'b1', total: 0n, paidAmount: 0n, extras: null, services: [] },
  { id: 'bk_other', businessId: 'b2', total: 5000n, paidAmount: 0n, extras: null, services: [{ price: 5000, qty: 1 }] },
];

const inList = (v: unknown, x: unknown) => !v || (typeof v === 'object' && 'in' in (v as Row) ? ((v as { in: unknown[] }).in.includes(x)) : v === x);
const prisma = {
  booking: {
    findMany: async ({ where }: { where: Row }) => bookings.filter((b) => inList(where.id, b.id) && inList(where.businessId, b.businessId)),
    findFirst: async ({ where }: { where: Row }) => bookings.find((b) => b.id === where.id && b.businessId === where.businessId) ?? null,
  },
  product: {
    findMany: async ({ where }: { where: Row }) => [{ id: 'pr_1', businessId: 'b1', name: 'Шампунь' }].filter((p) => inList(where.id, p.id) && inList(where.businessId, p.businessId)),
  },
  bookingPayment: { findMany: async () => [] },
};
const svc = new BookingPaymentsService(prisma as unknown as Ctor[0], {} as Ctor[1], {} as Ctor[2], {} as Ctor[3], {} as Ctor[4]);

test('итоги пачкой совпадают с итогом каждой записи', async () => {
  const briefs = await svc.briefs(['b1'], ['bk_unpaid', 'bk_partial', 'bk_goods', 'bk_free']);
  for (const id of ['bk_unpaid', 'bk_partial', 'bk_goods', 'bk_free']) {
    const one = await svc.getSummary('b1', id);
    const brief = briefs[id];
    assert.ok(brief, id);
    assert.equal(brief.total, one.payableTotal, `${id}: к оплате`);
    assert.equal(brief.due, one.due, `${id}: остаток`);
    assert.equal(brief.status, one.status, `${id}: статус`);
    assert.equal(brief.paid, brief.total - brief.due, `${id}: оплачено`);
  }
  assert.deepEqual(briefs.bk_goods, { total: 8700, due: 0, paid: 8700, status: 'paid' });
  assert.deepEqual(briefs.bk_partial, { total: 8000, due: 5000, paid: 3000, status: 'partial' });
  assert.equal(briefs.bk_free?.status, 'unpaid');
});

test('запись чужого бизнеса не отдаётся, пустой список — без запроса', async () => {
  const briefs = await svc.briefs(['b1'], ['bk_other', 'bk_unpaid']);
  assert.deepEqual(Object.keys(briefs), ['bk_unpaid']);
  assert.deepEqual(await svc.briefs(['b1'], []), {});
});
