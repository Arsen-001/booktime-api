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
