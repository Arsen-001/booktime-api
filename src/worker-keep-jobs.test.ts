/**
 * 17.11.2026: Redis production дорос до 1,18 ГБ — расписания воркера ставили задачи без `removeOnComplete`, и BullMQ
 * хранил каждое выполнение навсегда (notify.dispatch раз в 20 с, reports.export раз в 15 с, … — ~15 тыс. записей в
 * сутки). Новое расписание без `opts: KEEP_JOBS` снова начнёт копить мусор — этот тест не даст его забыть.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');

test('каждое расписание воркера удаляет свои выполненные задачи (opts: KEEP_JOBS)', () => {
  const calls = source.split('\n').filter((line) => line.includes('upsertJobScheduler('));
  assert.ok(calls.length > 10, 'расписаний в worker.ts не нашлось — тест устарел');
  const missing = calls.filter((line) => !line.includes('opts: KEEP_JOBS'));
  assert.deepEqual(missing, [], `без opts: KEEP_JOBS:\n${missing.join('\n')}`);
});

test('KEEP_JOBS хранит выполненные час, упавшие неделю', () => {
  assert.match(source, /removeOnComplete:\s*\{\s*age:\s*3600,\s*limit:\s*1000\s*\}/);
  assert.match(source, /removeOnFail:\s*\{\s*age:\s*7 \* 24 \* 3600,\s*limit:\s*1000\s*\}/);
});
