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
  // «Войти через Google» (03.10.2026): токен не прошёл проверку / вход не настроен / ключи Google недоступны /
  // этот Google-аккаунт уже привязан к другому человеку
  google_invalid: HttpStatus.UNAUTHORIZED,
  google_disabled: HttpStatus.SERVICE_UNAVAILABLE,
  google_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  google_taken: HttpStatus.CONFLICT,
  // «Войти через Apple» (03.10.2026): токен не прошёл проверку / вход не настроен / ключи Apple недоступны
  apple_invalid: HttpStatus.UNAUTHORIZED,
  apple_disabled: HttpStatus.SERVICE_UNAVAILABLE,
  apple_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
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
  // ресурсы: группа/лист ожидания/серии (этап 21) — как в моке фронта (src/api/resources.ts)
  no_join_link: HttpStatus.UNPROCESSABLE_ENTITY,
  already_series: HttpStatus.CONFLICT,
  invalid_end_date: HttpStatus.UNPROCESSABLE_ENTITY,
  multi_seat_no_schedule: HttpStatus.UNPROCESSABLE_ENTITY,
  weekday_required: HttpStatus.UNPROCESSABLE_ENTITY,
  waitlist_entry_closed: HttpStatus.CONFLICT,
  service_required: HttpStatus.UNPROCESSABLE_ENTITY,
  no_membership: HttpStatus.UNPROCESSABLE_ENTITY,
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
  /** ⭐ Допродажа: сопутствующей услуги/товара нет в списке услуги или товар закончился */
  upsell_unavailable: HttpStatus.CONFLICT,
  business_inactive: HttpStatus.CONFLICT,
  staff_unavailable: HttpStatus.CONFLICT,
  online_disabled: HttpStatus.CONFLICT,
  online_paused: HttpStatus.CONFLICT,
  staff_on_vacation: HttpStatus.CONFLICT,
  client_blocked: HttpStatus.FORBIDDEN,
  accepts_mismatch: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_transition: HttpStatus.CONFLICT,
  // заказы (03.10.2026): недопустимый переход статуса заказа / «готов» повторно, когда заказ не готов
  invalid_order_transition: HttpStatus.UNPROCESSABLE_ENTITY,
  order_not_ready: HttpStatus.UNPROCESSABLE_ENTITY,
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
  // склад, этап 21 лейн finance+stock — коды мока (src/api/stock.ts: расходники визита)
  invalid_qty: HttpStatus.UNPROCESSABLE_ENTITY,
  not_arrived: HttpStatus.CONFLICT,
  // зарплата (этап 14) — как в моке фронта (src/api/finance.ts, src/domain/payroll.ts)
  sheet_not_draft: HttpStatus.CONFLICT,
  cannot_pay: HttpStatus.CONFLICT,
  // интеграции (этап 17) — как в моке фронта (src/api/integrations.ts)
  builtin_locked: HttpStatus.CONFLICT,
  // ревью 27.09, этап 21 — И2/И13 (src/api/integrations.ts: sendInstallTest/addWebhookAddress)
  not_connected: HttpStatus.CONFLICT,
  webhook_unreachable: HttpStatus.CONFLICT,
  // подписка, монеты, промокоды, настройки (этап 18) — docs/backend/06 §2–4, коды мока (src/api/settings.ts)
  promo_not_found: HttpStatus.NOT_FOUND,
  payment_failed: HttpStatus.PAYMENT_REQUIRED,
  bad_tax_id: HttpStatus.UNPROCESSABLE_ENTITY,
  bad_telegram_url: HttpStatus.UNPROCESSABLE_ENTITY,
  read_only: HttpStatus.LOCKED,
  // данные и удаление (этап 20) — «Выгрузить мои данные» не чаще раза в сутки (F-15-154, код мока)
  too_soon: HttpStatus.TOO_MANY_REQUESTS,
  // подключение салона за 10 минут (этап 19, F-00-176) — коды мока (src/api/platform/connect.ts)
  connect_incomplete: HttpStatus.UNPROCESSABLE_ENTITY,
  duplicate: HttpStatus.CONFLICT,
  // лояльность (этап 21, лейн loyalty) — коды мока src/api/loyalty.ts как есть
  account_already_open: HttpStatus.CONFLICT,
  bonus_unavailable: HttpStatus.UNPROCESSABLE_ENTITY,
  certificate_not_applicable: HttpStatus.UNPROCESSABLE_ENTITY,
  discount_exists: HttpStatus.CONFLICT,
  freeze_not_allowed: HttpStatus.UNPROCESSABLE_ENTITY,
  has_sales: HttpStatus.CONFLICT,
  has_usage: HttpStatus.CONFLICT,
  membership_not_applicable: HttpStatus.UNPROCESSABLE_ENTITY,
  negative_limit_required: HttpStatus.UNPROCESSABLE_ENTITY,
  over_limit: HttpStatus.UNPROCESSABLE_ENTITY,
  // этап 21, лейн finance+stock — возврат по платежу визита, кассовая смена
  discount_not_refundable: HttpStatus.UNPROCESSABLE_ENTITY,
  payment_setup_incomplete: HttpStatus.UNPROCESSABLE_ENTITY,
  insufficient_cash: HttpStatus.UNPROCESSABLE_ENTITY,
  not_cash_account: HttpStatus.UNPROCESSABLE_ENTITY,
  shift_already_open: HttpStatus.CONFLICT,
  shift_not_open: HttpStatus.CONFLICT,
  // полный тест 30.09–01.10 (qa/full-test-0930) — коды мока как есть
  operation_linked: HttpStatus.CONFLICT,
  account_in_use: HttpStatus.CONFLICT,
  method_not_found: HttpStatus.NOT_FOUND,
  card_type_already_issued: HttpStatus.CONFLICT,
  nothing_due: HttpStatus.CONFLICT,
  // online, остаток (этап 21, лейн client+online, попытка 2) — коды мока src/api/online.ts как есть
  not_awaiting_prepayment: HttpStatus.CONFLICT,
  prepayment_expired: HttpStatus.GONE,
  already_rated: HttpStatus.CONFLICT,
  integration_unavailable: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_input: HttpStatus.UNPROCESSABLE_ENTITY,
  phone_not_verified: HttpStatus.UNPROCESSABLE_ENTITY,
  // этап 21, лейн rest, попытка 2 — рассылки CRM (src/api/clients/bulk.ts) — коды мока как есть
  sms_not_connected: HttpStatus.UNPROCESSABLE_ENTITY,
  empty_text: HttpStatus.UNPROCESSABLE_ENTITY,
  no_app_user: HttpStatus.UNPROCESSABLE_ENTITY,
  // этап 21, лейн notify-log+mailings — разовое сообщение/ссылка на оплату без разрешённого канала, тест без телефона (коды мока)
  no_allowed_channel: HttpStatus.UNPROCESSABLE_ENTITY,
  'notify/no-test-phone': HttpStatus.UNPROCESSABLE_ENTITY,
  // этап 21 (сдача, попытка 6) — маркетплейс интеграций, коды мока src/api/integrations.ts как есть
  not_installed: HttpStatus.UNPROCESSABLE_ENTITY,
  owner_only: HttpStatus.FORBIDDEN,
  coming_soon: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_code: HttpStatus.UNPROCESSABLE_ENTITY,
  code_taken: HttpStatus.CONFLICT,
  registration_url_required: HttpStatus.UNPROCESSABLE_ENTITY,
  not_in_review: HttpStatus.CONFLICT,
  nothing_to_refund: HttpStatus.CONFLICT,
  invalid_stream_id: HttpStatus.UNPROCESSABLE_ENTITY,
  duplicate_stream_form: HttpStatus.CONFLICT,
  // файлы и фото (04.10.2026): нет файла в запросе / больше 10 МБ / не картинка (или HEIC) / квота бизнеса исчерпана
  file_required: HttpStatus.UNPROCESSABLE_ENTITY,
  file_too_large: HttpStatus.PAYLOAD_TOO_LARGE,
  unsupported_image: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  upload_quota: HttpStatus.UNPROCESSABLE_ENTITY,
  /** Документ клиента (04.10.2026): не PDF / картинка / Word / Excel / текст по сигнатуре */
  unsupported_file: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
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
