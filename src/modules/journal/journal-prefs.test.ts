/**
 * Личные настройки журнала (17.11): «Мои наборы» мастеров и вид дня — в ответе только свои, чужие не видны.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { ownJournalPrefs } = await import('./journal.service.js');
const { defaultJournalArea } = await import('./journal-settings.js');

test('ownJournalPrefs: только свои наборы и вид дня', () => {
  const area = {
    ...defaultJournalArea(),
    staffSets: { st_a: [{ id: 'set_1', name: 'Утро', staffIds: ['st_b'] }], st_b: [{ id: 'set_2', name: 'Чужой', staffIds: [] }] },
    dayLayouts: { st_a: 'list', st_b: 'timeline' },
  };
  const mine = ownJournalPrefs(area, 'st_a');
  assert.deepEqual(mine.staffSets, { st_a: [{ id: 'set_1', name: 'Утро', staffIds: ['st_b'] }] });
  assert.deepEqual(mine.dayLayouts, { st_a: 'list' });
  assert.deepEqual(ownJournalPrefs(area, 'st_c').staffSets, {});
  assert.deepEqual(ownJournalPrefs(area, undefined).dayLayouts, {});
  // Остальные настройки — как были
  assert.equal(mine.zoomMin, area.zoomMin);
});
