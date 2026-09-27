/**
 * Словарь текстов сервера. Этап 1 — основа и вход; уведомления (этап 10) дописывают свои ключи сюда же.
 * Каждый ключ обязан быть во всех трёх языках — это проверяет тип (Record<MessageKey, string> на каждый язык).
 */
const en = {
  'auth.code': 'BookTime code: {code}. Do not share it with anyone.',
  'booking.reminder24h': 'Reminder: {service} tomorrow at {time}, {place}.',
  'booking.reminder2h': 'See you soon: {service} at {time}, {place}.',
} as const;

export type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
  'auth.code': 'Код BookTime: {code}. Никому его не сообщайте.',
  'booking.reminder24h': 'Напоминаем: {service} завтра в {time}, {place}.',
  'booking.reminder2h': 'Скоро увидимся: {service} в {time}, {place}.',
};

const hy: Record<MessageKey, string> = {
  'auth.code': 'BookTime կոդ՝ {code}։ Ոչ ոքի մի՛ ասեք։',
  'booking.reminder24h': 'Հիշեցում՝ {service} վաղը ժամը {time}-ին, {place}։',
  'booking.reminder2h': 'Շուտով կհանդիպենք՝ {service} ժամը {time}-ին, {place}։',
};

export const messages: Record<'ru' | 'hy' | 'en', Record<MessageKey, string>> = { en, ru, hy };
