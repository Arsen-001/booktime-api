/** Увольнение будущей датой (С3, 11.10.2026): запланировать, отменить, вступить в силу в свой день. База в памяти. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { applyDueDismissals, isScheduledDismissal, todayLocal } = await import('./dismissal.js');
const { StaffService } = await import('./staff.service.js');
const { AuditService } = await import('../../common/audit/audit.service.js');
type Ctor = ConstructorParameters<typeof StaffService>;
type Row = Record<string, unknown>;

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function cond(value: unknown, c: unknown): boolean {
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    const o = c as Row;
    if ('in' in o && !(o.in as unknown[]).includes(value)) return false;
    if ('not' in o && (o.not === null ? value === null || value === undefined : value === o.not)) return false;
    if ('lte' in o && !(value !== null && value !== undefined && (value as string) <= (o.lte as string))) return false;
    return true;
  }
  return c === null ? value === null || value === undefined : value === c;
}
const matches = (r: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => cond(r[k], v));

function memoryDb(tables: Record<string, Row[]>) {
  const table = (name: string) => {
    const list = () => (tables[name] ??= []);
    const apply = (row: Row, data: Row) => {
      for (const [k, v] of Object.entries(data)) if (!(v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as Row))) row[k] = v;
    };
    return {
      findMany: async ({ where }: { where?: Row } = {}) => list().filter((r) => matches(r, where)),
      findFirst: async ({ where }: { where?: Row } = {}) => list().find((r) => matches(r, where)) ?? null,
      count: async ({ where }: { where?: Row } = {}) => list().filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Row }) => (list().push(data), data),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = list().find((r) => matches(r, where))!;
        apply(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = list().filter((r) => matches(r, where));
        for (const r of rows) apply(r, data);
        return { count: rows.length };
      },
      upsert: async () => ({}),
      findUnique: async ({ where }: { where: Row }) => list().find((r) => matches(r, where)) ?? null,
    };
  };
  const db: Row = Object.fromEntries(['staff', 'staffLogin', 'staffInvite', 'session', 'auditEvent', 'masterProfile', 'webhook'].map((n) => [n, table(n)]));
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return db;
}

const staff = (id: string, extra: Row = {}): Row => ({
  id, businessId: 'b1', role: 'master', status: 'active', userId: null, photos: [], materials: [], deletedAt: null, firedOn: null, firedAt: null, fireReason: null, ...extra,
});

function make(rows: Row[]) {
  const tables: Record<string, Row[]> = {
    staff: rows,
    staffLogin: [{ id: 'sl1', staffId: 'm2', disabledAt: null }],
    staffInvite: [],
    session: [{ id: 's1', staffLoginId: 'sl1', revokedAt: null }],
    auditEvent: [],
    masterProfile: [],
    webhook: [],
  };
  const db = memoryDb(tables);
  const sessions = { revokeAllOfStaffLogin: async () => 0 };
  const live = { publish: async () => undefined };
  const svc = new StaffService(db as unknown as Ctor[0], new AuditService(), sessions as unknown as Ctor[2], live as unknown as Ctor[3]);
  (svc as unknown as { get: (b: string, id: string) => Promise<Row> }).get = async (_b, id) => tables.staff!.find((s) => s.id === id)!;
  const ctx = { member: { staffId: 'owner', name: 'Владелец', businessId: 'b1' } } as unknown as Parameters<typeof svc.dismiss>[0];
  return { svc, tables, db, ctx };
}

test('дата в будущем — увольнение запланировано: сотрудник работает, вход не гаснет', async () => {
  const { svc, tables, ctx } = make([staff('owner', { role: 'owner' }), staff('m2')]);
  const date = addDays(todayLocal(), 5);
  await svc.dismiss(ctx, 'b1', 'm2', { date, reason: 'Переезд' });
  const m2 = tables.staff!.find((s) => s.id === 'm2')!;
  assert.equal(m2.status, 'active');
  assert.equal(m2.firedOn, date);
  assert.equal(m2.firedAt, null);
  assert.equal(tables.staffLogin![0]!.disabledAt, null);
  assert.ok(isScheduledDismissal(m2 as never));
  (svc as unknown as { find: (b: string, id: string) => Promise<Row> }).find = async (_b, id) => tables.staff!.find((s) => s.id === id)!;
  assert.deepEqual(await svc.dismissal('b1', 'm2'), { staffId: 'm2', date, reason: 'Переезд', scheduled: true, restore: 'immediate' });
  assert.equal(tables.auditEvent!.at(-1)!.action, 'dismissalScheduled');
});

test('дата сегодня — увольняет сразу, как раньше', async () => {
  const { svc, tables, ctx } = make([staff('owner', { role: 'owner' }), staff('m2')]);
  await svc.dismiss(ctx, 'b1', 'm2', { date: todayLocal(), reason: '' });
  const m2 = tables.staff!.find((s) => s.id === 'm2')!;
  assert.equal(m2.status, 'fired');
  assert.ok(m2.firedAt instanceof Date);
  assert.ok(tables.staffLogin![0]!.disabledAt instanceof Date);
});

test('«Вернуть» до даты отменяет запланированное увольнение', async () => {
  const { svc, tables, ctx } = make([staff('owner', { role: 'owner' }), staff('m2', { firedOn: addDays(todayLocal(), 3), fireReason: 'x' })]);
  (svc as unknown as { find: (b: string, id: string) => Promise<Row> }).find = async (_b, id) => tables.staff!.find((s) => s.id === id)!;
  await svc.restore(ctx, 'b1', 'm2');
  const m2 = tables.staff!.find((s) => s.id === 'm2')!;
  assert.equal(m2.firedOn, null);
  assert.equal(m2.status, 'active');
  assert.equal(await svc.dismissal('b1', 'm2'), null);
  assert.equal(tables.auditEvent!.at(-1)!.action, 'dismissalCancelled');
});

test('воркер: день настал — увольнение вступает в силу, логины и сессии гаснут; будущие не трогает', async () => {
  const today = todayLocal();
  const { tables, db } = make([
    staff('owner', { role: 'owner' }),
    staff('m2', { firedOn: today, fireReason: 'Переезд' }),
    staff('m3', { firedOn: addDays(today, 1) }),
    staff('m4', { status: 'fired', firedOn: addDays(today, -3), firedAt: new Date() }),
  ]);
  const res = await applyDueDismissals(db as never, new AuditService(), today);
  assert.deepEqual(res, { fired: ['m2'], skipped: [] });
  const m2 = tables.staff!.find((s) => s.id === 'm2')!;
  assert.equal(m2.status, 'fired');
  assert.equal(m2.firedOn, today);
  assert.equal(m2.fireReason, 'Переезд');
  assert.ok(tables.staffLogin![0]!.disabledAt instanceof Date);
  assert.ok(tables.session![0]!.revokedAt instanceof Date);
  assert.equal(tables.staff!.find((s) => s.id === 'm3')!.status, 'active');
  const audit = tables.auditEvent!.at(-1)!;
  assert.equal(audit.action, 'fired');
  assert.equal(audit.actorType, 'system');
});

test('воркер: последнего владельца не увольняет — пропуск', async () => {
  const today = todayLocal();
  const { tables, db } = make([staff('owner', { role: 'owner', firedOn: today })]);
  const res = await applyDueDismissals(db as never, new AuditService(), today);
  assert.deepEqual(res, { fired: [], skipped: ['owner'] });
  assert.equal(tables.staff![0]!.status, 'active');
});
