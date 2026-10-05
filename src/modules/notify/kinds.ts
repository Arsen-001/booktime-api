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
  // 04.10.2026: «Заказ ждёт вас» — клиент не забрал готовый заказ (через 3 и 7 дней) — jobs/orders-pickup-reminders.ts
  { code: 12, kind: 'order_pickup_reminder', recipient: 'client', messageKey: 'order.pickupReminder' },
  // ⭐ 05.10.2026: «Смета по заказу» — согласовать цену после диагностики, и напоминание, если не ответил за сутки
  { code: 13, kind: 'order_estimate', recipient: 'client', messageKey: 'order.estimate' },
  { code: 14, kind: 'order_estimate_reminder', recipient: 'client', messageKey: 'order.estimateReminder' },
  // ⭐ 06.10.2026: типы каталога 75/72/6+20/3/55 — jobs/notify-client-auto.ts (текст — шаблон типа в каталоге)
  { code: 15, kind: 'client_no_show', recipient: 'client', messageKey: 'client.noShow' },
  { code: 16, kind: 'noshow_invite', recipient: 'client', messageKey: 'client.noShowInvite' },
  { code: 17, kind: 'review_request', recipient: 'client', messageKey: 'client.reviewRequest' },
  { code: 18, kind: 'birthday', recipient: 'client', messageKey: 'client.birthday' },
  { code: 19, kind: 'repeat_invite', recipient: 'client', messageKey: 'client.repeatInvite' },
  // бизнесу (05 §3.2)
  { code: 50, kind: 'staff_new_booking', recipient: 'staff', messageKey: 'staff.newBooking' },
  { code: 51, kind: 'staff_client_cancelled', recipient: 'staff', messageKey: 'staff.clientCancelled' },
  { code: 52, kind: 'staff_client_rescheduled', recipient: 'staff', messageKey: 'staff.clientRescheduled' },
  { code: 53, kind: 'staff_empty_week', recipient: 'staff', messageKey: 'staff.emptyWeek' },
  // 06.10.2026: мастеру и администраторам о действиях персонала (типы каталога 56/57/42/13/76) и задачи воркера
  // «заявка ждёт ответа» (F-00-067), «пришёл · сумма / не пришёл» (F-00-127) — modules/notify/staff-notices.ts
  { code: 54, kind: 'staff_colleague_booked', recipient: 'staff', messageKey: 'staff.colleagueBooked' },
  { code: 55, kind: 'staff_assigned', recipient: 'staff', messageKey: 'staff.assigned' },
  { code: 56, kind: 'staff_booking_moved', recipient: 'staff', messageKey: 'staff.bookingMoved' },
  { code: 57, kind: 'staff_booking_cancelled', recipient: 'staff', messageKey: 'staff.bookingCancelled' },
  { code: 58, kind: 'staff_client_no_show', recipient: 'staff', messageKey: 'staff.clientNoShow' },
  { code: 59, kind: 'staff_request_reminder', recipient: 'staff', messageKey: 'staff.requestReminder' },
  { code: 60, kind: 'staff_visit_mark', recipient: 'staff', messageKey: 'staff.visitMark' },
] as const;

export const NOTIFY_KIND_BY_NAME = new Map(NOTIFY_KINDS.map((k) => [k.kind, k]));

export function notifyKindOf(kind: string): NotifyKindDef | undefined {
  return NOTIFY_KIND_BY_NAME.get(kind);
}

/** Отправлять вне тихих часов 21:00–10:00 по Еревану (§5, зафиксировано PLAN.md §6 №10 «E6») — только эти виды */
export const QUIET_HOURS_KINDS = new Set(['news', 'order_pickup_reminder', 'order_estimate_reminder', 'client_no_show', 'noshow_invite', 'review_request', 'birthday', 'repeat_invite']);
