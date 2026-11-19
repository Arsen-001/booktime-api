/**
 * Копия перевода имени по буквам (scripts/sync-name-translit.mjs) не отстала от сайта: если рядом лежит
 * booking-platform, сгенерированные файлы должны совпадать с тем, что лежит здесь. Иначе — `node scripts/sync-name-translit.mjs`.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../../../scripts/sync-name-translit.mjs');

test('копия перевода имён совпадает с сайтом', async (t) => {
  const mod = (await import(pathToFileURL(script).href)) as { generate: (front?: string) => Record<string, string>; DEFAULT_FRONT: string };
  if (!fs.existsSync(path.join(mod.DEFAULT_FRONT, 'src/lib/translit.ts'))) {
    t.skip('сайта рядом нет');
    return;
  }
  for (const [file, text] of Object.entries(mod.generate())) {
    assert.equal(fs.readFileSync(path.join(here, file), 'utf8'), text, `${file} устарел — node scripts/sync-name-translit.mjs`);
  }
});
