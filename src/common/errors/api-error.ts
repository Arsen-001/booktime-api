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
  validation: HttpStatus.BAD_REQUEST,
  internal: HttpStatus.INTERNAL_SERVER_ERROR,
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
