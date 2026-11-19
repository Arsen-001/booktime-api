/**
 * Ведомость (владелец 17.11.2026): одобренная закрыта для правок (ответ 26), на уже начисленные дни не создаётся —
 * предлагаем только новые дни (ответ 27). Чистые правила движка. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { isStatementLocked, newDaysRange, nextApprovalStatus } = await import('./payroll-engine.js');

test('ответ 27: у Ани ведомость за 17.11 — новая за 1–17.11 предлагает только 1–16.11', () => {
  assert.deepEqual(newDaysRange([{ from: '2026-11-17', to: '2026-11-17' }], '2026-11-01', '2026-11-17'), { from: '2026-11-01', to: '2026-11-16' });
});

test('ответ 27: за 1–17.11 начислено — за 1–20.11 предлагаем 18–20.11, а за 1–17.11 начислять нечего', () => {
  const taken = [{ from: '2026-11-01', to: '2026-11-17' }];
  assert.deepEqual(newDaysRange(taken, '2026-11-01', '2026-11-20'), { from: '2026-11-18', to: '2026-11-20' });
  assert.equal(newDaysRange(taken, '2026-11-01', '2026-11-17'), null);
  assert.deepEqual(newDaysRange([], '2026-11-01', '2026-11-17'), { from: '2026-11-01', to: '2026-11-17' });
});

test('ответ 27: дыра посередине — последний непрерывный кусок новых дней', () => {
  const taken = [{ from: '2026-11-01', to: '2026-11-05' }, { from: '2026-11-10', to: '2026-11-12' }];
  assert.deepEqual(newDaysRange(taken, '2026-11-01', '2026-11-12'), { from: '2026-11-06', to: '2026-11-09' });
});

test('ответ 26: закрыта с «Одобрено» и дальше; «Отметить выплаченным» — следующий шаг после подписи', () => {
  assert.equal(isStatementLocked('pendingReview'), false);
  assert.equal(isStatementLocked('reviewed'), false);
  for (const s of ['approved', 'sentToStaff', 'signed', 'paid'] as const) assert.equal(isStatementLocked(s), true);
  assert.equal(isStatementLocked(undefined), false);
  assert.equal(nextApprovalStatus('signed'), 'paid');
});
