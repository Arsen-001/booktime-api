/**
 * «Продано / Оплачено / Баланс» и «Визиты с долгом» клиента (проход 17.11): оплачено — единый счётчик визита
 * booking.paidAmount (деньги, абонемент, сертификат, счёт, предоплата), а не только строки кассы. Визит, оплаченный
 * абонементом, был «долгом» при «Оплачено полностью» в окне записи. Скидка по акции уменьшает «Продано».
 * База в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { FinanceExtService } = await import('./finance-ext.service.js');
const { BookingPaymentsService } = await import('./booking-payments.service.js');
type Row = Record<string, unknown>;

const svcLine = (price: number) => [{ serviceId: 'sv_1', price, qty: 1 }];
const bookings: Row[] = [
  // Наличными 5 000 — строка кассы есть
  { id: 'bk_cash', businessId: 'b1', clientId: 'c1', status: 'arrived', deletedAt: null, startAt: new Date('2026-11-10T08:00:00Z'), staffId: 's1', total: 5000n, paidAmount: 5000n, services: svcLine(5000), extras: { payments: [{ id: 'p1', method: 'cash', amount: 5000, label: 'Наличные', at: '2026-11-10T12:00' }] } },
  // Абонементом 5 000 — строки кассы нет, только счётчик визита
  { id: 'bk_memb', businessId: 'b1', clientId: 'c1', status: 'arrived', deletedAt: null, startAt: new Date('2026-11-17T14:00:00Z'), staffId: 's1', total: 5000n, paidAmount: 5000n, services: svcLine(5000), extras: { payments: [{ id: 'p2', method: 'membership', amount: 5000, label: 'Использование абонемента', at: '2026-11-17T18:00' }] } },
  // 8 000 со скидкой по акции 1 000 и картой 7 000 — не долг
  { id: 'bk_disc', businessId: 'b1', clientId: 'c1', status: 'arrived', deletedAt: null, startAt: new Date('2026-11-12T08:00:00Z'), staffId: 's1', total: 8000n, paidAmount: 8000n, services: svcLine(8000), extras: { payments: [{ id: 'p3', method: 'discount', amount: 1000, label: 'Акция', at: '2026-11-12T12:00' }, { id: 'p4', method: 'card', amount: 7000, label: 'Банковская карта', at: '2026-11-12T12:01' }] } },
  // Не оплачен 6 000 — настоящий долг
  { id: 'bk_debt', businessId: 'b1', clientId: 'c1', status: 'arrived', deletedAt: null, startAt: new Date('2026-11-14T08:00:00Z'), staffId: 's1', total: 6000n, paidAmount: 0n, services: svcLine(6000), extras: null },
];
const paymentRows: Row[] = [
  { businessId: 'b1', bookingId: 'bk_cash', kind: 'money', methodLabel: 'Наличные', amount: 5000n, cancelled: false, debt: false },
  { businessId: 'b1', bookingId: 'bk_disc', kind: 'discount', methodLabel: 'Акция', amount: 1000n, cancelled: false, debt: false },
  { businessId: 'b1', bookingId: 'bk_disc', kind: 'money', methodLabel: 'Банковская карта', amount: 7000n, cancelled: false, debt: false },
];

const match = (where: Row, r: Row) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in (v as Row) ? (v as { in: unknown[] }).in.includes(r[k]) : v && typeof v === 'object' && 'not' in (v as Row) ? r[k] !== (v as { not: unknown }).not : r[k] === v));
const prisma = {
  booking: {
    findMany: async ({ where }: { where: Row }) => bookings.filter((b) => match({ ...where, status: undefined }, { ...b, status: undefined }) && (!where.status || (typeof where.status === 'string' ? b.status === where.status : (where.status as { in: string[] }).in.includes(b.status as string)))),
  },
  bookingPayment: { findMany: async ({ where }: { where: Row }) => paymentRows.filter((p) => match(where, p)) },
  finOp: { findMany: async () => [] },
  service: { findMany: async () => [{ id: 'sv_1', name: { ru: 'Маникюр' } }] },
  product: { findMany: async () => [] },
};
type PCtor = ConstructorParameters<typeof BookingPaymentsService>;
type ECtor = ConstructorParameters<typeof FinanceExtService>;
const payments = new BookingPaymentsService(prisma as unknown as PCtor[0], {} as PCtor[1], {} as PCtor[2], {} as PCtor[3], {} as PCtor[4]);
const ext = new FinanceExtService(prisma as unknown as ECtor[0], {} as ECtor[1], {} as ECtor[2], payments);

test('оплаченный абонементом визит — оплачен, скидка уменьшает «Продано», долг — только неоплаченный', async () => {
  const m = await ext.clientMoneyInputs('b1', 'c1');
  const sold = m.totals.reduce((s, v) => s + v, 0);
  assert.equal(sold, 5000 + 5000 + 7000 + 6000);
  assert.equal(m.paidFromBookings, 5000 + 5000 + 7000);
  assert.equal(m.paidFromBookings - sold, -6000);
});

test('«Визиты с долгом»: абонемент — оплачено, способ — строка абонемента; неоплаченный — долг', async () => {
  const rows = await ext.clientDebtVisits('b1', 'c1');
  const by = Object.fromEntries(rows.map((r) => [r.bookingId, r]));
  assert.equal(by.bk_memb?.due, 0);
  assert.equal(by.bk_memb?.method, 'Использование абонемента');
  assert.equal(by.bk_disc?.due, 0);
  assert.equal(by.bk_disc?.method, 'Банковская карта');
  assert.equal(by.bk_debt?.due, 6000);
  assert.equal(by.bk_cash?.method, 'Наличные');
});
