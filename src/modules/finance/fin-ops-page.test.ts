import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareLightAsc, type LightOp } from './fin-ops.service.js';

// Порядок «Финансы → Операции» страницей (17.11.2026) — тот же, что compareOperationsAsc фронта: по нему считается
// «Остаток в кассе», и строки одной минуты стоят одинаково в списке, выгрузке и остатке.
const op = (id: string, date: string, extra: Partial<LightOp> = {}): LightOp => ({
  id,
  accountId: 'acc',
  kind: 'income',
  amount: 1000n,
  cancelled: false,
  date: new Date(date),
  createdAt: new Date(date),
  feeOfOperationId: null,
  ...extra,
});

test('секунды не важны: в одной минуте приход раньше расхода', () => {
  const expense = op('a', '2026-11-17T10:05:10Z', { kind: 'expense' });
  const income = op('b', '2026-11-17T10:05:50Z');
  assert.deepEqual([expense, income].sort(compareLightAsc).map((x) => x.id), ['b', 'a']);
});

test('комиссия — после своей оплаты, даже если создана раньше', () => {
  const pay = op('pay', '2026-11-17T10:05:00Z', { createdAt: new Date('2026-11-17T10:06:00Z') });
  const fee = op('fee', '2026-11-17T10:05:00Z', { kind: 'expense', feeOfOperationId: 'pay' });
  assert.deepEqual([fee, pay].sort(compareLightAsc).map((x) => x.id), ['pay', 'fee']);
});

test('разные минуты — по времени; одна минута и вид — по минуте создания, потом по id', () => {
  const late = op('z', '2026-11-17T11:00:00Z');
  const early = op('y', '2026-11-17T09:00:00Z');
  const sameA = op('b', '2026-11-17T10:00:00Z', { createdAt: new Date('2026-11-17T10:00:30Z') });
  const sameB = op('a', '2026-11-17T10:00:00Z', { createdAt: new Date('2026-11-17T10:00:59Z') });
  assert.deepEqual([late, sameA, early, sameB].sort(compareLightAsc).map((x) => x.id), ['y', 'a', 'b', 'z']);
});
