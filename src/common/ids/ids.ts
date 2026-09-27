import { monotonicFactory } from 'ulid';

/**
 * Идентификаторы `<префикс>_<ULID>` (docs/backend/01-data-model.md §0). Префиксы ядра — те же, что ID_PREFIX
 * во фронте (booking-platform/src/api/core.ts), чтобы экраны работали со строками как раньше.
 * ULID сортируется по времени и не выдаёт количество записей. Длина: префикс ≤ 5 + '_' + 26 ≤ 32 (VARCHAR(32)).
 */
export const ID_PREFIX = {
  // ядро (как во фронте)
  network: 'net',
  business: 'biz',
  location: 'loc',
  staff: 'st',
  serviceCategory: 'cat',
  service: 'sv',
  resource: 'res',
  client: 'cl',
  appUser: 'au',
  booking: 'bk',
  groupEvent: 'ev',
  schedule: 'sch',
  calendarMark: 'mk',
  // новые таблицы сервера
  // человек (users) = AppUser мока: тот же префикс, чтобы экраны клиента работали с id как раньше
  user: 'au',
  session: 'ses',
  auditEvent: 'aud',
  file: 'fil',
  notification: 'ntf',
  otp: 'otp',
  staffLogin: 'sl',
  platformMember: 'pm',
  loginEvent: 'le',
  pushToken: 'pt',
  // этап 3 — как в срезе staff фронта
  position: 'stpos',
  staffInvite: 'stinv',
  // этап 4 — каталог: категории/услуги/пакеты используют cat/sv (пакет — обычная услуга, 01 §4);
  // у ресурса — свои экземпляры (Resource.instances, JSON, как во фронте)
  resourceInstance: 'resinst',
  // этап 5 — клиенты/CRM: client уже был зарезервирован (как во фронте); остальное — только на сервере,
  // не мирроруется в ядро браузера, поэтому префикс свой, фронтовому ID_PREFIX не обязан совпадать
  clientComment: 'ccmt',
  clientFile: 'cfile',
  clientImportRun: 'cimp',
  dataExport: 'dexp',
  clientCustomField: 'cf',
  // этап 6 — график и окна: как в срезе schedule фронта (шаблон sctpl, история scha, правило scr, закрытые дни scun)
  scheduleTemplate: 'sctpl',
  scheduleHistory: 'scha',
  slotRule: 'scr',
  unavailableRange: 'scun',
  busyBlock: 'bb',
  resourceBusy: 'rbz',
  // этап 7 — журнал и записи: как в срезе journal / ядре фронта (визит vis, событие bev, история bh, пакет pkg,
  // лист ожидания wl, серия scser/ser, заявка «закрыть окно» clm, план лечения tplan/tpi, оплата pay, товар gl)
  visit: 'vis',
  bookingEvent: 'bev',
  bookingHistory: 'bh',
  packageGroup: 'pkg',
  waitlistEntry: 'wl',
  seriesRule: 'scser',
  recurrenceSeries: 'ser',
  freedSlot: 'fs',
  slotClaim: 'clm',
  treatmentPlan: 'tplan',
  treatmentPlanItem: 'tpi',
  payment: 'pay',
  goodsLine: 'gl',
  bookingCategory: 'bc',
  recurrenceTemplate: 'rt',
  // этап 8 — онлайн-запись и страница по ссылке: как в срезе online фронта (ссылка lnk)
  bookingLink: 'lnk',
  // этап 9 — приложение клиента: только на сервере, не мирроруются в ядро браузера (как этап 5) — свои префиксы
  favorite: 'fav',
  starRating: 'str',
  diaryEntry: 'dia',
  callbackRequest: 'cbr',
  demandLead: 'lead',
  supportTicket: 'sup',
  /// Лента /v1/me/inbox (F-14-055) — тот же смысл, что зарезервированный на этапе 2 'ntf' (уведомление)
  inboxItem: 'ntf',
  // этап 10 — уведомления: очередь/журнал отправок, новости
  notifyOutbox: 'nto',
  newsPost: 'nws',
  // этап 11 — лояльность: только на сервере (как этапы 5/9) — мок фронта не резервирует префиксы для
  // loyalty в core.ts (id там произвольные строки), поэтому префиксы свои: тип карты lct, карта lc,
  // акция lp, движение ltx, тип/сертификат lctt/lcert, тип/абонемент lmt/lm(+freeze lmf), тип/счёт lat/la(+lao)
  loyaltyCardType: 'lct',
  loyaltyCard: 'lc',
  promotion: 'lp',
  loyaltyTx: 'ltx',
  certificateType: 'lctt',
  certificate: 'lcert',
  membershipType: 'lmt',
  membershipSale: 'lm',
  membershipFreeze: 'lmf',
  clientAccountType: 'lat',
  clientAccount: 'la',
  clientAccountOp: 'lao',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ulid = monotonicFactory();

/** Новый id: newId('booking') → 'bk_01J9Z…' */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid()}`;
}

const ID_RE = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Похоже ли на id нужного вида (для проверки входа, до похода в базу). Сид-данные мока тоже проходят по префиксу. */
export function isId(value: unknown, kind?: IdKind): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  if (kind) return value.startsWith(`${ID_PREFIX[kind]}_`) && value.length > ID_PREFIX[kind].length + 1;
  return ID_RE.test(value) || /^[a-z]{2,5}_[A-Za-z0-9_]{1,26}$/.test(value);
}
