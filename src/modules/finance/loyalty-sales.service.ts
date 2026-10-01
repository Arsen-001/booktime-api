import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { FinanceCatalogService } from './finance-catalog.service.js';

type Tx = Prisma.TransactionClient;

/** LoyaltySaleInput мока (src/api/finance.ts) */
export interface LoyaltySaleInput {
  /** Что продали: абонемент, сертификат или пополнение счёта клиента — задаёт статью */
  kind: 'membership' | 'certificate' | 'accountTopUp';
  locationId: string;
  amount: number;
  /** Способ оплаты — ключ плитки ('cash', 'card', свой способ): касса и вид операции */
  methodKey: string;
  clientId?: string;
  clientName?: string;
  /** id проданного абонемента / сертификата / операции пополнения счёта — связь для отмены и возврата */
  refId?: string;
  /** Подпись в колонке «Услуга/Товар», например «Абонемент «10 занятий»» */
  label?: string;
}

/** LoyaltyRefundInput мока */
export interface LoyaltyRefundInput {
  /** Продажа, за которую возвращают: id сертификата/абонемента или id операций пополнения счёта (любой из них) */
  refId: string | string[];
  amount: number;
  /** Способ возврата — ключ плитки; нет — той же кассой и способом, что был приход */
  methodKey?: string;
  comment?: string;
}

/** Денежные последствия операции «Лояльности» — копятся в порте (port/stubs.ts) и проводятся в той же транзакции */
export type LoyaltyFinanceEffect =
  | { type: 'sale'; businessId: string; input: LoyaltySaleInput }
  | { type: 'cancel'; businessId: string; refId: string }
  | { type: 'refund'; businessId: string; input: LoyaltyRefundInput };

const SALE_ITEM: Record<LoyaltySaleInput['kind'], 'membershipSale' | 'certificateSale' | 'accountTopUp'> = { membership: 'membershipSale', certificate: 'certificateSale', accountTopUp: 'accountTopUp' };

function operationMethodOf(kind: string): 'cash' | 'card' | 'other' {
  if (kind === 'cash') return 'cash';
  if (kind === 'card' || kind === 'installment') return 'card';
  return 'other';
}

/**
 * Продажи лояльности в кассу (qa/full-test-0930 loyalty.md/finance.md, 01.10.2026) — порт recordLoyaltySaleSync /
 * cancelLoyaltySaleSync / refundLoyaltySaleSync мока. Продажа абонемента/сертификата и пополнение счёта — приход
 * (статья «Продажа абонемента» / «Продажа сертификата» / «Пополнение счёта»; source 'sale', у пополнения 'account'),
 * отмена продажи — отмена прихода, частичный возврат — расход «Возврат» из кассы прихода. Всё — в транзакции
 * вызывающего: не записалось в кассу (нет способа/кассы) — откатывается и сама продажа.
 */
@Injectable()
export class LoyaltySalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: FinanceCatalogService,
  ) {}

  /** Проводит последствия по порядку в транзакции `tx` (операции «Лояльности») */
  async apply(tx: Tx, effects: LoyaltyFinanceEffect[], by: string): Promise<void> {
    for (const e of effects) {
      if (e.type === 'sale') await this.recordTx(tx, e.businessId, e.input, by);
      else if (e.type === 'cancel') await this.cancelTx(tx, e.businessId, e.refId, by);
      else await this.refundTx(tx, e.businessId, e.input, by);
    }
  }

  /** POST …/finance/loyalty-sales — recordLoyaltySale мока отдельным запросом */
  record(businessId: string, input: LoyaltySaleInput, by: string) {
    return this.prisma.$transaction((tx) => this.recordTx(tx, businessId, input, by));
  }

  async recordTx(tx: Tx, businessId: string, input: LoyaltySaleInput, by: string) {
    const amount = Math.round(input.amount);
    if (!(amount > 0)) throw new ApiError('invalid_amount', 'Amount must be positive');
    const itemId = await this.catalog.systemItemId(businessId, SALE_ITEM[input.kind]);
    const method = await tx.paymentMethod.findFirst({ where: { businessId, key: input.methodKey, active: true } });
    if (!method) throw new ApiError('method_not_found', 'Payment method not found');
    if (!method.accountId) throw new ApiError('payment_setup_incomplete', 'Payment method has no cash register');
    // Филиал продажи — из формы; чужой/удалённый (счёт клиента, открытый в другом филиале сети) — филиал кассы
    const location = await tx.location.findFirst({ where: { id: input.locationId, businessId }, select: { id: true } });
    const register = location ? null : await tx.cashRegister.findFirst({ where: { id: method.accountId, businessId }, select: { locationId: true } });
    const locationId = location?.id ?? register?.locationId;
    if (!locationId) throw new ApiError('payment_setup_incomplete', 'Cash register not found');
    const at = new Date();
    const id = newId('finOp');
    const row = await tx.finOp.create({
      data: {
        id,
        businessId,
        locationId,
        accountId: method.accountId,
        itemId,
        kind: 'income',
        amount: BigInt(amount),
        date: at,
        method: operationMethodOf(method.kind),
        partyType: input.clientId ? 'client' : 'none',
        partyId: input.clientId,
        partyName: input.clientName?.slice(0, 160),
        source: input.kind === 'accountTopUp' ? 'account' : 'sale',
        refId: input.refId,
        lineLabel: input.label?.slice(0, 160),
        history: [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue,
        createdBy: by,
        updatedBy: by,
      },
    });
    return { id: row.id, accountId: row.accountId, amount };
  }

  private saleOps(tx: Tx, businessId: string, refIds: string[]) {
    return tx.finOp.findMany({ where: { businessId, kind: 'income', cancelled: false, refId: { in: refIds }, source: { in: ['sale', 'account'] } }, orderBy: { createdAt: 'desc' } });
  }

  /** Отмена продажи (сертификата, абонемента, пополнения счёта): приход — в «Отменённые». Нет прихода — ничего. */
  async cancelTx(tx: Tx, businessId: string, refId: string, by: string): Promise<number> {
    const ops = await this.saleOps(tx, businessId, [refId]);
    const now = new Date();
    for (const op of ops) {
      const history = Array.isArray(op.history) ? [...(op.history as Record<string, unknown>[])] : [];
      history.push({ at: now.toISOString(), by, action: 'cancelled' });
      await tx.finOp.update({ where: { id: op.id }, data: { cancelled: true, cancelledAt: now, cancelledBy: by, history: history as Prisma.InputJsonValue } });
    }
    return ops.length;
  }

  /** Частичный/полный возврат за продажу — расход «Возврат» из кассы прихода (исходный приход не трогаем) */
  async refundTx(tx: Tx, businessId: string, input: LoyaltyRefundInput, by: string): Promise<void> {
    const amount = Math.round(input.amount);
    if (!(amount > 0)) throw new ApiError('invalid_amount', 'Amount must be positive');
    const refIds = Array.isArray(input.refId) ? input.refId : [input.refId];
    const source = (await this.saleOps(tx, businessId, refIds))[0];
    const method = input.methodKey ? await tx.paymentMethod.findFirst({ where: { businessId, key: input.methodKey, active: true } }) : null;
    const accountId = method?.accountId ?? source?.accountId;
    if (!accountId) return;
    const itemId = await this.catalog.systemItemId(businessId, 'refund');
    const account = await tx.cashRegister.findFirst({ where: { id: accountId, businessId }, select: { locationId: true } });
    const locationId = account?.locationId ?? source?.locationId;
    if (!locationId) return;
    const at = new Date();
    await tx.finOp.create({
      data: {
        id: newId('finOp'),
        businessId,
        locationId,
        accountId,
        itemId,
        kind: 'expense',
        amount: BigInt(amount),
        date: at,
        method: method ? operationMethodOf(method.kind) : (source?.method ?? 'cash'),
        partyType: source?.partyType ?? 'none',
        partyId: source?.partyId,
        partyName: source?.partyName,
        comment: (input.comment ?? (source?.lineLabel ? `Возврат · ${source.lineLabel}` : 'Возврат клиенту')).slice(0, 400),
        source: source?.source ?? 'sale',
        refId: source?.refId ?? refIds[0],
        refundOfId: source?.id,
        lineLabel: source?.lineLabel,
        history: [{ at: at.toISOString(), by, action: 'created' }] as Prisma.InputJsonValue,
        createdBy: by,
        updatedBy: by,
      },
    });
    if (source) {
      const history = Array.isArray(source.history) ? [...(source.history as Record<string, unknown>[])] : [];
      history.push({ at: at.toISOString(), by, action: 'refunded' });
      await tx.finOp.update({ where: { id: source.id }, data: { refundedAmount: { increment: BigInt(amount) }, history: history as Prisma.InputJsonValue } });
    }
  }
}
