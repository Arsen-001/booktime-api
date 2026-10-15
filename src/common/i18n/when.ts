import type { Locale } from './i18n.js';

/**
 * «Когда» записи для текста пуша (QA приложений 15.10.2026: «на 12:00» у записи на другой день читалось как сегодня):
 * сегодня — только время, завтра — «завтра в 12:00», дальше — «16 окт в 12:00» (другой год — с годом). Фраза целиком,
 * с предлогом: шаблоны пишут «{service} {when}» без своего «в/на/at». «Сегодня» — по местному дню филиала
 * (по умолчанию Ереван): обе даты — уже местные 'YYYY-MM-DD…'.
 */
const MONTHS_SHORT: Record<Locale, string[]> = {
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hy: ['հունվարի', 'փետրվարի', 'մարտի', 'ապրիլի', 'մայիսի', 'հունիսի', 'հուլիսի', 'օգոստոսի', 'սեպտեմբերի', 'հոկտեմբերի', 'նոյեմբերի', 'դեկտեմբերի'],
};

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** startLocal — 'YYYY-MM-DDTHH:mm' записи, today — местный 'YYYY-MM-DD' (или 'YYYY-MM-DDTHH:mm') сейчас */
export function whenPhrase(locale: Locale, startLocal: string, today: string): string {
  const day = startLocal.slice(0, 10);
  const time = startLocal.slice(11, 16);
  const now = today.slice(0, 10);
  if (day === now) return locale === 'ru' ? `в ${time}` : locale === 'en' ? `at ${time}` : `ժամը ${time}-ին`;
  if (day === nextDay(now)) return locale === 'ru' ? `завтра в ${time}` : locale === 'en' ? `tomorrow at ${time}` : `վաղը՝ ժամը ${time}-ին`;
  const month = MONTHS_SHORT[locale][Number(day.slice(5, 7)) - 1] ?? '';
  const dayNum = String(Number(day.slice(8, 10)));
  const year = day.slice(0, 4) !== now.slice(0, 4) ? day.slice(0, 4) : '';
  if (locale === 'ru') return `${dayNum} ${month}${year ? ` ${year}` : ''} в ${time}`;
  if (locale === 'en') return `${month} ${dayNum}${year ? `, ${year}` : ''} at ${time}`;
  return `${year ? `${year} ` : ''}${month} ${dayNum}-ին՝ ժամը ${time}-ին`;
}
