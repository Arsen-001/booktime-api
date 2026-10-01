/**
 * Составные функции фасада (payVisitWithLoyalty, cancelVisitPaymentLine, cancelVisitPayments,
 * visitPaymentsForCashback) склеивают лояльность с журналом и финансами. На сервер переносятся только их
 * части лояльности (commit/reverse/syncBookingCashback/financeLinesOf/setTxFinanceLine) — склейку делает
 * фронт вызовами уже переведённых фасадов journal/finance. Сюда эти функции не должны доходить.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LoyaltyRefundInput, LoyaltySaleInput } from '../../finance/loyalty-sales.service.js';
import { ApiError, queueFinanceEffect } from './shim.js';

export type { LoyaltySaleInput };
export type BookingExtras = any;
export type JournalPaymentMethod = string;

function notOnServer(name: string): never {
  throw new Error(`loyalty port: ${name} is composed on the frontend, not on the server`);
}

export const cancelBookingPayment = (..._: unknown[]): Promise<any> => notOnServer('cancelBookingPayment');
export const cancelPaymentLine = (..._: unknown[]): Promise<any> => notOnServer('cancelPaymentLine');
export const payBookingLines = (..._: unknown[]): Promise<any> => notOnServer('payBookingLines');
export const addBookingPromoDiscount = (..._: unknown[]): Promise<any> => notOnServer('addBookingPromoDiscount');
export const getBookingPaymentSummary = (..._: unknown[]): Promise<any> => notOnServer('getBookingPaymentSummary');
export const removeBookingPaymentLine = (..._: unknown[]): Promise<any> => notOnServer('removeBookingPaymentLine');
export const getBookingExtras = (..._: unknown[]): Promise<any> => notOnServer('getBookingExtras');

/**
 * Деньги продаж лояльности (01.10.2026, src/api/finance.ts recordLoyaltySaleSync / cancelLoyaltySaleSync /
 * refundLoyaltySaleSync мока): здесь только копятся в контексте вызова, а в кассу их проводит runner в той же
 * транзакции (LoyaltySalesService). Ошибка проводки (нет способа/кассы) откатывает и саму продажу — как
 * recordSaleOrRollback фасада.
 */
export function recordLoyaltySaleSync(businessId: string, input: LoyaltySaleInput): { refId?: string; amount: number } {
  if (!(Math.round(input.amount) > 0)) throw new ApiError('invalid_amount');
  queueFinanceEffect({ type: 'sale', businessId, input });
  return { refId: input.refId, amount: Math.round(input.amount) };
}

export function cancelLoyaltySaleSync(businessId: string, refId: string): number {
  queueFinanceEffect({ type: 'cancel', businessId, refId });
  return 0;
}

export function refundLoyaltySaleSync(businessId: string, input: LoyaltyRefundInput): undefined {
  if (!(Math.round(input.amount) > 0)) throw new ApiError('invalid_amount');
  queueFinanceEffect({ type: 'refund', businessId, input });
  return undefined;
}
