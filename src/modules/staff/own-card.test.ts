/**
 * Мастер без «staff.view» (проход кабинета 17.11.2026): свою карточку и свою историю графика читает — «Материалы»,
 * «Документы» и «История правок» в его меню открывались с «Не удалось загрузить»; чужое — по-прежнему 403.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { StaffController } = await import('./staff.controller.js');
const { ScheduleController } = await import('../schedule/schedule.controller.js');
type Ctx = Parameters<InstanceType<typeof StaffController>['get']>[0];

const ctxOf = (staffId: string, permissions: string[]) => ({ member: { businessId: 'b1', staffId, permissions: new Set(permissions) } }) as unknown as Ctx;
const forbidden = (fn: () => unknown) => assert.throws(fn, (e: { code?: string }) => e.code === 'forbidden');

test('карточка: свою — без права, чужую — только со staff.view', async () => {
  const staff = new StaffController({ get: async (_b: string, s: string) => ({ id: s }) } as never);
  assert.deepEqual(await staff.get(ctxOf('m1', []), 'b1', 'm1'), { id: 'm1' });
  forbidden(() => staff.get(ctxOf('m1', []), 'b1', 'm2'));
  assert.deepEqual(await staff.get(ctxOf('own', ['staff.view']), 'b1', 'm2'), { id: 'm2' });
});

test('история графика: без staff.view — только своя, чужие сотрудники — 403', async () => {
  const asked: (string[] | undefined)[] = [];
  const schedule = new ScheduleController({ history: async (_b: string, ids?: string[]) => (asked.push(ids), []) } as never);
  await schedule.history(ctxOf('m1', []), 'b1', 'm1');
  await schedule.history(ctxOf('m1', []), 'b1', undefined);
  assert.deepEqual(asked, [['m1'], ['m1']]);
  forbidden(() => schedule.history(ctxOf('m1', []), 'b1', 'm1,m2'));
  await schedule.history(ctxOf('own', ['staff.view']), 'b1', undefined);
  assert.deepEqual(asked.at(-1), undefined);
});
