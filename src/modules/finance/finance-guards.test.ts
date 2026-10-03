/**
 * Финансы (хвосты qa/full-test-0930, 03.10.2026): идемпотентность операций предоплаты на реквизиты мастера,
 * 409 на правку/отмену операции оплаты визита и пополнения счёта, 409 на удаление кассы со способом оплаты,
 * Z-отчёт смены по времени проведения (createdAt), а не по дате операции. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { recordPrepaymentReceivedTx, recordPrepaymentRefundTx, PREPAYMENT_LINE_LABEL } = await import('./prepayment-ops.js');
const { FinOpsService } = await import('./fin-ops.service.js');
const { FinanceCatalogService } = await import('./finance-catalog.service.js');
const { CashShiftsService } = await import('./cash-shifts.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

// ─────────────────────────── Мини-Prisma в памяти: ровно то, чем пользуются проверяемые функции ───────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

function matches(r: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Where[]).some((w) => matches(r, w));
    if (v === undefined) return true;
    if (v === null) return r[k] === null || r[k] === undefined;
    if (typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('in' in o) return (o.in as unknown[]).includes(r[k]);
      if ('not' in o) return r[k] !== o.not;
      if ('gte' in o || 'lte' in o || 'lt' in o || 'gt' in o) {
        return (o.gte === undefined || cmp(r[k], o.gte) >= 0) && (o.lte === undefined || cmp(r[k], o.lte) <= 0) && (o.lt === undefined || cmp(r[k], o.lt) < 0) && (o.gt === undefined || cmp(r[k], o.gt) > 0);
      }
    }
    return r[k] === v;
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) row[k] = ((row[k] as bigint | number) ?? 0) + ((v as { increment: never }).increment as never);
    else if (v !== undefined) row[k] = v;
  }
  return row;
}

function table(rows: Row[] = [], defaults: () => Row = () => ({})) {
  return {
    rows,
    findFirst: async ({ where }: { where?: Where } = {}) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
    findFirstOrThrow: async ({ where }: { where?: Where } = {}) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error('not found');
      return r;
    },
    findUniqueOrThrow: async ({ where }: { where: Where }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error('not found');
      return r;
    },
    findMany: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)),
    count: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      const row = { ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        if (skipDuplicates && rows.some((r) => r.id === d.id)) continue;
        rows.push({ ...defaults(), ...d });
        count += 1;
      }
      return { count };
    },
    update: async ({ where, data }: { where: Where; data: Row }) => applyData(rows.find((r) => matches(r, where))!, data),
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => applyData(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: { where: Where }) => rows.splice(rows.findIndex((r) => matches(r, where)), 1)[0],
    aggregate: async ({ where }: { where?: Where }) => ({ _max: { order: rows.filter((r) => matches(r, where)).reduce<number | null>((m, r) => Math.max(m ?? -1, r.order as number), null) } }),
  };
}

function memoryDb() {
  const db = {
    paymentItem: table(),
    paymentMethod: table(),
    cashRegister: table([], () => ({ openingBalance: 0n, order: 0 })),
    cashShift: table(),
    client: table(),
    finOp: table([], () => ({ cancelled: false, createdAt: new Date(), refundedAmount: 0n, history: [] })),
    auditLog: table(),
    $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as Promise<unknown>[])),
  };
  return db;
}

const noAudit = { record: async () => undefined } as never;
const ctx = { requestId: 'r', ip: '', device: '', session: null, member: { businessId: 'biz_1', staffId: 'st_1', permissions: new Set<string>() } } as never;

async function rejectsWith(p: Promise<unknown>, code: string, status: number) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code && e.status === status);
}

// ─────────────────────────── Предоплата на реквизиты: «Деньги пришли» / «Вернул» — идемпотентно ───────────────────────────

const booking = { id: 'bk_1', businessId: 'biz_1', locationId: 'loc_1', clientId: 'cl_1', prepayment: { amount: 3000, paid: true } };

test('«Деньги пришли» дважды — одна операция прихода на кассу «Предоплата на реквизиты»', async () => {
  const db = memoryDb();
  db.client.rows.push({ id: 'cl_1', name: 'Анна' });
  await recordPrepaymentReceivedTx(db as never, booking, 'st_1');
  await recordPrepaymentReceivedTx(db as never, booking, 'st_1');
  const ops = db.finOp.rows.filter((o) => o.lineLabel === PREPAYMENT_LINE_LABEL);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, 'income');
  assert.equal(ops[0]!.amount, 3000n);
  assert.equal(ops[0]!.method, 'transfer');
  assert.equal(db.cashRegister.rows.length, 1, 'одна системная касса на филиал');
  assert.equal(db.cashRegister.rows[0]!.systemGenerated, true);
});

test('«Вернул» дважды — один расход «Возврат» на ту же сумму с той же кассы', async () => {
  const db = memoryDb();
  await recordPrepaymentReceivedTx(db as never, booking, 'st_1');
  await recordPrepaymentRefundTx(db as never, booking, 'st_1');
  await recordPrepaymentRefundTx(db as never, booking, 'st_1');
  const income = db.finOp.rows.filter((o) => o.kind === 'income');
  const expense = db.finOp.rows.filter((o) => o.kind === 'expense');
  assert.equal(expense.length, 1);
  assert.equal(expense[0]!.amount, 3000n);
  assert.equal(expense[0]!.accountId, income[0]!.accountId);
  assert.equal(expense[0]!.refundOfId, income[0]!.id);
  assert.equal(income[0]!.refundedAmount, 3000n);
});

test('«Вернул» без прихода и предоплата 0 — ничего не проводится', async () => {
  const db = memoryDb();
  await recordPrepaymentRefundTx(db as never, booking, 'st_1');
  await recordPrepaymentReceivedTx(db as never, { ...booking, prepayment: { amount: 0 } }, 'st_1');
  assert.equal(db.finOp.rows.length, 0);
});

// ─────────────────────────── 409: операция оплаты визита и пополнения счёта правится только там, где провели ───────────────────────────

for (const source of ['booking', 'account'] as const) {
  test(`операция source=${source}: правка и отмена со страницы операции — 409 operation_linked`, async () => {
    const db = memoryDb();
    db.finOp.rows.push({ id: 'op_1', businessId: 'biz_1', source, cancelled: false, amount: 5000n, history: [] });
    const svc = new FinOpsService(db as never, noAudit, {} as never);
    await rejectsWith(svc.update(ctx, 'op_1', { amount: 1 } as never), 'operation_linked', 409);
    await rejectsWith(svc.cancel(ctx, 'op_1'), 'operation_linked', 409);
    assert.equal(db.finOp.rows[0]!.cancelled, false);
    assert.equal(db.finOp.rows[0]!.amount, 5000n);
  });
}

// ─────────────────────────── 409: касса, куда способ оплаты кладёт деньги, не удаляется ───────────────────────────

test('удаление кассы со способом оплаты — 409 account_in_use; без способа и операций — удаляется', async () => {
  const db = memoryDb();
  db.cashRegister.rows.push({ id: 'acc_1', businessId: 'biz_1', name: 'Основная' }, { id: 'acc_2', businessId: 'biz_1', name: 'Запасная' });
  db.paymentMethod.rows.push({ id: 'pm_1', businessId: 'biz_1', key: 'cash', accountId: 'acc_1', active: true });
  const svc = new FinanceCatalogService(db as never, noAudit);
  await rejectsWith(svc.removeCashRegister(ctx, 'acc_1'), 'account_in_use', 409);
  assert.ok(db.cashRegister.rows.some((r) => r.id === 'acc_1'));
  await svc.removeCashRegister(ctx, 'acc_2');
  assert.ok(!db.cashRegister.rows.some((r) => r.id === 'acc_2'));
});

// ─────────────────────────── Z-отчёт: что ПРОВЕЛИ за смену (createdAt), а не дата операции ───────────────────────────

test('Z-отчёт смены берёт операции по createdAt: приход «задним числом» во время смены — в отчёте', async () => {
  const db = memoryDb();
  const opened = new Date('2026-10-03T08:00:00Z');
  db.cashRegister.rows.push({ id: 'acc_1', businessId: 'biz_1', locationId: 'loc_1', kind: 'cash', openingBalance: 0n });
  db.cashShift.rows.push({ id: 'sh_1', businessId: 'biz_1', accountId: 'acc_1', status: 'open', openedAt: opened, openedBy: 'st_1', openingCash: 1000n, expectedAtOpen: 1000n, closedAt: null, countedCash: null, expectedAtClose: null, adjustmentOperationIds: [] });
  const op = (id: string, amount: bigint, date: string, createdAt: string) => ({ id, businessId: 'biz_1', accountId: 'acc_1', kind: 'income', amount, method: 'cash', itemId: 'it_1', cancelled: false, date: new Date(date), createdAt: new Date(createdAt) });
  db.finOp.rows.push(
    op('op_back', 2000n, '2026-10-01T12:00:00Z', '2026-10-03T09:00:00Z'), // задним числом, проведена в смену — в отчёте
    op('op_before', 500n, '2026-10-03T10:00:00Z', '2026-10-03T07:00:00Z'), // проведена до смены (дата — будущая) — не в отчёте
    op('op_now', 300n, '2026-10-03T10:00:00Z', '2026-10-03T10:00:00Z'),
  );
  const svc = new CashShiftsService(db as never, noAudit, {} as never);
  const [view] = await svc.list('biz_1', 'acc_1');
  assert.equal(view!.report.income, 2300);
  assert.equal(view!.report.operationsCount, 2);
  assert.equal(view!.report.expected, 1000 + 2300);
});
