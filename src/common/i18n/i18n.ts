import { messages, type MessageKey } from './messages.js';

/**
 * Тексты, которые сервер пишет САМ — пуши и письма на языке человека (PLAN.md Р12). Ошибки API — только кодами,
 * их переводит сайт. Языки — как во фронте: ru, hy, en; нет перевода — английский.
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
