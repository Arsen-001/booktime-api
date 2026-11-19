// @ts-nocheck — СГЕНЕРИРОВАНО scripts/sync-name-translit.mjs из booking-platform/src/lib/translit.ts; руками не править.
// Типы проверяет tsc сайта (noUncheckedIndexedAccess у сайта выключен, у сервера включён — отсюда nocheck).
/**
 * Латиница для показа имён в английском интерфейсе (владелец, 01.10.2026): «Анна Саргсян» → «Anna Sargsyan»,
 * «Աննա» → «Anna». Только отображение — данные не меняются. Латиница и прочие символы проходят как есть.
 *   translitName('Салон «Лилия»') // 'Salon «Liliya»'
 */

import { NAME_WORDS } from './name-words.js';

const RU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const HY: Record<string, string> = {
  ա: 'a', բ: 'b', գ: 'g', դ: 'd', ե: 'e', զ: 'z', է: 'e', ը: 'y', թ: 't', ժ: 'zh', ի: 'i', լ: 'l', խ: 'kh', ծ: 'ts',
  կ: 'k', հ: 'h', ձ: 'dz', ղ: 'gh', ճ: 'ch', մ: 'm', յ: 'y', ն: 'n', շ: 'sh', ո: 'o', չ: 'ch', պ: 'p', ջ: 'j', ռ: 'r',
  ս: 's', վ: 'v', տ: 't', ր: 'r', ց: 'ts', ւ: 'v', փ: 'p', ք: 'k', և: 'ev', օ: 'o', ֆ: 'f',
};

const HAS_NON_LATIN = /[Ѐ-ӿ԰-֏]/;

function isLetter(ch: string | undefined): boolean {
  return Boolean(ch && /\p{L}/u.test(ch));
}

/** Кириллица (ru) и армянский алфавит → латиница; регистр первой буквы сохраняется */
export function translit(text: string): string {
  if (!text || !HAS_NON_LATIN.test(text)) return text;
  let out = '';
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const lower = ch.toLowerCase();
    const upper = ch !== lower;
    const wordStart = !isLetter(chars[i - 1]);
    let latin: string | undefined;
    // Армянский: «ու» → u, «ե»/«ո» в начале слова → ye/vo (Երևան → Yerevan, Ոսկի → Voski)
    if (lower === 'ո' && chars[i + 1]?.toLowerCase() === 'ւ') {
      latin = 'u';
      i++;
    } else if (lower === 'ե' && wordStart) latin = 'ye';
    else if (lower === 'ո' && wordStart) latin = 'vo';
    else latin = RU[lower] ?? HY[lower];
    if (latin === undefined) {
      out += ch;
      continue;
    }
    if (!upper || !latin) {
      out += latin;
      continue;
    }
    // «ЖАННА» → «ZHANNA», «Жанна» → «Zhanna»
    const nextUpper = chars[i + 1] !== undefined && isLetter(chars[i + 1]) && chars[i + 1] === chars[i + 1].toUpperCase();
    out += nextUpper ? latin.toUpperCase() : latin[0].toUpperCase() + latin.slice(1);
  }
  return out;
}

// ─────────── Имя на трёх языках (владелец 17.11.2026, DESIGN.md «Ответы…» №8) ───────────
// Имя мастера вписали на одном языке — остальные заполняются переводом букв («Ани Саргсян» → «Անի Սարգսյան»,
// «Ani Sargsyan»), владелец может поправить. Частые армянские имена и фамилии — из словаря (lib/nameWords): по буквам
// «Мелкумян» стал бы «Մելկումյան» (к ↔ կ/ք не различить), остальное — правилами ниже.


export type NameLocale = 'ru' | 'hy' | 'en';

const HY_LETTER = /[԰-֏]/;
const RU_LETTER = /[Ѐ-ӿ]/;
const LATIN_LETTER = /[A-Za-z]/;

/** На каком письме вписано имя: армянские буквы → hy, кириллица → ru, латиница → en; цифры/пусто — undefined */
export function nameScript(text: string | undefined | null): NameLocale | undefined {
  if (!text) return undefined;
  if (HY_LETTER.test(text)) return 'hy';
  if (RU_LETTER.test(text)) return 'ru';
  if (LATIN_LETTER.test(text)) return 'en';
  return undefined;
}

interface NameWord {
  ru: string;
  hy: string;
  en: string;
}

let wordIndex: Map<string, NameWord> | undefined;
/** Словарь в обе стороны: ключ — слово строчными на любом из трёх языков */
function nameWordIndex(): Map<string, NameWord> {
  if (wordIndex) return wordIndex;
  wordIndex = new Map();
  for (const [ru, hy, en] of NAME_WORDS) {
    const w: NameWord = { ru, hy, en: en ?? translit(hy) };
    for (const form of [w.ru, w.hy, w.en]) {
      const key = form.toLowerCase();
      if (!wordIndex.has(key)) wordIndex.set(key, w);
    }
  }
  return wordIndex;
}

/** Армянская заглавная — строчная минус 0x30 (ա U+0561 → Ա U+0531) */
function hyUpper(s: string): string {
  if (!s) return s;
  const first = s[0];
  const code = first.codePointAt(0)!;
  if (first === 'և') return `Եվ${s.slice(1)}`;
  return code >= 0x561 && code <= 0x586 ? String.fromCodePoint(code - 0x30) + s.slice(1) : s.charAt(0).toUpperCase() + s.slice(1);
}

function capitalLike(source: string, out: string, toHy: boolean): string {
  const first = source.charAt(0);
  if (!first || first === first.toLowerCase()) return out;
  return toHy ? hyUpper(out) : out.charAt(0).toUpperCase() + out.slice(1);
}

const RU_HY: Record<string, string> = {
  а: 'ա', б: 'բ', в: 'վ', г: 'գ', д: 'դ', е: 'ե', ж: 'ժ', з: 'զ', и: 'ի', й: 'յ', к: 'կ', л: 'լ', м: 'մ', н: 'ն',
  о: 'ո', п: 'պ', р: 'ր', с: 'ս', т: 'տ', у: 'ու', ф: 'ֆ', х: 'խ', ц: 'ց', ч: 'չ', ш: 'շ', щ: 'շչ', ъ: '', ы: 'ը',
  ь: '', э: 'է', ю: 'յու', я: 'յա', ё: 'յո',
};

/** Русское слово → армянское по буквам: «Тигран» → «տիգրան» (строчными; заглавную ставит вызывающий) */
function ruWordToHy(word: string): string {
  const w = word.toLowerCase();
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    const next = w[i + 1];
    const prev = w[i - 1];
    const start = i === 0;
    if (ch === 'д' && next === 'ж') { out += 'ջ'; i++; continue; }
    if (ch === 'д' && next === 'з') { out += 'ձ'; i++; continue; }
    if (ch === 'е' && next === 'в' && !start) { out += 'և'; i++; continue; }
    if (start && ch === 'е') { out += 'ե'; continue; }
    if (start && ch === 'о') { out += 'օ'; continue; }
    if (start && ch === 'р') { out += 'ռ'; continue; }
    // «Мария» → Մարիա, «Юлия» — без лишнего «յ» после «и»
    if ((ch === 'я' || ch === 'ю' || ch === 'ё') && prev === 'и') { out += ch === 'я' ? 'ա' : ch === 'ю' ? 'ու' : 'ո'; continue; }
    out += RU_HY[ch] ?? ch;
  }
  return out;
}

const HY_VOWELS = 'աեէըիոօու';
const HY_RU: Record<string, string> = {
  ա: 'а', բ: 'б', գ: 'г', դ: 'д', ե: 'е', զ: 'з', է: 'э', ը: 'ы', թ: 'т', ժ: 'ж', ի: 'и', լ: 'л', խ: 'х', ծ: 'ц',
  կ: 'к', ձ: 'дз', ղ: 'г', ճ: 'ч', մ: 'м', յ: 'й', ն: 'н', շ: 'ш', ո: 'о', չ: 'ч', պ: 'п', ջ: 'дж', ռ: 'р', ս: 'с',
  վ: 'в', տ: 'т', ր: 'р', ց: 'ц', ւ: 'в', փ: 'п', ք: 'к', օ: 'о', ֆ: 'ф',
};

/** Армянское слово → русское по буквам: «Սյուզի» → «сюзи» */
function hyWordToRu(word: string): string {
  const w = word.toLowerCase();
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const ch = w[i];
    const next = w[i + 1];
    const start = i === 0;
    if (ch === 'ո' && next === 'ւ') { out += 'у'; i++; continue; }
    if (ch === 'յ' && next === 'ա') { out += 'я'; i++; continue; }
    if (ch === 'յ' && next === 'ո' && w[i + 2] === 'ւ') { out += 'ю'; i += 2; continue; }
    if (ch === 'յ' && next === 'ո') { out += 'ё'; i++; continue; }
    if (ch === 'յ' && next === 'ե') { out += 'е'; i++; continue; }
    if (ch === 'և') { out += 'ев'; continue; }
    if (start && ch === 'ո') { out += 'во'; continue; }
    if (start && ch === 'է') { out += 'э'; continue; }
    if (!start && ch === 'է') { out += 'е'; continue; }
    // «հ» по-русски между гласными не слышно («Գոհար» → Гоар, «Հայկ» → Айк), рядом с согласной — «г» («Մհեր» → Мгер)
    if (ch === 'հ') {
      const prevConsonant = !start && !HY_VOWELS.includes(w[i - 1]);
      const nextConsonant = next !== undefined && !HY_VOWELS.includes(next);
      if (prevConsonant || nextConsonant) out += 'г';
      continue;
    }
    out += HY_RU[ch] ?? ch;
  }
  return out;
}

const LATIN_HY_PAIRS: [string, string][] = [
  ['shch', 'շչ'], ['sh', 'շ'], ['ch', 'չ'], ['zh', 'ժ'], ['kh', 'խ'], ['ts', 'ց'], ['tz', 'ց'], ['gh', 'ղ'], ['dz', 'ձ'],
  ['yu', 'յու'], ['ya', 'յա'], ['yo', 'յո'], ['ou', 'ու'], ['th', 'թ'], ['ph', 'փ'],
];
const LATIN_HY: Record<string, string> = {
  a: 'ա', b: 'բ', c: 'կ', d: 'դ', e: 'ե', f: 'ֆ', g: 'գ', h: 'հ', i: 'ի', j: 'ջ', k: 'կ', l: 'լ', m: 'մ', n: 'ն', o: 'ո',
  p: 'պ', q: 'ք', r: 'ր', s: 'ս', t: 'տ', u: 'ու', v: 'վ', w: 'վ', x: 'քս', y: 'յ', z: 'զ',
};

/** Латинское слово (армянская запись латиницей) → армянское: «Sargsyan» → «սարգսյան» */
function latinWordToHy(word: string): string {
  const w = word.toLowerCase();
  let out = '';
  for (let i = 0; i < w.length; ) {
    const start = i === 0;
    if (start && w.startsWith('ye')) { out += 'ե'; i += 2; continue; }
    if (start && w.startsWith('vo')) { out += 'ո'; i += 2; continue; }
    if (!start && w.startsWith('ye', i)) { out += 'յե'; i += 2; continue; }
    if (!start && w.startsWith('ev', i)) { out += 'և'; i += 2; continue; }
    const pair = LATIN_HY_PAIRS.find(([lat]) => w.startsWith(lat, i));
    if (pair) { out += pair[1]; i += pair[0].length; continue; }
    const ch = w[i];
    if (start && ch === 'e') out += 'է';
    else if (start && ch === 'o') out += 'օ';
    else if (start && ch === 'r') out += 'ռ';
    else out += LATIN_HY[ch] ?? ch;
    i++;
  }
  return out;
}

function translitWord(word: string, from: NameLocale, to: NameLocale): string {
  if (!word || from === to) return word;
  const known = nameWordIndex().get(word.toLowerCase());
  if (known) return known[to];
  // Слово не того письма (цифры, латиница внутри армянского имени) — как есть
  if (nameScript(word) !== from) return word;
  let out: string;
  if (to === 'en') out = translit(word);
  else if (from === 'ru') out = to === 'hy' ? capitalLike(word, ruWordToHy(word), true) : word;
  else if (from === 'hy') out = capitalLike(word, hyWordToRu(word), false);
  else {
    const hy = latinWordToHy(word);
    out = to === 'hy' ? capitalLike(word, hy, true) : capitalLike(word, hyWordToRu(hy), false);
  }
  return out;
}

/**
 * Имя на другом языке переводом букв: «Ани Саргсян» → hy «Անի Սարգսյան», en «Ani Sargsyan»; «Ani Sargsyan» → ru
 * «Ани Саргсян». Язык исходного имени — по его письму (nameScript); слова через пробел и дефис переводятся по
 * одному, всё прочее (точки, скобки, цифры) — как есть.
 */
export function translitName(name: string, to: NameLocale): string {
  const from = nameScript(name);
  if (!name || !from || from === to) return name;
  return name.replace(/[\p{L}և]+/gu, (word) => translitWord(word, from, to));
}

/** Имя мастера для клиента на языке страницы: перевод, вписанный в карточке, иначе — перевод букв на лету */
export function localizedName(name: string | undefined | null, i18n: Partial<Record<NameLocale, string>> | undefined | null, locale: string): string {
  if (!name) return '';
  const to: NameLocale = locale === 'hy' || locale === 'en' ? locale : 'ru';
  const own = i18n?.[to]?.trim();
  if (own) return own;
  return translitName(name, to);
}
