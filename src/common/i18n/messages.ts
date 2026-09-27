/**
 * Словарь текстов сервера. Этап 1 — основа и вход; уведомления (этап 10, docs/backend/05) дописывают свои
 * ключи сюда же — пуши и письма сервер пишет сам на языке получателя (PLAN.md Р12), ошибки API — только кодами.
 * Каждый ключ обязан быть во всех трёх языках — это проверяет тип (Record<MessageKey, string> на каждый язык).
 */
const en = {
  'auth.code': 'BookTime code: {code}. Do not share it with anyone.',
  'booking.reminder24h': 'Reminder: {service} tomorrow at {time}, {place}.',
  'booking.reminder2h': 'See you soon: {service} at {time}, {place}.',
  // этап 10 — мастер напоминает сам, клиенту без приложения (F-00-121)
  'booking.remindTemplate': "Hello, {name}! Just a reminder about your visit tomorrow at {time} for {service} at {business}. See you there!",
  // этап 10 — клиенту (05 §3.1)
  'booking.createdByStaff': "You're booked: {service} on {time}, {place}.",
  'booking.confirmedByMaster': '{service} confirmed for {time}, {place}.',
  'booking.movedByMaster': 'Your visit was moved to {time}, {place}.',
  'booking.deletedByMaster': 'Your visit was cancelled by the salon.',
  'booking.cancelledByMaster': 'The master cancelled your visit at {time} — pick another time.',
  'booking.prepaymentExpired': "The prepayment didn't arrive in time — the slot for {time} was released.",
  'waitlist.slotAvailable': 'A slot with {staff} opened up — you can book it now.',
  // этап 10 — бизнесу (05 §3.2)
  'staff.newBooking': '{client} booked {service} for {time}.',
  'staff.clientCancelled': '{client} cancelled the visit at {time}.',
  'staff.clientRescheduled': '{client} moved the visit to {time}.',
  'staff.emptyWeek': "Next week has no open slots yet — open some for clients to book.",
} as const;

export type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
  'auth.code': 'Код BookTime: {code}. Никому его не сообщайте.',
  'booking.reminder24h': 'Напоминаем: {service} завтра в {time}, {place}.',
  'booking.reminder2h': 'Скоро увидимся: {service} в {time}, {place}.',
  'booking.remindTemplate': 'Здравствуйте, {name}! Напоминаю о записи завтра в {time} на «{service}» в {business}. Ждём вас!',
  'booking.createdByStaff': 'Вы записаны: {service} на {time}, {place}.',
  'booking.confirmedByMaster': '{service} подтверждена на {time}, {place}.',
  'booking.movedByMaster': 'Ваш визит перенесён на {time}, {place}.',
  'booking.deletedByMaster': 'Ваш визит отменён салоном.',
  'booking.cancelledByMaster': 'Мастер отменил визит на {time} — выберите другое время.',
  'booking.prepaymentExpired': 'Предоплата не пришла вовремя — окно на {time} освобождено.',
  'waitlist.slotAvailable': 'Освободилось окно у {staff} — можно записаться прямо сейчас.',
  'staff.newBooking': '{client} записался(-лась) на {service}, {time}.',
  'staff.clientCancelled': '{client} отменил(а) визит на {time}.',
  'staff.clientRescheduled': '{client} перенёс(ла) визит на {time}.',
  'staff.emptyWeek': 'На следующей неделе нет открытых окон — откройте время для записи.',
};

const hy: Record<MessageKey, string> = {
  'auth.code': 'BookTime կոդ՝ {code}։ Ոչ ոքի մի՛ ասեք։',
  'booking.reminder24h': 'Հիշեցում՝ {service} վաղը ժամը {time}-ին, {place}։',
  'booking.reminder2h': 'Շուտով կհանդիպենք՝ {service} ժամը {time}-ին, {place}։',
  'booking.remindTemplate': 'Բարև, {name}։ Հիշեցնում եմ վաղվա այցի մասին ժամը {time}-ին՝ {service}, {business}։ Սպասում ենք ձեզ։',
  'booking.createdByStaff': 'Դուք գրանցված եք՝ {service}, {time}, {place}։',
  'booking.confirmedByMaster': '{service}-ը հաստատված է {time}-ին, {place}։',
  'booking.movedByMaster': 'Ձեր այցը տեղափոխվել է {time}, {place}։',
  'booking.deletedByMaster': 'Ձեր այցը չեղարկվել է սրահի կողմից։',
  'booking.cancelledByMaster': 'Վարպետը չեղարկեց այցը՝ {time}. ընտրեք այլ ժամ։',
  'booking.prepaymentExpired': 'Կանխավճարը ժամանակին չստացվեց՝ {time} պատուհանն ազատվել է։',
  'waitlist.slotAvailable': '{staff}-ի մոտ ազատվել է ժամ՝ կարող եք գրանցվել հիմա։',
  'staff.newBooking': '{client}-ը գրանցվեց՝ {service}, {time}։',
  'staff.clientCancelled': '{client}-ը չեղարկեց այցը՝ {time}։',
  'staff.clientRescheduled': '{client}-ը տեղափոխեց այցը՝ {time}։',
  'staff.emptyWeek': 'Հաջորդ շաբաթ դեռ բաց ժամեր չկան՝ բացեք ժամանակ գրանցման համար։',
};

export const messages: Record<'ru' | 'hy' | 'en', Record<MessageKey, string>> = { en, ru, hy };
