/** Решение 30.09 (qa/full-test-0930 loyalty.md): у клиента одна карта каждого типа — вторая того же типа 409. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { LoyaltyInstancesService } = await import('./loyalty-instances.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

test('вторая карта того же типа тому же клиенту — 409 card_type_already_issued, новая не создаётся', async () => {
  const cards: Record<string, unknown>[] = [{ id: 'lc_1', businessId: 'biz_1', clientId: 'cl_1', cardTypeId: 'ct_1', number: '0001' }];
  const prisma = {
    loyaltyCardType: { findFirst: async () => ({ id: 'ct_1', archived: false }) },
    client: { findFirst: async () => ({ id: 'cl_1', businessId: 'biz_1' }) },
    business: { findUnique: async () => ({ networkId: null }) },
    loyaltyCard: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => cards.find((c) => Object.entries(where).every(([k, v]) => c[k] === v)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => cards.push(data),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const ctx = { member: { businessId: 'biz_1', staffId: 'st_1', networkId: null, permissions: new Set<string>() } } as never;
  const svc = new LoyaltyInstancesService(prisma as never, { record: async () => undefined } as never);
  await assert.rejects(svc.issueCard(ctx, 'cl_1', 'ct_1'), (e: unknown) => e instanceof ApiError && e.code === 'card_type_already_issued' && e.status === 409);
  assert.equal(cards.length, 1);
});
