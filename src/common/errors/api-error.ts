import { HttpStatus } from '@nestjs/common';

/**
 * Коды ошибок API (docs/backend/02-api.md §0). Экран переводит `code` сам (Р12), `message` — английский для логов.
 * Коды мока сохранены как есть, чтобы фронт не менял разбор ошибок.
 */
export const ERROR_STATUS = {
  not_found: HttpStatus.NOT_FOUND,
  slot_taken: HttpStatus.CONFLICT,
  invalid_phone: HttpStatus.UNPROCESSABLE_ENTITY,
  wrong_code: HttpStatus.UNPROCESSABLE_ENTITY,
  consent_required: HttpStatus.UNPROCESSABLE_ENTITY,
  staff_not_found: HttpStatus.NOT_FOUND,
  service_not_found: HttpStatus.NOT_FOUND,
  unauthorized: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  conflict: HttpStatus.CONFLICT,
  frozen: HttpStatus.LOCKED,
  insufficient_coins: HttpStatus.PAYMENT_REQUIRED,
  promo_used: HttpStatus.CONFLICT,
  promo_expired: HttpStatus.GONE,
  promo_revoked: HttpStatus.GONE,
  promo_personal: HttpStatus.FORBIDDEN,
  // вход (этап 2)
  wrong_password: HttpStatus.UNPROCESSABLE_ENTITY,
  weak_password: HttpStatus.UNPROCESSABLE_ENTITY,
  account_locked: HttpStatus.LOCKED,
  account_blocked: HttpStatus.FORBIDDEN,
  code_expired: HttpStatus.GONE,
  code_attempts: HttpStatus.TOO_MANY_REQUESTS,
  code_resend_wait: HttpStatus.TOO_MANY_REQUESTS,
  code_not_delivered: HttpStatus.BAD_GATEWAY,
  phone_taken: HttpStatus.CONFLICT,
  phone_required: HttpStatus.UNPROCESSABLE_ENTITY,
  no_business: HttpStatus.FORBIDDEN,
  // бизнес и сотрудники (этап 3) — коды как в моке фронта (src/api/staff.ts, client.ts)
  last_owner: HttpStatus.CONFLICT,
  restore_blocked: HttpStatus.CONFLICT,
  in_use: HttpStatus.CONFLICT,
  has_access: HttpStatus.CONFLICT,
  invalid_field: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_ip_range: HttpStatus.UNPROCESSABLE_ENTITY,
  bad_name: HttpStatus.UNPROCESSABLE_ENTITY,
  bad_sphere: HttpStatus.UNPROCESSABLE_ENTITY,
  login_taken: HttpStatus.CONFLICT,
  invite_expired: HttpStatus.GONE,
  invite_used: HttpStatus.CONFLICT,
  invite_wrong_phone: HttpStatus.FORBIDDEN,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  // каталог (этап 4) — как в моке фронта (src/api/resources.ts)
  last_instance: HttpStatus.CONFLICT,
  // клиенты / CRM (этап 5) — как в моке фронта (src/api/clients/*)
  duplicate_phone: HttpStatus.CONFLICT,
  invalid_national_id: HttpStatus.UNPROCESSABLE_ENTITY,
  name_required: HttpStatus.UNPROCESSABLE_ENTITY,
  empty_category: HttpStatus.UNPROCESSABLE_ENTITY,
  duplicate_category: HttpStatus.CONFLICT,
  same_client: HttpStatus.UNPROCESSABLE_ENTITY,
  empty_comment: HttpStatus.UNPROCESSABLE_ENTITY,
  bad_ext: HttpStatus.UNPROCESSABLE_ENTITY,
  too_big: HttpStatus.UNPROCESSABLE_ENTITY,
  already_has_app: HttpStatus.CONFLICT,
  empty_import: HttpStatus.UNPROCESSABLE_ENTITY,
  too_many_rows: HttpStatus.UNPROCESSABLE_ENTITY,
  empty_label: HttpStatus.UNPROCESSABLE_ENTITY,
  list_needs_options: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_days: HttpStatus.UNPROCESSABLE_ENTITY,
  chat_autosave_off: HttpStatus.CONFLICT,
  pin_limit: HttpStatus.UNPROCESSABLE_ENTITY,
  // график и окна (этап 6) — как в моке фронта (src/api/schedule/*)
  schedule_has_bookings: HttpStatus.CONFLICT,
  invalid_range: HttpStatus.UNPROCESSABLE_ENTITY,
  not_ongoing: HttpStatus.CONFLICT,
  // журнал и записи (этап 7) — как в моке фронта (rules/booking-flow, booking-policy, src/api/journal.ts)
  service_unavailable: HttpStatus.UNPROCESSABLE_ENTITY,
  staff_hidden: HttpStatus.UNPROCESSABLE_ENTITY,
  client_required: HttpStatus.UNPROCESSABLE_ENTITY,
  outside_hours: HttpStatus.CONFLICT,
  group_full: HttpStatus.CONFLICT,
  resource_unavailable: HttpStatus.CONFLICT,
  business_inactive: HttpStatus.CONFLICT,
  staff_unavailable: HttpStatus.CONFLICT,
  online_disabled: HttpStatus.CONFLICT,
  online_paused: HttpStatus.CONFLICT,
  staff_on_vacation: HttpStatus.CONFLICT,
  client_blocked: HttpStatus.FORBIDDEN,
  accepts_mismatch: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_transition: HttpStatus.CONFLICT,
  restore_expired: HttpStatus.GONE,
  restore_slot_taken: HttpStatus.CONFLICT,
  not_active: HttpStatus.CONFLICT,
  started: HttpStatus.CONFLICT,
  not_allowed: HttpStatus.FORBIDDEN,
  prepaid_locked: HttpStatus.CONFLICT,
  too_late: HttpStatus.CONFLICT,
  no_free_staff: HttpStatus.CONFLICT,
  already_used: HttpStatus.CONFLICT,
  expired: HttpStatus.GONE,
  bad_date: HttpStatus.UNPROCESSABLE_ENTITY,
  validation: HttpStatus.BAD_REQUEST,
  internal: HttpStatus.INTERNAL_SERVER_ERROR,
  // уведомления (этап 10) — как в моке фронта (src/api/notify.ts: 'notify/weekly-push-limit')
  weekly_push_limit: HttpStatus.CONFLICT,
  // лояльность (этап 11) — как в моке фронта (src/api/loyalty.ts)
  has_issued_cards: HttpStatus.CONFLICT,
  insufficient_balance: HttpStatus.PAYMENT_REQUIRED,
  membership_frozen: HttpStatus.CONFLICT,
  already_confirmed: HttpStatus.CONFLICT,
  duplicate_number: HttpStatus.CONFLICT,
  // финансы и касса (этап 12) — как в моке фронта (src/api/finance.ts)
  invalid_amount: HttpStatus.UNPROCESSABLE_ENTITY,
  system_item: HttpStatus.CONFLICT,
  already_cancelled: HttpStatus.CONFLICT,
  over_refund: HttpStatus.UNPROCESSABLE_ENTITY,
  // склад (этап 13) — как в моке фронта (src/api/stock.ts)
  last_warehouse: HttpStatus.CONFLICT,
  warehouse_has_stock: HttpStatus.CONFLICT,
  last_category: HttpStatus.CONFLICT,
  category_not_empty: HttpStatus.CONFLICT,
  category_archived: HttpStatus.CONFLICT,
  parent_archived: HttpStatus.CONFLICT,
  barcode_in_use: HttpStatus.CONFLICT,
  good_in_use: HttpStatus.CONFLICT,
  insufficient_stock: HttpStatus.CONFLICT,
  not_editable: HttpStatus.CONFLICT,
  already_completed: HttpStatus.CONFLICT,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Тело любой ошибки API */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  /** validation: какие поля не прошли и почему */
  fields?: Record<string, string>;
  /** Сколько секунд ждать до повтора (code_resend_wait, rate_limited, account_locked) */
  retryAfter?: number;
}

/** Бросать из сервисов: throw new ApiError('slot_taken', 'Staff is busy at this time') */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
}
