import { messages } from './messages.js';
/**
 * Тексты, которые сервер пишет САМ — пуши и письма на языке человека (PLAN.md Р12). Ошибки API — только кодами,
 * их переводит сайт. Языки — как во фронте: ru, hy, en; нет перевода — английский.
 */
export const LOCALES = ['ru', 'hy', 'en'];
export function isLocale(v) {
    return typeof v === 'string' && LOCALES.includes(v);
}
/** t('ru', 'booking.reminder24h', { time: '14:00', name: 'Ани' }) */
export function t(locale, key, params = {}) {
    const template = messages[locale][key] ?? messages.en[key];
    return template.replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`));
}
//# sourceMappingURL=i18n.js.map