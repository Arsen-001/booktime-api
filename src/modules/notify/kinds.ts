import type { MessageKey } from '../../common/i18n/messages.js';

/**
 * Реестр типов уведомлений (docs/backend/05 §3) — СВОЙ словарь, не нумерация Altegio 1…88 (F-05-004):
 * мок фронта (`src/domain/notify.ts`) тащит весь каталог Altegio (88 типов, «Дополнительная информация в Email»,
 * условия на каждый тип и т.п.) для экрана-демонстрации; сервер строит только то, что реально отправляет —
 * события, которых сейчас достигает журнал/лист ожидания/новости (PLAN.md §6 №10, 02-api.md §10). Список можно
 * расширять по мере того, как разделы-хозяева начинают слать что-то новое.
 *
 * `code` — стабильное целое только для формы ответа `GET .../notify/types`, которую читает `NotificationType.code`
 * фронта (число, не строка) — самих чисел Altegio они не обязаны совпадать, значения здесь свои.
 */
export type NotifyRecipient = 'client' | 'staff';

export interface NotifyKindDef {
  code: number;
  kind: string;
  recipient: NotifyRecipient;
  /** Ключ словаря common/i18n/messages.ts — текст по умолчанию, пока бизнес не задал свой шаблон */
  messageKey: MessageKey;
  /** Можно ли выключить (F-05-003) — код входа/системные события у нас тут не заводим, всё выключаемо */
  alwaysOn?: boolean;
}

export const NOTIFY_KINDS: readonly NotifyKindDef[] = [
  // клиенту (05 §3.1)
  { code: 1, kind: 'booking_created', recipient: 'client', messageKey: 'booking.createdByStaff' },
  { code: 2, kind: 'salon_confirmed', recipient: 'client', messageKey: 'booking.confirmedByMaster' },
  { code: 3, kind: 'salon_moved', recipient: 'client', messageKey: 'booking.movedByMaster' },
  { code: 4, kind: 'salon_deleted', recipient: 'client', messageKey: 'booking.deletedByMaster' },
  { code: 5, kind: 'cancelled_by_master', recipient: 'client', messageKey: 'booking.cancelledByMaster' },
  { code: 6, kind: 'prepayment_expired', recipient: 'client', messageKey: 'booking.prepaymentExpired' },
  { code: 7, kind: 'reminder24h', recipient: 'client', messageKey: 'booking.reminder24h' },
  { code: 8, kind: 'reminder2h', recipient: 'client', messageKey: 'booking.reminder2h' },
  { code: 9, kind: 'waitlist_available', recipient: 'client', messageKey: 'waitlist.slotAvailable' },
  // ⭐ 03.10.2026: «Просим подтвердить визит» (тип 73 каталога, F-05-028) — jobs/notify-confirm-requests.ts
  { code: 10, kind: 'confirm_request', recipient: 'client', messageKey: 'booking.confirmRequest' },
  // 03.10.2026: «Заказ готов» (раздел «Заказы» — ателье, ремонт, химчистка, детейлинг) — modules/orders/order-notify.ts
  { code: 11, kind: 'order_ready', recipient: 'client', messageKey: 'order.ready' },
  // бизнесу (05 §3.2)
  { code: 50, kind: 'staff_new_booking', recipient: 'staff', messageKey: 'staff.newBooking' },
  { code: 51, kind: 'staff_client_cancelled', recipient: 'staff', messageKey: 'staff.clientCancelled' },
  { code: 52, kind: 'staff_client_rescheduled', recipient: 'staff', messageKey: 'staff.clientRescheduled' },
  { code: 53, kind: 'staff_empty_week', recipient: 'staff', messageKey: 'staff.emptyWeek' },
] as const;

export const NOTIFY_KIND_BY_NAME = new Map(NOTIFY_KINDS.map((k) => [k.kind, k]));

export function notifyKindOf(kind: string): NotifyKindDef | undefined {
  return NOTIFY_KIND_BY_NAME.get(kind);
}

/** Отправлять вне тихих часов 21:00–10:00 по Еревану (§5, зафиксировано PLAN.md §6 №10 «E6») — только эти виды */
export const QUIET_HOURS_KINDS = new Set(['news']);
