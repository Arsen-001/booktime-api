/**
 * Заморозка (В-02, QA 15.10.2026): замороженный бизнес выполняет чтение, отправленное POST-запросом (поиск
 * клиентов, таблица графика, операции чтения лояльности…) — такие обработчики помечены @ReadOnly(); любая запись
 * по-прежнему 423 `frozen`. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { Reflector } = await import('@nestjs/core');
const { lastValueFrom, of } = await import('rxjs');
const { FrozenInterceptor } = await import('./frozen.interceptor.js');
const { READ_ONLY_KEY } = await import('../../common/http/read-only.js');
const { ApiError } = await import('../../common/errors/api-error.js');
const { BIZ_OPS, BIZ_READ_OPS } = await import('../loyalty/port/ops.js');
const { BIZ_APP_READ_OPS } = await import('../loyalty/client-loyalty.service.js');
const { ClientsController } = await import('../clients/clients.controller.js');
const { BookingsController } = await import('../journal/bookings.controller.js');
const { JournalController } = await import('../journal/journal.controller.js');
const { SlotOffersController } = await import('../journal/slot-offers.controller.js');
const { NotifyLogController } = await import('../notify/notify-log.controller.js');
const { NotifyController } = await import('../notify/notify.controller.js');
const { ScheduleController } = await import('../schedule/schedule.controller.js');
const { ResourcesEventsController } = await import('../resources/resources-events.controller.js');
const { ResourcesController } = await import('../resources/resources.controller.js');
const { JournalMoreController } = await import('../journal-more/journal-more.controller.js');
const { BizClientLoyaltyController } = await import('../loyalty/client-loyalty.controller.js');
const { LoyaltyPortController } = await import('../loyalty/port/loyalty-port.controller.js');
const { JournalsController } = await import('../staff/journals.controller.js');
const { ReportsController } = await import('../reports/reports.controller.js');
const { BillingController } = await import('./billing.controller.js');
type PrismaService = import('../../common/prisma.service.js').PrismaService;
type ExecutionContext = import('@nestjs/common').ExecutionContext;

/** База с одной подпиской нужного статуса */
function db(status: string | null) {
  const reads: string[] = [];
  const prisma = {
    subscription: {
      findUnique: async () => {
        reads.push('subscription.findUnique');
        return status ? { businessId: 'biz_1', status, paidUntil: new Date(Date.now() - 86_400_000) } : null;
      },
    },
  } as unknown as PrismaService;
  return { prisma, reads };
}

type Handler = (...args: never[]) => unknown;

function ctxFor(handler: Handler, req: { method: string; path: string; params?: Record<string, string>; body?: unknown }): ExecutionContext {
  const request = { params: {}, body: undefined, ...req };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => Object } as unknown as ExecutionContext;
}

async function call(status: string | null, handler: Handler, req: Parameters<typeof ctxFor>[1]) {
  const { prisma } = db(status);
  const interceptor = new FrozenInterceptor(prisma, new Reflector());
  return lastValueFrom(interceptor.intercept(ctxFor(handler, req), { handle: () => of('ok') }));
}

const isFrozen = (e: unknown) => e instanceof ApiError && e.code === 'frozen' && e.status === 423;

test('замороженный бизнес: POST-чтение с @ReadOnly() проходит', async () => {
  assert.equal(await call('frozen', ClientsController.prototype.search, { method: 'POST', path: '/v1/biz/biz_1/clients/search' }), 'ok');
  assert.equal(await call('frozen', ScheduleController.prototype.table, { method: 'POST', path: '/v1/biz/biz_1/schedule/table' }), 'ok');
  assert.equal(await call('frozen', ScheduleController.prototype.snapshot, { method: 'POST', path: '/v1/biz/biz_1/schedule/cells/snapshot' }), 'ok');
  assert.equal(await call('left', ScheduleController.prototype.dayInfo, { method: 'POST', path: '/v1/biz/biz_1/schedule/day-info' }), 'ok');
});

test('замороженный бизнес: запись без метки — 423 frozen', async () => {
  await assert.rejects(call('frozen', ClientsController.prototype.createClient, { method: 'POST', path: '/v1/biz/biz_1/clients' }), isFrozen);
  await assert.rejects(call('frozen', ScheduleController.prototype.apply, { method: 'POST', path: '/v1/biz/biz_1/schedule/cells/apply' }), isFrozen);
  await assert.rejects(call('left', ClientsController.prototype.createClient, { method: 'POST', path: '/v1/biz/biz_1/clients' }), isFrozen);
});

test('лояльность: операции чтения проходят, изменения — 423', async () => {
  const port = LoyaltyPortController.prototype.call;
  assert.equal(await call('frozen', port, { method: 'POST', path: '/v1/biz/biz_1/loyalty/x/listCards', params: { op: 'listCards' } }), 'ok');
  assert.equal(await call('frozen', port, { method: 'POST', path: '/v1/biz/biz_1/loyalty/x/getLoyaltyHubOverview', params: { op: 'getLoyaltyHubOverview' } }), 'ok');
  await assert.rejects(call('frozen', port, { method: 'POST', path: '/v1/biz/biz_1/loyalty/x/createCardType', params: { op: 'createCardType' } }), isFrozen);
  await assert.rejects(call('frozen', port, { method: 'POST', path: '/v1/biz/biz_1/loyalty/x/sellMembership', params: { op: 'sellMembership' } }), isFrozen);
  const app = BizClientLoyaltyController.prototype.call;
  assert.equal(await call('frozen', app, { method: 'POST', path: '/v1/biz/biz_1/loyalty/app/listPurchaseRequests', params: { op: 'listPurchaseRequests' } }), 'ok');
  await assert.rejects(call('frozen', app, { method: 'POST', path: '/v1/biz/biz_1/loyalty/app/confirmMembershipPurchase', params: { op: 'confirmMembershipPurchase' } }), isFrozen);
});

test('след выгрузки проходит, след загрузки и удаления — 423', async () => {
  const h = JournalsController.prototype.logDataOp;
  assert.equal(await call('frozen', h, { method: 'POST', path: '/v1/biz/biz_1/data-ops', body: { kind: 'export' } }), 'ok');
  await assert.rejects(call('frozen', h, { method: 'POST', path: '/v1/biz/biz_1/data-ops', body: { kind: 'import' } }), isFrozen);
  await assert.rejects(call('frozen', h, { method: 'POST', path: '/v1/biz/biz_1/data-ops', body: { kind: 'delete' } }), isFrozen);
  const log = JournalsController.prototype.logExport;
  assert.equal(await call('frozen', log, { method: 'POST', path: '/v1/biz/biz_1/exports-log', body: { isImport: false } }), 'ok');
  await assert.rejects(call('frozen', log, { method: 'POST', path: '/v1/biz/biz_1/exports-log', body: { isImport: true } }), isFrozen);
  const manual = ReportsController.prototype.logManualExport;
  assert.equal(await call('frozen', manual, { method: 'POST', path: '/v1/biz/biz_1/reports/exports', body: { operation: 'browserDownload' } }), 'ok');
  await assert.rejects(call('frozen', manual, { method: 'POST', path: '/v1/biz/biz_1/reports/exports', body: { operation: 'upload' } }), isFrozen);
});

test('не заморожен — запись проходит; GET и разрешённые разделы не читают подписку', async () => {
  assert.equal(await call('active', ClientsController.prototype.createClient, { method: 'POST', path: '/v1/biz/biz_1/clients' }), 'ok');
  assert.equal(await call(null, ClientsController.prototype.createClient, { method: 'POST', path: '/v1/biz/biz_1/clients' }), 'ok');
  const { prisma, reads } = db('frozen');
  const interceptor = new FrozenInterceptor(prisma, new Reflector());
  const run = (handler: Handler, req: Parameters<typeof ctxFor>[1]) => lastValueFrom(interceptor.intercept(ctxFor(handler, req), { handle: () => of('ok') }));
  assert.equal(await run(ClientsController.prototype.createClient, { method: 'GET', path: '/v1/biz/biz_1/clients' }), 'ok');
  assert.equal(await run(BillingController.prototype.preview, { method: 'POST', path: '/v1/biz/biz_1/billing/preview' }), 'ok');
  assert.equal(await run(ClientsController.prototype.search, { method: 'POST', path: '/v1/biz/biz_1/clients/search' }), 'ok');
  assert.deepEqual(reads, []);
});

test('метка @ReadOnly() стоит на всех POST-чтениях кабинета', () => {
  const reflector = new Reflector();
  const marked: [string, Handler][] = [
    ['clients/search', ClientsController.prototype.search],
    ['clients/count-matching', ClientsController.prototype.countMatching],
    ['clients/bulk/audience', ClientsController.prototype.bulkAudience],
    ['clients/export', ClientsController.prototype.exportClients],
    ['bookings/extras', BookingsController.prototype.extrasMany],
    ['journal/check', JournalController.prototype.check],
    ['journal/visit-id', JournalController.prototype.visitId],
    ['journal/data-ops', JournalController.prototype.logDataOp],
    ['series/preview', JournalController.prototype.previewSeries],
    ['booking-packages/check-linked', JournalController.prototype.checkLinked],
    ['journal/slot-offers/preview', SlotOffersController.prototype.preview],
    ['notify/mailings/audience-count', NotifyLogController.prototype.audienceCount],
    ['notify/templates/:kind/preview', NotifyController.prototype.preview],
    ['staff/notify-prefs-rich/any-configured', NotifyController.prototype.anyStaffPrefsConfigured],
    ['schedule/table', ScheduleController.prototype.table],
    ['schedule/has-saved', ScheduleController.prototype.hasSaved],
    ['schedule/affected', ScheduleController.prototype.affected],
    ['schedule/day-info', ScheduleController.prototype.dayInfo],
    ['schedule/move-candidates', ScheduleController.prototype.moveCandidates],
    ['schedule/cells/snapshot', ScheduleController.prototype.snapshot],
    ['resources/series/by-ids', ResourcesEventsController.prototype.listSeriesDefsByIds],
    ['resources/free-instances', ResourcesController.prototype.freeInstances],
    ['resources/check-instances-free', ResourcesController.prototype.checkFree],
    ['resources/options', ResourcesController.prototype.options],
    ['package-slots', JournalMoreController.prototype.packageSlots],
    ['loyalty/x/{op}', LoyaltyPortController.prototype.call],
    ['loyalty/app/{op}', BizClientLoyaltyController.prototype.call],
    ['exports-log', JournalsController.prototype.logExport],
    ['data-ops', JournalsController.prototype.logDataOp],
    ['reports/exports', ReportsController.prototype.logManualExport],
    ['reports/:name/export', ReportsController.prototype.requestExport],
    ['billing/preview', BillingController.prototype.preview],
  ];
  for (const [route, handler] of marked) assert.ok(reflector.get(READ_ONLY_KEY, handler), `${route} must be @ReadOnly()`);
  // записи не помечены
  for (const handler of [ClientsController.prototype.createClient, ScheduleController.prototype.apply]) assert.equal(reflector.get(READ_ONLY_KEY, handler), undefined);
});

test('операции чтения лояльности — только чтения', () => {
  assert.ok(BIZ_READ_OPS.size > 30);
  for (const op of BIZ_READ_OPS) {
    assert.ok(op in BIZ_OPS, op);
    assert.match(op, /^(list|get|has|preview|find|financeLinesOf)/, `${op} looks like a write`);
  }
  for (const op of Object.keys(BIZ_OPS)) {
    if (/^(create|update|delete|set|issue|sell|adjust|void|refund|open|topup|charge|cancel|commit|reverse|sync|confirm|reject|duplicate)/.test(op)) assert.ok(!BIZ_READ_OPS.has(op), `${op} must not be read-only`);
  }
  for (const op of BIZ_APP_READ_OPS) assert.match(op, /^(list|count|find|get)/);
});
