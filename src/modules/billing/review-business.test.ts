/**
 * Бизнес проверяющих App Store / Google Play не замерзает (QA 15.10.2026): владелец входит номером из
 * REVIEW_LOGIN_PHONES — подписка всегда живая (ensureSubscription → keepReviewAlive): отсрочка и заморозка снимаются,
 * срок продлевается, бизнес снова опубликован (каталог и /v1/public/places/{id}), readOnly нет, запись не 423,
 * воркер не замораживает. REVIEW_LOGIN_PHONES пуст — всё как было. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { env } = await import('../../common/config/env.js');
const { DisabledPaymentProvider } = await import('../../adapters/payments/payments.js');
const { billingTick, ensureSubscription, isReviewBusiness, isSubscriptionFrozen, subscriptionView } = await import('./subscription.js');
type PrismaService = import('../../common/prisma.service.js').PrismaService;

const REVIEW_PHONE = '+37400000101';
const DAY = 86_400_000;

type Sub = Record<string, unknown> & { businessId: string; status: string; paidUntil: Date };

/**
 * База в памяти: подписки, бизнесы (status), владельцы с телефоном входа. Остальное — пусто (для subscriptionView).
 * Журнал staffQueries — сколько раз искали владельца (при пустом REVIEW_LOGIN_PHONES — ни разу).
 */
function memoryDb(subs: Sub[], owners: Record<string, string>) {
  const business = new Map(subs.map((s) => [s.businessId, { id: s.businessId, status: s.status === 'frozen' ? 'frozen' : 'active', kind: 'individual', ownerStaffId: null }]));
  const log = { staffQueries: 0 };
  const find = (businessId: string) => subs.find((s) => s.businessId === businessId) ?? null;
  const models: Record<string, Record<string, (a: any) => Promise<unknown>>> = {
    subscription: {
      findUnique: async ({ where }) => find(where.businessId),
      findUniqueOrThrow: async ({ where }) => find(where.businessId)!,
      findMany: async ({ where }) =>
        subs.filter((s) => (where.OR as any[]).some((w) => (w.status === 'grace' ? s.status === 'grace' : w.status.in.includes(s.status) && s.paidUntil < w.paidUntil.lt))),
      update: async ({ where, data }) => {
        const s = find(where.businessId)!;
        for (const [k, v] of Object.entries(data)) if (k !== 'version') s[k] = v;
        return s;
      },
    },
    staff: {
      findMany: async ({ where }) => {
        if (!where.user) return []; // места подписки (computeSeats) — сотрудников нет
        log.staffQueries++;
        const phones: string[] = where.user.phone.in;
        const only: string[] | undefined = where.businessId?.in;
        return Object.entries(owners)
          .filter(([b, phone]) => phones.includes(phone) && (!only || only.includes(b)))
          .map(([businessId]) => ({ businessId }));
      },
    },
    business: {
      findUnique: async ({ where }) => business.get(where.id) ?? null,
      update: async ({ where, data }) => Object.assign(business.get(where.id)!, { status: data.status }),
    },
    platformPrice: { findMany: async () => [] },
  };
  const prisma: PrismaService = new Proxy({}, {
    get(_t, model: string) {
      if (model === '$transaction') return async (fn: (tx: PrismaService) => Promise<unknown>) => fn(prisma);
      return new Proxy({}, {
        get(_m, op: string) {
          const fn = models[model]?.[op];
          if (fn) return fn;
          return async () => (op === 'findMany' ? [] : op === 'count' ? 0 : model === 'business' ? { id: 'x', kind: 'individual', status: 'active', ownerStaffId: null } : null);
        },
      });
    },
  }) as unknown as PrismaService;
  return { prisma, business, log };
}

async function withReviewPhones<T>(phones: string[], fn: () => Promise<T>): Promise<T> {
  const before = env.REVIEW_LOGIN_PHONES;
  env.REVIEW_LOGIN_PHONES = phones;
  try {
    return await fn();
  } finally {
    env.REVIEW_LOGIN_PHONES = before;
  }
}

const frozenSub = (businessId: string): Sub => ({ businessId, status: 'frozen', paidUntil: new Date(Date.now() - 10 * DAY), graceUntil: new Date(Date.now() - 2 * DAY), autoRenew: false, savedCardId: null, promoTiers: null, promoUsedAt: null, promoCode: null, freeUntil: null, paymentDocsEmail: false, version: 1 });

test('замороженный бизнес проверяющих: подписка живая, не только чтение, бизнес снова опубликован', async () => {
  await withReviewPhones([REVIEW_PHONE], async () => {
    const sub = frozenSub('biz_review');
    const { prisma, business } = memoryDb([sub], { biz_review: REVIEW_PHONE });
    assert.equal(await isReviewBusiness(prisma, 'biz_review'), true);
    assert.equal(await isSubscriptionFrozen(prisma, 'biz_review'), false);
    assert.equal(sub.status, 'active');
    assert.ok(sub.paidUntil.getTime() > Date.now() + 25 * DAY, 'срок продлён');
    assert.equal(sub.graceUntil, null);
    assert.equal(business.get('biz_review')!.status, 'active', 'виден клиентам — /v1/public/places/{id} не 404');
    const view = await subscriptionView(prisma, 'biz_review');
    assert.equal(view.frozen, false);
    assert.equal(view.readOnly, false);
    assert.equal(view.status, 'active');
    assert.ok(view.daysLeft > 7);
  });
});

test('срок проверяющих подходит к концу — продлевается, без «скоро конец»', async () => {
  await withReviewPhones([REVIEW_PHONE], async () => {
    const sub: Sub = { ...frozenSub('biz_review'), status: 'trial', paidUntil: new Date(Date.now() + 2 * DAY), graceUntil: null };
    const { prisma } = memoryDb([sub], { biz_review: REVIEW_PHONE });
    const view = await subscriptionView(prisma, 'biz_review');
    assert.equal(view.status, 'active');
    assert.ok(view.daysLeft > 7);
  });
});

test('воркер: бизнес проверяющих не уходит в отсрочку и заморозку, замороженный раньше — оттаивает', async () => {
  await withReviewPhones([REVIEW_PHONE], async () => {
    const expired: Sub = { ...frozenSub('biz_review'), status: 'active', paidUntil: new Date(Date.now() - DAY), graceUntil: null };
    const graceOver: Sub = { ...frozenSub('biz_review2'), status: 'grace', graceUntil: new Date(Date.now() - DAY) };
    const old = frozenSub('biz_review3');
    const regular: Sub = { ...frozenSub('biz_other'), status: 'grace', graceUntil: new Date(Date.now() - DAY) };
    const { prisma, business } = memoryDb([expired, graceOver, old, regular], { biz_review: REVIEW_PHONE, biz_review2: REVIEW_PHONE, biz_review3: REVIEW_PHONE, biz_other: '+37491000000' });
    const notes: string[] = [];
    const res = await billingTick(prisma, new DisabledPaymentProvider(), async (b, key) => {
      notes.push(`${b}:${key}`);
    });
    assert.equal(res.review, 3);
    for (const s of [expired, graceOver, old]) {
      assert.equal(s.status, 'active', s.businessId);
      assert.equal(business.get(s.businessId)!.status, 'active');
    }
    // обычный бизнес — как раньше: отсрочка кончилась → заморозка
    assert.equal(regular.status, 'frozen');
    assert.equal(res.frozen, 1);
    assert.deepEqual(notes, ['biz_other:billing.frozen']);
  });
});

test('REVIEW_LOGIN_PHONES пуст — заморозка как была, владельца не ищем', async () => {
  await withReviewPhones([], async () => {
    const sub = frozenSub('biz_review');
    const { prisma, log } = memoryDb([sub], { biz_review: REVIEW_PHONE });
    assert.equal(await isReviewBusiness(prisma, 'biz_review'), false);
    assert.equal(await isSubscriptionFrozen(prisma, 'biz_review'), true);
    assert.equal((await ensureSubscription(prisma, 'biz_review')).status, 'frozen');
    assert.equal((await subscriptionView(prisma, 'biz_review')).readOnly, true);
    const res = await billingTick(prisma, new DisabledPaymentProvider(), async () => undefined);
    assert.equal(res.review, 0);
    assert.equal(sub.status, 'frozen');
    assert.equal(log.staffQueries, 0);
  });
});

test('номер в списке, но владелец другой — бизнес замораживается как обычно', async () => {
  await withReviewPhones([REVIEW_PHONE], async () => {
    const sub = frozenSub('biz_x');
    const { prisma } = memoryDb([sub], { biz_x: '+37491000000' });
    assert.equal(await isSubscriptionFrozen(prisma, 'biz_x'), true);
    assert.equal(sub.status, 'frozen');
  });
});
