// Переносит расчётный слой раздела «Лояльность» фронта на сервер (этап 21, лейн loyalty):
//   booking-platform/src/domain/core.ts     → src/modules/loyalty/port/core-types.ts (только типы)
//   booking-platform/src/domain/loyalty.ts  → src/modules/loyalty/port/domain.ts
//   booking-platform/src/api/loyalty.ts     → src/modules/loyalty/port/logic.ts
// Источник правды логики — фронт (он проверен его tsc и экранами); здесь меняются только импорты: срез и ядро
// читаются через port/shim.ts (AsyncLocalStorage с состоянием бизнеса из базы), а строки `if (isApiMode()) …`
// фасада выбрасываются. После правки loyalty.ts во фронте: `node scripts/sync-loyalty-port.mjs` и `npm run build`.
//   node scripts/sync-loyalty-port.mjs [--front /path/to/booking-platform]
import fs from 'node:fs';
import path from 'node:path';

const argFront = process.argv.indexOf('--front');
const FRONT = argFront > 0 ? process.argv[argFront + 1] : path.resolve(import.meta.dirname, '../../booking-platform');
const OUT = path.resolve(import.meta.dirname, '../src/modules/loyalty/port');
const HEAD = (src) => `// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-loyalty-port.mjs из booking-platform/${src}; руками не править.\n// Типы проверяет tsc фронта (noUncheckedIndexedAccess у фронта выключен, у сервера включён — отсюда nocheck).\n`;

function read(rel) {
  return fs.readFileSync(path.join(FRONT, rel), 'utf8').replace(/^'use client';\n+/, '');
}

const core = read('src/domain/core.ts');
fs.writeFileSync(path.join(OUT, 'core-types.ts'), HEAD('src/domain/core.ts') + core);

const domain = read('src/domain/loyalty.ts').replace(/from '@\/domain\/core'/g, "from './core-types.js'");
if (/from '@\//.test(domain)) throw new Error('domain/loyalty.ts: неизвестный импорт @/ — дополните sync-loyalty-port.mjs');
fs.writeFileSync(path.join(OUT, 'domain.ts'), HEAD('src/domain/loyalty.ts') + domain);

let logic = read('src/api/loyalty.ts');
logic = logic
  .split('\n')
  .filter((l) => !/^\s*if \(isApiMode\(\)\) return /.test(l))
  .filter((l) => !/^import .* from '@\/api\/(http|mode|loyalty\.server)';$/.test(l))
  .join('\n');
logic = logic
  .replace(/from '@\/api\/request'/g, "from './shim.js'")
  .replace(/from '@\/api\/area'/g, "from './shim.js'")
  .replace(/from '@\/api\/journal'/g, "from './stubs.js'")
  .replace(/from '@\/api\/finance'/g, "from './stubs.js'")
  .replace(/from '@\/domain\/core'/g, "from './core-types.js'")
  .replace(/from '@\/domain\/journal'/g, "from './stubs.js'")
  .replace(/from '@\/domain\/loyalty'/g, "from './domain.js'")
  .replace(/from '@\/lib\/date'/g, "from './shim.js'")
  .replace(/from '@\/lib\/id'/g, "from './shim.js'")
  // «сейчас» — по стенным часам Еревана (сервер в UTC): getDay()/getHours() расписания акций, окно «Вернуть»
  .replace(/\bDate\.now\(\)/g, 'portNowDate().getTime()')
  .replace(/new Date\(\)/g, 'portNowDate()');
logic = "import { portNowDate } from './shim.js';\n" + logic;
// внутренние хелперы, которые фронт зовёт отдельным запросом (склейка оплаты визита с journal/finance)
logic += '\nexport { financeLinesOf, setTxFinanceLine };\n';
const unknown = logic.match(/from '@\/[^']+'/g);
if (unknown) throw new Error('api/loyalty.ts: неизвестные импорты ' + unknown.join(', ') + ' — дополните sync-loyalty-port.mjs');
if (/isApiMode/.test(logic)) throw new Error('api/loyalty.ts: осталась ветка isApiMode не в одну строку `if (isApiMode()) return …`');
fs.writeFileSync(path.join(OUT, 'logic.ts'), HEAD('src/api/loyalty.ts') + logic);
console.log('loyalty port: core-types.ts, domain.ts, logic.ts обновлены из', FRONT);

// ─── Проверка аргументов /loyalty/x/{op} (backend-2, заход 3): обязательные параметры функций фасада ───
// Из TS-сигнатур (logic.ts, client-ops.ts, extra-ops.ts) — сколько аргументов обязательны и какого они грубого вида
// (string | number | boolean | object | any). runner.service.ts отвечает 400 `validation`, не вызывая функцию, если
// обязательного аргумента нет или он не того вида — иначе фасад падал TypeError'ом (500) или писал undefined в срез.
function splitTop(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function kindOf(type) {
  const t = type.trim();
  if (/^(Id|string|ISODate|ISODateTime|Locale|SupportedLocale)$/.test(t) || /^'[^']*'(\s*\|\s*'[^']*')*$/.test(t)) return 'string';
  if (t === 'number' || t === 'Money') return 'number';
  if (t === 'boolean') return 'boolean';
  if (/\[\]$/.test(t) || /^(Array|ReadonlyArray)</.test(t)) return 'array';
  if (/^[A-Z]\w*(<.*>)?$/.test(t) || t.startsWith('{') || /^(Partial|Omit|Pick|Record)</.test(t)) return 'object';
  return 'any';
}
function signatures(src) {
  const table = {};
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*>)?\(/gm;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const params = splitTop(src.slice(start, i - 1));
    const required = [];
    for (const p of params) {
      if (p.startsWith('...')) break;
      const eq = splitTop(p.replace(/=/g, ',=')).findIndex((x) => x.startsWith('='));
      const [head, ...rest] = p.split(':');
      const optional = head.trim().endsWith('?') || eq >= 0 || /=/.test(p.replace(/=>/g, ''));
      if (optional) break;
      required.push(kindOf(rest.join(':').split('=')[0] ?? ''));
    }
    table[m[1]] ??= required;
  }
  return table;
}
const arity = {
  ...signatures(logic),
  ...signatures(fs.readFileSync(path.join(OUT, 'extra-ops.ts'), 'utf8')),
  ...signatures(fs.readFileSync(path.join(OUT, 'client-ops.ts'), 'utf8')),
};
fs.writeFileSync(
  path.join(OUT, 'arity.ts'),
  `// СГЕНЕРИРОВАНО scripts/sync-loyalty-port.mjs из сигнатур logic.ts / extra-ops.ts / client-ops.ts; руками не править.\n` +
    `/** Обязательные аргументы функций фасада лояльности: грубый вид каждого (string | number | boolean | array | object | any) */\n` +
    `export const REQUIRED_ARGS: Record<string, readonly ('string' | 'number' | 'boolean' | 'array' | 'object' | 'any')[]> = ${JSON.stringify(arity, null, 2)};\n`,
);
console.log('loyalty port: arity.ts —', Object.keys(arity).length, 'функций');
