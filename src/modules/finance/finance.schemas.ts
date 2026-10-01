import { z } from 'zod';

const id32 = z.string().min(1).max(32);
const money = z.number().int().min(0).max(1_000_000_000_000);
const positiveMoney = z.number().int().min(1).max(1_000_000_000_000);
const name160 = z.string().min(1).max(160);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

// ─────────────────────────── Кассы (F-07-001…006) ───────────────────────────

export const cashRegisterBody = z.object({
  locationId: id32,
  name: name160,
  kind: z.enum(['cash', 'card', 'other']).default('cash'),
  openingBalance: money.default(0),
  note: z.string().max(400).optional(),
});
export type CashRegisterBody = z.infer<typeof cashRegisterBody>;
/** НЕ `cashRegisterBody.partial()`: у полей есть `.default()` (kind/openingBalance), и zod применяет
 * дефолт на отсутствующий ключ даже под `.optional()` — патч без поля тихо обнулял бы его (найдено curl'ом
 * этого же этапа: `{feePercent}` у payment-methods проваливался в 0 при патче одного `active`; тот же класс
 * бага, что ловили раньше в этом проекте, — правило «не молчать про то, что не проверено», PROGRESS.md §12). */
export const cashRegisterPatchBody = z.object({
  locationId: id32.optional(),
  name: name160.optional(),
  kind: z.enum(['cash', 'card', 'other']).optional(),
  openingBalance: money.optional(),
  note: z.string().max(400).optional(),
});

export const reorderBody = z.object({ orderedIds: z.array(id32).min(1).max(200) });
export type ReorderBody = z.infer<typeof reorderBody>;

export const transferFundsBody = z.object({
  fromAccountId: id32,
  toAccountId: id32,
  amount: positiveMoney,
  comment: z.string().max(400).optional(),
  date: localDateTime.optional(),
});
export type TransferFundsBody = z.infer<typeof transferFundsBody>;

// ─────────────────────────── Статьи (F-07-007…009) ───────────────────────────

export const paymentItemBody = z.object({
  name: name160,
  kind: z.enum(['income', 'expense']),
  comment: z.string().max(400).optional(),
});
export type PaymentItemBody = z.infer<typeof paymentItemBody>;
export const paymentItemPatchBody = paymentItemBody.partial();

// ─────────────────────────── Методы оплаты (F-07-025…035, упрощённо) ───────────────────────────

export const paymentMethodBody = z.object({
  label: z.string().min(1).max(80),
  feePercent: z.number().int().min(0).max(100).default(0),
  accountId: id32.nullable().default(null),
});
export type PaymentMethodBody = z.infer<typeof paymentMethodBody>;
/** НЕ `paymentMethodBody.partial()` — см. комментарий у `cashRegisterPatchBody`: те же два дефолтных поля. */
export const paymentMethodPatchBody = z.object({
  label: z.string().min(1).max(80).optional(),
  feePercent: z.number().int().min(0).max(100).optional(),
  accountId: id32.nullable().optional(),
  active: z.boolean().optional(),
});

// ─────────────────────────── Контрагенты (F-07-019…023) ───────────────────────────

export const counterpartyBody = z.object({
  type: z.enum(['supplier', 'company', 'person', 'other']),
  name: name160,
  inn: z.string().max(32).optional(),
  phone: z.string().max(16).optional(),
  email: z.string().max(160).optional(),
  contact: z.string().max(160).optional(),
  note: z.string().max(400).optional(),
  /** Язык сообщений поставщику (заказ в WhatsApp); null — сбросить на язык кабинета */
  messageLang: z.enum(['hy', 'ru', 'en']).nullable().optional(),
});
export type CounterpartyBody = z.infer<typeof counterpartyBody>;
export const counterpartyPatchBody = counterpartyBody.partial();
export const importCounterpartiesBody = z.object({ rows: z.array(counterpartyBody).min(1).max(2000) });

// ─────────────────────────── Документы (F-07-024) ───────────────────────────

export const documentPatchBody = z.object({ note: z.string().max(400).optional() });

// ─────────────────────────── Операции (F-07-010…018) ───────────────────────────

export const finOpBody = z.object({
  locationId: id32,
  accountId: id32,
  itemId: id32,
  kind: z.enum(['income', 'expense']),
  amount: positiveMoney,
  date: localDateTime,
  method: z.enum(['cash', 'card', 'transfer', 'other']),
  partyType: z.enum(['counterparty', 'client', 'staff', 'none']).default('none'),
  partyId: id32.optional(),
  partyName: z.string().max(160).optional(),
  comment: z.string().max(400).optional(),
  source: z.enum(['manual', 'booking', 'transfer', 'import', 'sale', 'payroll', 'account']).default('manual'),
  refId: id32.optional(),
  docNumber: z.string().max(20).optional(),
  lineLabel: z.string().max(160).optional(),
});
export type FinOpBody = z.infer<typeof finOpBody>;

export const finOpPatchBody = z.object({
  accountId: id32.optional(),
  itemId: id32.optional(),
  amount: positiveMoney.optional(),
  date: localDateTime.optional(),
  method: z.enum(['cash', 'card', 'transfer', 'other']).optional(),
  partyType: z.enum(['counterparty', 'client', 'staff', 'none']).optional(),
  partyId: id32.optional(),
  partyName: z.string().max(160).optional(),
  comment: z.string().max(400).optional(),
});
export type FinOpPatchBody = z.infer<typeof finOpPatchBody>;

export const importFinOpsBody = z.object({ rows: z.array(finOpBody).min(1).max(5000) });

// ─────────────────────────── Возвраты и штрафы (F-07-066…075) ───────────────────────────

export const refundBody = z.object({
  finOpId: id32,
  amount: positiveMoney,
  comment: z.string().max(400).optional(),
});
export type RefundBody = z.infer<typeof refundBody>;

export const fineBody = z.object({
  locationId: id32,
  accountId: id32,
  clientId: id32,
  amount: positiveMoney,
  comment: z.string().max(400).optional(),
});
export type FineBody = z.infer<typeof fineBody>;

// ─────────────────────────── Оплата визита (F-07-036…050/181/184) ───────────────────────────

export const paySplitPart = z.object({ methodKey: z.string().min(1).max(32), amount: positiveMoney, accountId: id32.optional(), loyaltyAccountId: id32.optional(), debt: z.boolean().optional() });
export const payBookingBody = z.union([
  z.object({ mode: z.literal('quick'), methodKey: z.string().min(1).max(32), accountId: id32.optional() }),
  z.object({ mode: z.literal('split'), parts: z.array(paySplitPart).min(1).max(10) }),
]);
export type PayBookingBody = z.infer<typeof payBookingBody>;

export const bookingPaymentNoteBody = z.object({ note: z.string().max(1000) });
export const refundBookingFullBody = z.object({ reason: z.string().max(400) });

// ─────────────────────────── Продажи лояльности в кассу (qa/full-test-0930, 01.10.2026) ───────────────────────────

/** LoyaltySaleInput мока (recordLoyaltySale, src/api/finance.ts) */
export const loyaltySaleBody = z.object({
  kind: z.enum(['membership', 'certificate', 'accountTopUp']),
  locationId: id32,
  amount: positiveMoney,
  methodKey: z.string().min(1).max(32),
  clientId: id32.optional(),
  clientName: z.string().max(160).optional(),
  refId: id32.optional(),
  label: z.string().max(160).optional(),
});
export type LoyaltySaleBody = z.infer<typeof loyaltySaleBody>;
