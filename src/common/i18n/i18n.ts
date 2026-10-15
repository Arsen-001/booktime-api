import { messages, type MessageKey } from './messages.js';

/**
 * Тексты, которые сервер пишет САМ — пуши и письма на языке человека (PLAN.md Р12). Ошибки API — кодами, их
 * переводит сайт; у кодов с ключом error.<код> и `message` на языке запроса (errorMessage). Языки — как во фронте: ru, hy, en; нет перевода — английский.
 */
export const LOCALES = ['ru', 'hy', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** t('ru', 'booking.reminder24h', { time: '14:00', name: 'Ани' }) */
export function t(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = messages[locale][key] ?? messages.en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/**
 * Язык запроса из Accept-Language ('ru', 'hy-AM,hy;q=0.9,en;q=0.5'): первый из наших языков по весу q; нет — undefined.
 */
export function localeFromAcceptLanguage(header: string | string[] | undefined): Locale | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return undefined;
  const tags = raw
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return tags.map((x) => x.lang).find(isLocale);
}

/**
 * Текст ошибки API на языке запроса (QA 15.10.2026): экран по-прежнему переводит `code`, но для кодов со словарным
 * ключом `error.<code>` (сейчас — frozen) и `message` приходит на языке человека. Ключа нет — undefined
 * (остаётся английский текст ошибки).
 */
export function errorMessage(code: string, locale: Locale): string | undefined {
  const key = `error.${code}`;
  return key in messages.en ? t(locale, key as MessageKey) : undefined;
}
