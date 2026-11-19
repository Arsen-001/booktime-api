/**
 * F-09-046/047 — доля ассистента в зарплате. ТЕ ЖЕ числа, что тест сайта src/domain/rules/tests/payroll-assist.test.ts:
 * мок и сервер считают одним правилом. Мариам — маникюр 10 000, ставки «без ассистента» 50 %, «как ассистент» 10 %,
 * своя ставка 30 %; Ани ассистирует в одном визите. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { assistantsLookup, computeAssistSplit, computeServicesForDay, emptySchemeBlocks, lineAssistantsOf, withAssistedMasters } = await import('./payroll-engine.js');
type EffectiveScheme = import('./payroll-engine.js').EffectiveScheme;
type EngineBooking = import('./payroll-engine.js').EngineBooking;

function mariamScheme(): EffectiveScheme {
  const s = { ...emptySchemeBlocks(), staffId: 'st_mariam', createdAt: '2026-09-01T00:00:00.000Z' } as EffectiveScheme;
  s.personalServices = {
    ...s.personalServices,
    enabled: true,
    defaultPayout: { unit: 'percent', value: 30 },
    assistRates: { withoutAssistant: { unit: 'percent', value: 50 }, asAssistant: { unit: 'percent', value: 10 } },
  };
  return s;
}

const line = { serviceId: 'sv_mani', staffId: 'st_mariam', price: 10000, qty: 1 };
// 01.10 10:00 и 12:00 по Еревану
const assisted: EngineBooking = {
  id: 'bk_assist', locationId: 'loc_1', status: 'arrived', deletedAt: null, startAt: new Date('2026-10-01T06:00:00Z'), total: 10000, groupEventId: null, services: [line],
  lineAssistants: lineAssistantsOf({ serviceLineExtras: [{ discountPct: 0, assistants: [{ staffId: 'st_ani', sharePct: 100 }] }] }),
};
const alone: EngineBooking = { id: 'bk_alone', locationId: 'loc_1', status: 'arrived', deletedAt: null, startAt: new Date('2026-10-01T08:00:00Z'), total: 10000, groupEventId: null, services: [line] };
const services = [{ id: 'sv_mani', categoryId: null, name: 'Маникюр', priceMin: 10000 }];

function dayOps(staffIds: string[], schemes: Map<string, EffectiveScheme>) {
  const bookings = [assisted, alone];
  return computeServicesForDay({ date: '2026-10-01', locationId: 'loc_1', staffIds, bookings, services, schemes, assistantsForLine: assistantsLookup(bookings) });
}

test('Мариам: с ассистентом 5 000 − 1 000 = 4 000, без ассистента — своя ставка 30 % = 3 000; Ани — 1 000', () => {
  const ops = dayOps(['st_mariam', 'st_ani'], new Map([['st_mariam', mariamScheme()]]));
  assert.deepEqual(ops.get('st_mariam')?.map((o) => [o.bookingId, o.amount]), [['bk_assist', 4000], ['bk_alone', 3000]]);
  assert.deepEqual(ops.get('st_ani')?.map((o) => [o.bookingId, o.amount, o.lines[0]?.refId]), [['bk_assist', 1000, 'assist:sv_mani']]);
});

test('ведомость Ани (только она) — доля есть, когда в схемах есть схема мастера строки', () => {
  assert.deepEqual(withAssistedMasters(['st_ani'], [assisted, alone]), ['st_ani', 'st_mariam']);
  const ops = dayOps(['st_ani'], new Map([['st_mariam', mariamScheme()]]));
  assert.equal(ops.get('st_ani')?.reduce((s, o) => s + o.amount, 0), 1000);
  assert.equal(dayOps(['st_ani'], new Map()).get('st_ani')?.length ?? 0, 0);
});

test('ставка «с ассистентом» задана — мастер берёт её целиком; два ассистента «делится» — по долям', () => {
  const r = computeAssistSplit(10000, { withoutAssistant: { unit: 'percent', value: 50 }, withAssistant: { unit: 'percent', value: 45 }, asAssistant: { unit: 'percent', value: 10 } }, [
    { staffId: 'a', sharePct: 50 },
    { staffId: 'b', sharePct: 50 },
  ]);
  assert.deepEqual(r, { masterAmount: 4500, assistants: [{ staffId: 'a', amount: 500 }, { staffId: 'b', amount: 500 }] });
  assert.deepEqual(lineAssistantsOf(null), []);
  assert.deepEqual(lineAssistantsOf({ serviceLineExtras: [{ discountPct: 5 }] }), [[]]);
});
