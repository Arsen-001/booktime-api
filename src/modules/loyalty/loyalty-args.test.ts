/**
 * Неверные аргументы лояльности — 400 `validation`, не 500 (журнал доделок 01.10, backend-2: «createCardType без
 * аргументов → 500»). Кабинет `…/loyalty/x/{op}` — проверка порта (port/runner.service.ts checkArgs + TypeError → 400);
 * приложение `…/loyalty/app/{op}` — ClientLoyaltyService (пустой id не превращается в 404/403). База не нужна:
 * ошибка случается раньше любого запроса. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { LoyaltyPortRunner } = await import('./port/runner.service.js');
const { ClientLoyaltyService } = await import('./client-loyalty.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

/** Любое обращение к базе в этих тестах — ошибка: проверка аргументов обязана сработать раньше */
const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`база не должна вызываться: prisma.${String(key)}`); } });

const isValidation = (field?: string, kind?: string) => (e: unknown) => {
  assert.ok(e instanceof ApiError, `ожидалась ApiError, пришло ${String(e)}`);
  assert.equal(e.code, 'validation');
  assert.equal(e.status, 400);
  if (field) assert.equal(e.fields?.[field], kind);
  return true;
};

const runner = new LoyaltyPortRunner(noDb as never, noDb as never, noDb as never);
const opts = { businessId: 'biz_1', scope: [], actor: 'st_1' };

test('x/{op}: createCardType без данных типа — 400 с полем args.1, до базы', async () => {
  await assert.rejects(runner.run('createCardType', ['biz_1'], opts), isValidation('args.1', 'object'));
  await assert.rejects(runner.run('createCardType', ['biz_1', 'не объект'], opts), isValidation('args.1', 'object'));
});

test('x/{op}: аргумент не той формы — 400 (булево, число, пустой id)', async () => {
  await assert.rejects(runner.run('setCardTypeArchived', ['biz_1', 'lct_1', 'да'], opts), isValidation('args.2', 'boolean'));
  await assert.rejects(runner.run('adjustCardBalance', ['biz_1', 'lc_1', 'accrue', '100'], opts), isValidation('args.3', 'number'));
  await assert.rejects(runner.run('deleteCardType', ['biz_1', ''], opts), isValidation('args.1', 'string'));
});

test('x/{op}: объект без нужных полей (глубже первого уровня) — 400, не 500', async () => {
  // createCardType({}) — фасад читает input.name.trim() → TypeError, порт отвечает validation
  await assert.rejects(runner.run('createCardType', ['biz_1', {}], opts), isValidation());
});

test('x/{op}: неизвестная операция — 404', async () => {
  await assert.rejects(runner.run('noSuchOp', ['biz_1'], opts), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});

const svc = new ClientLoyaltyService(noDb as never, runner, noDb as never);
const ctx = { member: { businessId: 'biz_1', staffId: 'st_1', networkId: null, permissions: new Set(['loyalty.manage', 'loyalty.rules', 'finance.edit']) } } as never;

test('app/{op} клиента: покупка и «Я оплатил» без id — 400, а не 404 / 403', async () => {
  for (const op of ['purchaseMembership', 'purchaseCertificate', 'markMembershipPaymentSent', 'markCertificatePaymentSent']) {
    await assert.rejects(svc.me('au_1', op, []), isValidation('args.0', 'string'), op);
    await assert.rejects(svc.me('au_1', op, [42]), isValidation('args.0', 'string'), op);
  }
});

test('app/{op} кабинета: подтвердить/отклонить заявку без id — 400; «кэшбэк в приложении» не булево — 400', async () => {
  for (const op of ['confirmMembershipPurchase', 'confirmCertificatePurchase', 'rejectMembershipPurchase', 'rejectCertificatePurchase']) {
    await assert.rejects(svc.biz(ctx, 'biz_1', op, []), isValidation('args.0', 'string'), op);
  }
  await assert.rejects(svc.biz(ctx, 'biz_1', 'setCashbackVisibleForBusiness', ['yes']), isValidation('args.0', 'boolean'));
  await assert.rejects(svc.biz(ctx, 'biz_1', 'setCashbackVisibleForBusiness', []), isValidation('args.0', 'boolean'));
});

test('app/{op}: операции через порт без id — тоже 400 (checkArgs порта)', async () => {
  // toggleMembershipFreeze → appToggleMembershipFreeze(userId, '') — порт режет пустую строку до базы среза
  const withScope = new ClientLoyaltyService({ client: { findMany: async () => [] } } as never, runner, noDb as never);
  await assert.rejects(withScope.me('au_1', 'toggleMembershipFreeze', []), isValidation('args.1', 'string'));
});

test('app/{op}: неизвестная операция — 404', async () => {
  await assert.rejects(svc.me('au_1', 'noSuchOp', []), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
  await assert.rejects(svc.biz(ctx, 'biz_1', 'noSuchOp', []), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});
