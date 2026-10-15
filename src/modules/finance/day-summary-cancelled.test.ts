/**
 * «Записей на сумму» в сводке денег дня (финансы F-07-046 и сводка журнала F-01-011): отменённые записи не считаются
 * (QA приложений 15.10.2026), удалённые отсеивает запрос. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { FinanceExtService } = await import('./finance-ext.service.js');
const { JournalMoreService } = await import('../journal-more/journal-more.service.js');

const START = new Date('2026-10-15T08:00:00.000Z');
const bookings = [
  { id: 'bk_1', total: 10000n, status: 'scheduled', clientId: 'cl_1', paidAmount: 0n, extras: null, startAt: START, deletedAt: null },
  { id: 'bk_2', total: 5000n, status: 'arrived', clientId: 'cl_2', paidAmount: 0n, extras: null, startAt: START, deletedAt: null },
  { id: 'bk_3', total: 7000n, status: 'cancelled_by_client', clientId: 'cl_3', paidAmount: 0n, extras: null, startAt: START, deletedAt: null },
  { id: 'bk_4', total: 3000n, status: 'cancelled_by_master', clientId: 'cl_4', paidAmount: 0n, extras: null, startAt: START, deletedAt: null },
];

const prisma = {
  location: {
    findMany: async () => [{ id: 'loc_1' }],
    findFirst: async () => ({ id: 'loc_1', tz: 'Asia/Yerevan' }),
  },
  cashRegister: { findMany: async () => [] },
  finOp: { findMany: async () => [] },
  paymentItem: { findFirst: async () => null },
  bookingPayment: { findMany: async () => [] },
  // Запрос сервиса уже просит deletedAt: null — проверяем, что он это делает, и отдаём неудалённые
  booking: {
    findMany: async ({ where }: { where: { deletedAt?: unknown } }) => {
      assert.equal(where.deletedAt, null);
      return bookings;
    },
  },
};

test('финансы: «Записей на сумму» без отменённых; «Выполнено» — только пришедшие', async () => {
  const svc = new FinanceExtService(prisma as never, null as never, null as never, null as never);
  const r = await svc.dayMoneySummary('biz_1', '2026-10-15');
  assert.equal(r.recordsTotal, 15000);
  assert.equal(r.doneTotal, 5000);
});

test('журнал: сводка дня — bookedTotal без отменённых', async () => {
  const svc = new JournalMoreService(prisma as never, null as never, null as never, null as never, null as never, null as never, null as never);
  const r = await svc.daySummary('biz_1', '2026-10-15');
  assert.equal(r.bookedTotal, 15000);
  assert.equal(r.doneTotal, 5000);
});
