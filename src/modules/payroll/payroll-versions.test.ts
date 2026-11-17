/**
 * Версии схемы зарплаты по датам (З6) и закрытый период (З11) — порт applySchemeVersion/schemeAtDate мока сайта.
 * Пример владельца: до 15.11 у мастера 35 %, с 15.11 — 40 % → за 01–14.11 по 35 %, за 15–17.11 по 40 %. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { applySchemeVersion, emptySchemeBlocks, schemeAtDate, schemeVersions } = await import('./payroll-engine.js');
type Versioned = import('./payroll-engine.js').VersionedScheme;

function percent(value: number, effectiveFrom?: string): Versioned {
  const s = emptySchemeBlocks();
  s.personalServices = { ...s.personalServices, enabled: true, defaultPayout: { unit: 'percent', value } };
  return { ...s, ...(effectiveFrom ? { effectiveFrom } : {}) };
}

function saved(existing: Versioned | undefined, next: Versioned, closedThrough?: string): Versioned {
  const r = applySchemeVersion(existing, next, closedThrough);
  assert.ok('scheme' in r, `ожидали сохранение, а не ${JSON.stringify(r)}`);
  return r.scheme;
}

const rateOn = (s: Versioned, date: string) => schemeAtDate(s, date).personalServices.defaultPayout.value;

test('35 % с самого начала, 40 % с 15.11: 01–14.11 по 35 %, 15–17.11 по 40 %', () => {
  const v1 = saved(undefined, percent(35));
  const v2 = saved(v1, percent(40, '2026-11-15'));
  assert.equal(schemeVersions(v2).length, 2);
  assert.equal(v2.history?.[0]?.effectiveFrom, undefined);
  for (const d of ['2026-10-01', '2026-11-01', '2026-11-14']) assert.equal(rateOn(v2, d), 35, d);
  for (const d of ['2026-11-15', '2026-11-17', '2026-12-01']) assert.equal(rateOn(v2, d), 40, d);
});

test('та же дата — правка текущей версии, история не растёт', () => {
  const v2 = saved(saved(undefined, percent(35)), percent(40, '2026-11-15'));
  const v3 = saved(v2, percent(42, '2026-11-15'));
  assert.equal(schemeVersions(v3).length, 2);
  assert.equal(rateOn(v3, '2026-11-16'), 42);
  assert.equal(rateOn(v3, '2026-11-14'), 35);
  // Без даты — тоже правка текущей версии, её «Действует с» остаётся
  const v4 = saved(v3, percent(45));
  assert.equal(v4.effectiveFrom, '2026-11-15');
  assert.equal(schemeVersions(v4).length, 2);
});

test('дата раньше текущей версии — пересечение; ставки в закрытом периоде — отказ', () => {
  const v2 = saved(saved(undefined, percent(35)), percent(40, '2026-11-15'));
  assert.deepEqual(applySchemeVersion(v2, percent(50, '2026-11-10')), { error: 'overlap' });
  assert.deepEqual(applySchemeVersion(v2, percent(50, '2026-11-20'), '2026-11-20'), { error: 'closed' });
  assert.deepEqual(applySchemeVersion(undefined, percent(50, '2026-11-01'), '2026-11-10'), { error: 'closed' });
  // После закрытого периода — можно; ставки не менялись — дата в закрытом периоде не мешает
  assert.ok('scheme' in applySchemeVersion(v2, percent(50, '2026-11-21'), '2026-11-20'));
  assert.ok('scheme' in applySchemeVersion(v2, percent(40), '2026-11-20'));
});

test('порядок ключей JSON (MySQL хранит по-своему) не делает схему «изменённой»', () => {
  const v1 = saved(undefined, percent(35));
  const same = { ...v1, personalServices: Object.fromEntries(Object.entries(v1.personalServices).reverse()) as Versioned['personalServices'] };
  const r = saved(v1, { ...same, effectiveFrom: '2026-11-15' });
  // Блоки те же — новая дата двигает текущую версию, а не заводит вторую
  assert.equal(schemeVersions(r).length, 1);
  assert.equal(r.effectiveFrom, '2026-11-15');
});

test('классика, оклад: правило создано 01.09, Ани назначена 10.10 → октябрь не начисляется, ноябрь — да', async () => {
  const { classicSchemeStart, monthlySalaryQualifies, ruleAsScheme } = await import('./payroll-engine.js');
  const rule = { ...emptySchemeBlocks(), createdAt: '2026-09-01T09:00' };
  const scheme = ruleAsScheme(rule, 'st_nuri_ani', '2026-10-10');
  assert.equal(scheme.createdAt, '2026-10-10');
  assert.equal(monthlySalaryQualifies('2026-10', 160, scheme.createdAt), false);
  assert.equal(monthlySalaryQualifies('2026-11', 160, scheme.createdAt), true);
  // Правило создали позже назначения — действует с даты создания
  assert.equal(classicSchemeStart('2026-11-05T12:00', '2026-10-10'), '2026-11-05');
});
