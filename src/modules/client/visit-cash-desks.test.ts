/** Кассы визита — настоящие кассы «Финансов» вместо демо «Касса 1–3» (F-14-094/097). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { VisitCashService, visitCashDesks } = await import('./visit-cash.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

const rows = [
  { id: 'cr_center', name: 'Касса Центр', kind: 'cash', locationId: 'loc_center' },
  { id: 'cr_card', name: 'Терминал', kind: 'card', locationId: 'loc_center' },
  { id: 'cr_nn', name: 'Касса Нор-Норк', kind: 'cash', locationId: 'loc_nn' },
];

test('только наличные кассы; филиал визита — свои, у филиала нет касс — все кассы бизнеса', () => {
  assert.deepEqual(visitCashDesks(rows), [
    { id: 'cr_center', name: 'Касса Центр' },
    { id: 'cr_nn', name: 'Касса Нор-Норк' },
  ]);
  assert.deepEqual(visitCashDesks(rows, 'loc_nn'), [{ id: 'cr_nn', name: 'Касса Нор-Норк' }]);
  assert.deepEqual(visitCashDesks(rows, 'loc_new').length, 2);
  assert.deepEqual(visitCashDesks([]), []);
});

function service(registers: { id: string; name: string; kind: string; locationId: string; businessId?: string }[]) {
  const created: unknown[] = [];
  const prisma = {
    cashRegister: {
      findFirst: async ({ where }: { where: { id: string; businessId: string; kind: string } }) =>
        registers.find((r) => r.id === where.id && (r.businessId ?? 'biz_1') === where.businessId && r.kind === where.kind) ?? null,
    },
    visitCashRecord: {
      create: async ({ data }: { data: { id: string; data: unknown } }) => {
        created.push(data);
        return { ...data, createdAt: new Date('2026-10-06T10:00:00Z') };
      },
    },
  };
  const bookings = { find: async () => ({ id: 'bk_1' }) };
  return { svc: new VisitCashService(prisma as never, bookings as never), created };
}

test('оплата наличными: касса бизнеса — проходит; чужая или карточная — validation', async () => {
  const { svc, created } = service([...rows, { id: 'cr_other', name: 'Чужая', kind: 'cash', locationId: 'x', businessId: 'biz_2' }]);
  const ok = await svc.addVisitPayment('biz_1', 'bk_1', { method: 'cash', amount: 5000, cashDeskId: 'cr_center' });
  assert.equal(ok.cashDeskId, 'cr_center');
  const isValidation = (e: unknown) => e instanceof ApiError && e.code === 'validation';
  await assert.rejects(svc.addVisitPayment('biz_1', 'bk_1', { method: 'cash', amount: 5000, cashDeskId: 'cr_other' }), isValidation);
  await assert.rejects(svc.addVisitPayment('biz_1', 'bk_1', { method: 'cash', amount: 5000, cashDeskId: 'cr_card' }), isValidation);
  await assert.rejects(svc.addVisitPayment('biz_1', 'bk_1', { method: 'cash', amount: 5000, cashDeskId: 'desk-1' }), isValidation, 'демо-касса больше не принимается');
  // «Все кассы» (без кассы) и карта — без проверки кассы
  await svc.addVisitPayment('biz_1', 'bk_1', { method: 'cash', amount: 100 });
  await svc.addVisitPayment('biz_1', 'bk_1', { method: 'card', amount: 100, cardBrand: 'arca', cashDeskId: 'cr_other' });
  assert.equal(created.length, 3);
});
