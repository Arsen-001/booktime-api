import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../common/ids/ids.js';
import { SYSTEM_ITEMS } from './finance-catalog.service.js';

type Tx = Prisma.TransactionClient;

/**
 * ⭐ F-00-097/F-00-100 (решение владельца 01.10.2026, qa/full-test-0930/finance.md): предоплата, которую клиент
 * перевёл на реквизиты мастера, — своя операция в финансах. «Деньги пришли» (prepayment-received) — приход
 * «Оплата услуги», способ «перевод», касса «Предоплата на реквизиты» филиала, привязан к записи; «Вернул»
 * (refund-done) — обратная операция «Возврат» с той же кассы. Обе идемпотентны. Порт recordPrepaymentReceivedSync /
 * recordPrepaymentRefundSync мока (src/api/finance.ts). На визите касса берёт только остаток (booking.paidAmount уже
 * включает полученную предоплату), поэтому деньги дня сходятся ровно один раз.
 *
 * Касса «Предоплата на реквизиты» — системная (systemGenerated), по одной на филиал. Её id выводится из id филиала
 * (`frpp_…`), поэтому заводится без миграции (у CashRegister нет колонки systemKey) и без гонки двух первых
 * предоплат: вторая вставка того же id — skipDuplicates. Экран узнаёт её по `systemKey: 'prepayment'` во view.
 */
export const PREPAYMENT_REGISTER_PREFIX = 'frpp_';
export const PREPAYMENT_LINE_LABEL = 'Предоплата';
const PREPAYMENT_REGISTER_NAME = 'Предоплата на реквизиты';

export function prepaymentRegisterId(locationId: string): string {
  const tail = locationId.includes('_') ? locationId.slice(locationId.indexOf('_') + 1) : locationId;
  return `${PREPAYMENT_REGISTER_PREFIX}${tail}`.slice(0, 32);
}

export function isPrepaymentRegister(id: string): boolean {
  return id.startsWith(PREPAYMENT_REGISTER_PREFIX);
}

/** Системные статьи бизнеса внутри транзакции — все сразу (иначе ensureDefaults решил бы, что статьи уже заведены) */
async function systemItemIdTx(tx: Tx, businessId: string, key: keyof typeof SYSTEM_ITEMS): Promise<string> {
  const found = await tx.paymentItem.findFirst({ where: { businessId, systemKey: key }, select: { id: true } });
  if (found) return found.id;
  await tx.paymentItem.createMany({
    data: Object.entries(SYSTEM_ITEMS).map(([systemKey, v]) => ({ id: newId('paymentItem'), businessId, name: v.name, kind: v.kind, systemKey, createdBy: 'system', updatedBy: 'system' })),
    skipDuplicates: true,
  });
  return (await tx.paymentItem.findFirstOrThrow({ where: { businessId, systemKey: key }, select: { id: true } })).id;
}

async function prepaymentRegisterTx(tx: Tx, businessId: string, locationId: string): Promise<string> {
  const id = prepaymentRegisterId(locationId);
  if (await tx.cashRegister.findUnique({ where: { id }, select: { id: true } })) return id;
  const max = await tx.cashRegister.aggregate({ where: { businessId }, _max: { order: true } });
  await tx.cashRegister.createMany({
    data: [{ id, businessId, locationId, name: PREPAYMENT_REGISTER_NAME, kind: 'other', order: (max._max.order ?? -1) + 1, systemGenerated: true, createdBy: 'system', updatedBy: 'system' }],
    skipDuplicates: true,
  });
  return id;
}

type BookingForPrepayment = { id: string; businessId: string; locationId: string; clientId: string | null; prepayment: unknown };

function prepaymentOps(tx: Tx, b: { id: string; businessId: string }) {
  return tx.finOp.findMany({ where: { businessId: b.businessId, refId: b.id, source: 'booking', lineLabel: PREPAYMENT_LINE_LABEL, cancelled: false } });
}

/** «Деньги пришли»: приход на кассу «Предоплата на реквизиты». Повтор — без дубля. */
export async function recordPrepaymentReceivedTx(tx: Tx, b: BookingForPrepayment, by: string): Promise<void> {
  const p = (b.prepayment ?? null) as { amount?: number; full?: boolean } | null;
  const amount = Math.round(Number(p?.amount ?? 0));
  if (!(amount > 0)) return;
  if ((await prepaymentOps(tx, b)).some((o) => o.kind === 'income')) return;
  const itemId = await systemItemIdTx(tx, b.businessId, 'servicePayment');
  const accountId = await prepaymentRegisterTx(tx, b.businessId, b.locationId);
  const client = b.clientId ? await tx.client.findFirst({ where: { id: b.clientId }, select: { id: true, name: true } }) : null;
  const at = new Date();
  await tx.finOp.create({
    data: {
      id: newId('finOp'),
      businessId: b.businessId,
      locationId: b.locationId,
      accountId,
      itemId,
      kind: 'income',
      amount: BigInt(amount),
      date: at,
      method: 'transfer',
      partyType: client ? 'client' : 'none',
      partyId: client?.id,
      partyName: client?.name,
      comment: p?.full ? 'Оплата всей суммы переводом на реквизиты мастера' : 'Предоплата переводом на реквизиты мастера',
      source: 'booking',
      refId: b.id,
      lineLabel: PREPAYMENT_LINE_LABEL,
      history: [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue,
      createdBy: by,
      updatedBy: by,
    },
  });
}

/** «Вернул»: расход «Возврат» на ту же сумму с той же кассы. Нет прихода или уже вернули — ничего. */
export async function recordPrepaymentRefundTx(tx: Tx, b: BookingForPrepayment, by: string): Promise<void> {
  const ops = await prepaymentOps(tx, b);
  const received = ops.find((o) => o.kind === 'income');
  if (!received || ops.some((o) => o.kind === 'expense')) return;
  const itemId = await systemItemIdTx(tx, b.businessId, 'refund');
  const at = new Date();
  await tx.finOp.create({
    data: {
      id: newId('finOp'),
      businessId: received.businessId,
      locationId: received.locationId,
      accountId: received.accountId,
      itemId,
      kind: 'expense',
      amount: received.amount,
      date: at,
      method: received.method,
      partyType: received.partyType,
      partyId: received.partyId,
      partyName: received.partyName,
      comment: 'Возврат предоплаты клиенту',
      source: 'booking',
      refId: b.id,
      refundOfId: received.id,
      lineLabel: PREPAYMENT_LINE_LABEL,
      history: [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue,
      createdBy: by,
      updatedBy: by,
    },
  });
  const history = Array.isArray(received.history) ? [...(received.history as Record<string, unknown>[])] : [];
  history.push({ at: at.toISOString(), by, action: 'refunded' });
  await tx.finOp.update({ where: { id: received.id }, data: { refundedAmount: received.amount, history: history as Prisma.InputJsonValue } });
}

// ─────────────────────────── Оплата участника группового события (F-16-060/061) ───────────────────────────

/** Подпись операции и строки платежа записи — оплата участника группового события, проведённая до 01.10 вечер своей
 * операцией (backend-2, заход 3). Теперь нал/карта участника — обычная оплата визита (resources-events.service
 * payParticipant → BookingPaymentsService.pay), а эти метки нужны только чтобы отменить старые оплаты. */
export const PARTICIPANT_LINE_LABEL = 'Оплата участника';
/** Метка строки extras.payments записи (как 'prepayment' у предоплаты) */
export const PARTICIPANT_PAYMENT_LABEL = 'participant';

/** Отмена старой оплаты участника — приход в «Отменённые» (остаток кассы как до оплаты). Нет прихода — ничего. */
export async function cancelParticipantPaymentTx(tx: Tx, b: { id: string; businessId: string }, by: string): Promise<void> {
  const ops = await tx.finOp.findMany({ where: { businessId: b.businessId, refId: b.id, source: 'booking', lineLabel: PARTICIPANT_LINE_LABEL, cancelled: false } });
  const now = new Date();
  for (const op of ops) {
    const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
    history.push({ at: now.toISOString(), by, action: 'cancelled' });
    await tx.finOp.update({ where: { id: op.id }, data: { cancelled: true, cancelledAt: now, cancelledBy: by, history: history as Prisma.InputJsonValue } });
  }
}
