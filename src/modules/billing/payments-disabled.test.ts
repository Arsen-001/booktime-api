/**
 * Оплата выключена без провайдера (06.10.2026, F-00-022/026): на production заглушка не «проводит» платежи —
 * покупка монет, оплата подписки картой, сохранение карты отвечают 503 payments_unavailable и НИЧЕГО не трогают
 * в базе; автопродление не пытается списать с сохранённой (фальшивой) карты. Счёт для фирмы и бесплатные дни
 * работают без провайдера. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { DisabledPaymentProvider, FakePaymentProvider, pickPaymentProvider } = await import('../../adapters/payments/payments.js');
const { BillingService } = await import('./billing.service.js');
const { chargeSubscription, billingTick } = await import('./subscription.js');
const { ApiError, ERROR_STATUS } = await import('../../common/errors/api-error.js');
type PrismaService = import('../../common/prisma.service.js').PrismaService;
type AuditService = import('../../common/audit/audit.service.js').AuditService;
type RequestContext = import('../../common/http/context.js').RequestContext;

/** Prisma, которую нельзя трогать: любое обращение — в журнал и ошибка теста */
function untouchablePrisma() {
  const touched: string[] = [];
  const prisma = new Proxy({}, {
    get(_t, prop) {
      touched.push(String(prop));
      throw new Error(`prisma.${String(prop)} must not be used when payments are unavailable`);
    },
  }) as unknown as PrismaService;
  return { prisma, touched };
}

const audit = { record: async () => undefined } as unknown as AuditService;
const ctx = { member: { staffId: 'st_owner', businessId: 'biz_1', permissions: new Set(['billing.manage']) } } as unknown as RequestContext;

const isUnavailable = (e: unknown) => e instanceof ApiError && e.code === 'payments_unavailable';

test('выбор провайдера: заглушка только при разработке/тестах или PAYMENTS_FAKE=1 вне Railway production', () => {
  assert.equal(pickPaymentProvider({ nodeEnv: 'production' }).available, false);
  assert.equal(pickPaymentProvider({ nodeEnv: 'production', railwayEnv: 'staging' }).available, false);
  assert.equal(pickPaymentProvider({ nodeEnv: 'production', railwayEnv: 'production' }).kind, 'none');
  assert.equal(pickPaymentProvider({ nodeEnv: 'production', fake: '1', railwayEnv: 'production' }).available, false);
  assert.equal(pickPaymentProvider({ nodeEnv: 'production', fake: '1' }).kind, 'fake');
  assert.equal(pickPaymentProvider({ nodeEnv: 'development' }).kind, 'fake');
  assert.equal(pickPaymentProvider({ nodeEnv: 'test' }).kind, 'fake');
  assert.equal(pickPaymentProvider({ nodeEnv: 'development', fake: '0' }).available, false);
});

test('payments_unavailable — 503', () => {
  assert.equal(ERROR_STATUS.payments_unavailable, 503);
});

test('выключенный провайдер не проводит платёж', async () => {
  await assert.rejects(new DisabledPaymentProvider().charge(), isUnavailable);
});

test('покупка монет без провайдера: 503 и база не тронута', async () => {
  const { prisma, touched } = untouchablePrisma();
  const svc = new BillingService(prisma, audit, new DisabledPaymentProvider());
  await assert.rejects(svc.buyCoins(ctx, 'biz_1', 'pkg_100', 'key-1'), isUnavailable);
  assert.deepEqual(touched, []);
});

test('сохранение карты без провайдера: 503 и база не тронута', async () => {
  const { prisma, touched } = untouchablePrisma();
  const svc = new BillingService(prisma, audit, new DisabledPaymentProvider());
  await assert.rejects(svc.setCard(ctx, 'biz_1', { method: 'card' }), isUnavailable);
  assert.deepEqual(touched, []);
});

test('оплата подписки картой / Idram / Telcell без провайдера: 503 и база не тронута', async () => {
  for (const method of ['card', 'idram', 'telcell'] as const) {
    const { prisma, touched } = untouchablePrisma();
    const svc = new BillingService(prisma, audit, new DisabledPaymentProvider());
    await assert.rejects(svc.pay(ctx, 'biz_1', { months: 1, method }), isUnavailable);
    assert.deepEqual(touched, []);
    // автопродление идёт той же функцией
    await assert.rejects(chargeSubscription(prisma, new DisabledPaymentProvider(), { businessId: 'biz_1', months: 1, method, trigger: 'auto', by: 'system' }), isUnavailable);
    assert.deepEqual(touched, []);
  }
});

test('счёт для фирмы без провайдера не запрещён (провайдер не нужен)', async () => {
  const { prisma, touched } = untouchablePrisma();
  // До базы доходит — значит, проверка оплаты пропустила «счёт»; сама база здесь недоступна
  await assert.rejects(chargeSubscription(prisma, new DisabledPaymentProvider(), { businessId: 'biz_1', months: 1, method: 'invoice', trigger: 'manual', by: 'st_owner' }), (e: unknown) => !isUnavailable(e));
  assert.ok(touched.length > 0);
});

test('подписка сообщает экрану, принимаем ли оплату', async () => {
  for (const [provider, expected] of [[new DisabledPaymentProvider(), false], [new FakePaymentProvider(), true]] as const) {
    const svc = new BillingService({} as PrismaService, audit, provider);
    // subscriptionView читает базу — подменяем, проверяем только добавленное поле
    const view = await Object.getPrototypeOf(svc).view.call(Object.assign(Object.create(svc), { prisma: fakeSubscriptionDb() }), 'biz_1');
    assert.equal(view.paymentsAvailable, expected);
  }
});

test('автопродление без провайдера: не списывает с сохранённой карты и не шлёт «оплата не прошла», а уводит в отсрочку', async () => {
  const past = new Date(Date.now() - 2 * 86_400_000);
  const sub: Record<string, unknown> = { businessId: 'biz_1', status: 'active', paidUntil: past, autoRenew: true, savedCardId: 'card_1', warnedDays: null, graceUntil: null, retryAt: null };
  const calls: string[] = [];
  const prisma = {
    platformPrice: { findMany: async () => [] },
    subscription: {
      findMany: async () => [sub],
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(sub, data),
    },
    savedCard: { findUnique: async () => { calls.push('savedCard'); return { id: 'card_1', method: 'card', unavailable: false }; } },
  } as unknown as PrismaService;
  const notes: string[] = [];
  const res = await billingTick(prisma, new DisabledPaymentProvider(), async (_b, key) => { notes.push(key); });
  assert.equal(res.charged, 0);
  assert.equal(res.failed, 0);
  assert.equal(res.grace, 1);
  assert.equal(sub.status, 'grace');
  assert.deepEqual(calls, []);
  assert.deepEqual(notes, []);
});

/** Минимум базы для subscriptionView: подписка без карты и бизнес-индивидуал без мест */
function fakeSubscriptionDb() {
  const now = new Date(Date.now() + 10 * 86_400_000);
  const sub = { businessId: 'biz_1', status: 'active', paidUntil: now, autoRenew: false, savedCardId: null, promoTiers: null, promoUsedAt: null, promoCode: null, freeUntil: null, graceUntil: null, paymentDocsEmail: false, version: 1 };
  return new Proxy({}, {
    get(_t, model) {
      return new Proxy({}, {
        get(_m, op) {
          return async () => {
            if (model === 'subscription') return sub;
            if (op === 'findMany') return [];
            if (op === 'count') return 0;
            if (model === 'business') return { id: 'biz_1', kind: 'individual', status: 'active', ownerStaffId: null };
            return null;
          };
        },
      });
    },
  });
}
