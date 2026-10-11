/**
 * График (11.10.2026): Г16 — заметка дня (название «Выходного салона») хранится и отдаётся везде, где читаются клетки;
 * Г10 — часы шаблона по дням недели (weekdayHours). База в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { ScheduleService } = await import('./schedule.service.js');
const { setCellsBody, templateBody, templatePatch } = await import('./schedule.schemas.js');
type Ctor = ConstructorParameters<typeof ScheduleService>;
type Row = Record<string, unknown>;

function cond(value: unknown, c: unknown): boolean {
  if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)) {
    const o = c as Row;
    if ('in' in o && !(o.in as unknown[]).includes(value)) return false;
    if ('not' in o && (o.not === null ? value === null || value === undefined : value === o.not)) return false;
    if ('gte' in o && !((value as string) >= (o.gte as string))) return false;
    if ('lte' in o && !((value as string) <= (o.lte as string))) return false;
    return true;
  }
  return c === null ? value === null || value === undefined : value === c;
}
const matches = (r: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => cond(r[k], v));
const DB_NULL = (v: unknown) => (v && typeof v === 'object' && (v as { constructor?: { name?: string } }).constructor?.name?.includes('Null') ? null : v);

function memoryPrisma(tables: Record<string, Row[]>) {
  const table = (name: string) => {
    const list = () => (tables[name] ??= []);
    const clean = (d: Row) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, DB_NULL(v)]));
    return {
      findMany: async ({ where }: { where?: Row } = {}) => list().filter((r) => matches(r, where)),
      findFirst: async ({ where }: { where?: Row } = {}) => list().find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => list().find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { createdAt: new Date('2026-10-11T08:00:00Z'), version: 1, ...clean(data) };
        list().push(row);
        return row;
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) list().push(clean(d));
        return { count: data.length };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = list().find((r) => matches(r, where))!;
        for (const [k, v] of Object.entries(clean(data))) if (!(v && typeof v === 'object' && 'increment' in (v as Row))) row[k] = v;
        return row;
      },
      updateMany: async () => ({ count: 0 }),
      deleteMany: async ({ where }: { where: Row }) => {
        const keep = list().filter((r) => !matches(r, where));
        const count = list().length - keep.length;
        tables[name] = keep;
        return { count };
      },
    };
  };
  const db: Row = Object.fromEntries(['staff', 'staffDayType', 'scheduleTemplate', 'workSchedule', 'scheduleDay', 'scheduleHistory', 'busyBlock'].map((n) => [n, table(n)]));
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return db;
}

function make() {
  const tables: Record<string, Row[]> = {
    staff: ['m1', 'm2'].map((id) => ({ id, businessId: 'b1', name: id, userId: null, calendarMode: 'free', status: 'active', locations: [{ locationId: 'loc1' }] })),
    staffDayType: [],
    scheduleTemplate: [],
    workSchedule: [],
    scheduleDay: [],
    scheduleHistory: [],
    busyBlock: [],
  };
  const availability = { schedules: async () => [], invalidate: async () => undefined };
  const svc = new ScheduleService(memoryPrisma(tables) as unknown as Ctor[0], availability as unknown as Ctor[1]);
  const ctx = { member: { staffId: 'm1', name: 'Анна', role: 'owner', businessId: 'b1', permissions: new Set(['schedule.edit', 'journal.others']) } } as unknown as Parameters<typeof svc.setCells>[0];
  return { svc, tables, ctx };
}

const holiday = (note?: string) =>
  setCellsBody.parse({ staffIds: ['m1', 'm2'], dates: ['2026-12-31', '2027-01-01'], typeId: 'not_working', hours: [], ...(note !== undefined ? { note } : {}) });

test('«Выходной салона»: название хранится и видно в day-info и слепке', async () => {
  const { svc, tables, ctx } = make();
  await svc.setCells(ctx, 'b1', holiday('Новый год'));
  assert.equal(tables.staffDayType!.length, 4);
  assert.ok(tables.staffDayType!.every((r) => r.note === 'Новый год'));
  assert.deepEqual(await svc.getStaffDayInfo('b1', ['m1', 'm2'], '2027-01-01'), {
    m1: { typeId: 'not_working', note: 'Новый год' },
    m2: { typeId: 'not_working', note: 'Новый год' },
  });
  const snap = await svc.snapshotCells('b1', ['m1'], ['2026-12-31']);
  assert.deepEqual(snap, [{ staffId: 'm1', date: '2026-12-31', hours: [], typeId: 'not_working', note: 'Новый год' }]);
});

test('без note заметка дня остаётся, пустая строка стирает', async () => {
  const { svc, tables, ctx } = make();
  await svc.setCells(ctx, 'b1', holiday('Новый год'));
  await svc.setCells(ctx, 'b1', setCellsBody.parse({ staffIds: ['m1'], dates: ['2026-12-31'], typeId: 'work', hours: [{ from: '10:00', to: '14:00' }] }));
  const day = () => tables.staffDayType!.find((r) => r.staffId === 'm1' && r.date === '2026-12-31')!;
  assert.equal(day().typeId, 'work');
  assert.equal(day().note, 'Новый год');
  await svc.setCells(ctx, 'b1', setCellsBody.parse({ staffIds: ['m1'], dates: ['2026-12-31'], typeId: 'not_working', hours: [], note: '' }));
  assert.equal(day().note, null);
  assert.equal(tables.staffDayType!.find((r) => r.staffId === 'm2' && r.date === '2026-12-31')!.note, 'Новый год', 'другие клетки не тронуты');
});

test('«Отменить»: restore возвращает заметку из слепка', async () => {
  const { svc, tables, ctx } = make();
  await svc.setCells(ctx, 'b1', holiday('Новый год'));
  const before = await svc.snapshotCells('b1', ['m1'], ['2026-12-31']);
  await svc.setCells(ctx, 'b1', setCellsBody.parse({ staffIds: ['m1'], dates: ['2026-12-31'], typeId: 'vacation', hours: [], note: 'Отпуск' }));
  await svc.restoreCells(ctx, 'b1', before);
  const day = tables.staffDayType!.find((r) => r.staffId === 'm1' && r.date === '2026-12-31')!;
  assert.equal(day.typeId, 'not_working');
  assert.equal(day.note, 'Новый год');
});

test('setCellsBody принимает note до 120 символов', () => {
  assert.equal(holiday('  Новый год ').note, 'Новый год');
  assert.throws(() => holiday('x'.repeat(121)));
});

test('шаблон «по дням недели»: weekdayHours сохраняются, отдаются и правятся', async () => {
  const { svc, ctx } = make();
  const body = templateBody.parse({
    name: 'Пн–пт 10–19, сб 10–16',
    kind: 'weekdays',
    weekdays: [0, 1, 2, 3, 4, 5],
    hours: [{ from: '10:00', to: '19:00' }],
    weekdayHours: { '5': [{ from: '10:00', to: '16:00' }] },
  });
  const t = await svc.createTemplate(ctx, 'b1', body);
  assert.deepEqual(t.weekdayHours, { '5': [{ from: '10:00', to: '16:00' }] });
  assert.deepEqual((await svc.templates('b1'))[0]!.weekdayHours, { '5': [{ from: '10:00', to: '16:00' }] });

  await svc.updateTemplate('b1', t.id, templatePatch.parse({ weekdayHours: { '4': [{ from: '12:00', to: '20:00' }] } }));
  assert.deepEqual((await svc.templates('b1'))[0]!.weekdayHours, { '4': [{ from: '12:00', to: '20:00' }] });

  await svc.updateTemplate('b1', t.id, templatePatch.parse({ weekdayHours: {} }));
  assert.equal((await svc.templates('b1'))[0]!.weekdayHours, undefined, 'пустой объект — снять');
});

test('шаблон «смены» не хранит weekdayHours; ключ дня недели вне 0–6 отклоняется', async () => {
  const { svc, ctx } = make();
  const t = await svc.createTemplate(ctx, 'b1', templateBody.parse({ kind: 'shifts', shiftWork: 2, shiftOff: 2, hours: [{ from: '09:00', to: '21:00' }], weekdayHours: { '1': [] } }));
  assert.equal(t.weekdayHours, undefined);
  assert.throws(() => templateBody.parse({ kind: 'weekdays', hours: [], weekdayHours: { '7': [] } }));
});
