// Переносит перевод имени по буквам с сайта на сервер (владелец 17.11.2026, DESIGN.md «Ответы…» №8 и «К 8»): имя
// мастера в уведомлениях клиенту — на языке клиента; не вписан перевод в staff.name_i18n — переводом букв, ровно как
// сайт. Источник правды — сайт (его tsc и тест name-translit), здесь меняются только импорты:
//   booking-platform/src/lib/nameWords.ts                          → src/common/i18n/name-translit/name-words.ts
//   booking-platform/src/lib/translit.ts                           → src/common/i18n/name-translit/translit.ts
//   booking-platform/src/domain/rules/tests/name-translit.test.ts  → src/common/i18n/name-translit/name-translit.test.ts
// После правки этих файлов на сайте: `node scripts/sync-name-translit.mjs` (тест name-translit-sync сверяет копию с сайтом).
//   node scripts/sync-name-translit.mjs [--front /path/to/booking-platform]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/common/i18n/name-translit');
export const DEFAULT_FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../booking-platform');

const SOURCES = {
  'name-words.ts': 'src/lib/nameWords.ts',
  'translit.ts': 'src/lib/translit.ts',
  'name-translit.test.ts': 'src/domain/rules/tests/name-translit.test.ts',
};

const head = (src) =>
  `// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-name-translit.mjs из booking-platform/${src}; руками не править.\n` +
  `// Типы проверяет tsc сайта (noUncheckedIndexedAccess у сайта выключен, у сервера включён — отсюда nocheck).\n`;

/** Содержимое копий по файлам сайта: { 'translit.ts': '…' } */
export function generate(front = DEFAULT_FRONT) {
  const out = {};
  for (const [file, rel] of Object.entries(SOURCES)) {
    let text = fs.readFileSync(path.join(front, rel), 'utf8').replace(/^'use client';\n+/, '');
    text = text.replace(/from '@\/lib\/nameWords'/g, "from './name-words.js'").replace(/from '@\/lib\/translit'/g, "from './translit.js'");
    const unknown = text.match(/from '@\/[^']+'/g);
    if (unknown) throw new Error(`${rel}: неизвестные импорты ${unknown.join(', ')} — дополните sync-name-translit.mjs`);
    out[file] = head(rel) + text;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argFront = process.argv.indexOf('--front');
  const front = argFront > 0 ? process.argv[argFront + 1] : DEFAULT_FRONT;
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, text] of Object.entries(generate(front))) fs.writeFileSync(path.join(OUT, file), text);
  console.log('name-translit: name-words.ts, translit.ts, name-translit.test.ts обновлены из', front);
}
