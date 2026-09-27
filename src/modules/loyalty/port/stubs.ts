/**
 * Составные функции фасада (payVisitWithLoyalty, cancelVisitPaymentLine, cancelVisitPayments,
 * visitPaymentsForCashback) склеивают лояльность с журналом и финансами. На сервер переносятся только их
 * части лояльности (commit/reverse/syncBookingCashback/financeLinesOf/setTxFinanceLine) — склейку делает
 * фронт вызовами уже переведённых фасадов journal/finance. Сюда эти функции не должны доходить.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
