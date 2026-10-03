/** «Освободилось время»: кому предлагать окно и какую услугу (длительность, мастер, желания). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitlistOffer, type FreedWindow } from './waitlist-match.js';

const durations = new Map([
  ['sv_30', 30],
  ['sv_45', 45],
  ['sv_60', 60],
]);
const win = (over: Partial<FreedWindow> = {}): FreedWindow => ({ staffId: 'st_1', serviceIds: ['sv_30'], durationMin: 30, date: '2026-10-04', startMin: 13 * 60, ...over });

test('окно 30 мин не уходит ждущему услугу на 45 мин (сценарии 30.09)', () => {
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: ['sv_45'], wishes: [] }, win(), durations), null);
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: ['sv_45'], wishes: [] }, win({ serviceIds: ['sv_45'], durationMin: 30 }), durations), null, 'запись укоротили до 30 мин');
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: ['sv_45'], wishes: [] }, win({ serviceIds: ['sv_45'], durationMin: 45 }), durations), 'sv_45');
});

test('ждёт ту же услугу — предлагаем её; «любая услуга» — освободившуюся, если помещается', () => {
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: ['sv_45', 'sv_30'], wishes: [] }, win(), durations), 'sv_30');
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: [], wishes: [] }, win(), durations), 'sv_30');
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: [], wishes: [] }, win({ serviceIds: ['sv_60'], durationMin: 30 }), durations), null);
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: ['sv_60'], wishes: [] }, win(), durations), null, 'ждёт другую услугу');
});

test('мастер и желания: день, точное время, интервал', () => {
  assert.equal(waitlistOffer({ staffIds: ['st_2'], serviceIds: [], wishes: [] }, win(), durations), null);
  assert.equal(waitlistOffer({ staffIds: ['st_1'], serviceIds: [], wishes: [{ date: '2026-10-05' }] }, win(), durations), null);
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: [], wishes: [{ date: '2026-10-04', time: '13:00' }] }, win(), durations), 'sv_30');
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: [], wishes: [{ time: '12:00' }] }, win(), durations), null);
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: [], wishes: [{ intervals: [{ from: '12:00', to: '14:00' }] }] }, win(), durations), 'sv_30');
  assert.equal(waitlistOffer({ staffIds: [], serviceIds: [], wishes: [{ intervals: [{ from: '14:00', to: '18:00' }] }] }, win(), durations), null);
});
