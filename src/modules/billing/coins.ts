import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

export type CoinKind = 'topup' | 'charge' | 'refund' | 'gift';

export interface CoinMoveInput {
  businessId: string;
  /** Всегда положительное число монет; знак ставит вид движения */
  amount: number;
  reason: string;
  area: string;
  refId?: string | null;
  /** id сотрудника или 'system' */
  by: string;
  price?: bigint | null;
  idempotencyKey?: string | null;
}

/** CoinMove фронта (src/domain/core.ts) */
export function coinMoveView(e: { id: string; businessId: string; amount: number; kind: string; reason: string; area: string; refId: string | null; by: string; at: Date }) {
  return { id: e.id, businessId: e.businessId, amount: e.amount, kind: e.kind as CoinKind, reason: e.reason, area: e.area, refId: e.refId ?? undefined, by: e.by, at: utcToLocal(e.at) };
}

/** Строка кошелька под блокировкой (06 §2.2: `SELECT … FOR UPDATE` строки баланса) — только внутри транзакции */
async function lockWallet(tx: Tx, businessId: string): Promise<number> {
  await tx.coinWallet.createMany({ data: [{ businessId, balance: 0 }], skipDuplicates: true });
  const rows = await tx.$queryRaw<{ balance: number }[]>`SELECT balance FROM coin_wallets WHERE business_id = ${businessId} FOR UPDATE`;
  return Number(rows[0]?.balance ?? 0);
}

async function append(tx: Tx, input: CoinMoveInput, kind: CoinKind, sign: 1 | -1) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new ApiError('validation', 'Coin amount must be a positive integer', { amount: 'positive' });
  const balance = await lockWallet(tx, input.businessId);
  if (sign < 0 && balance < input.amount) throw new ApiError('insufficient_coins', `Balance ${balance} < ${input.amount}`);
  const entry = await tx.coinEntry.create({
    data: {
      id: newId('coinEntry'),
      businessId: input.businessId,
      amount: sign * input.amount,
      kind,
      reason: input.reason.slice(0, 40),
      area: input.area.slice(0, 20),
      refId: input.refId ?? null,
      price: input.price ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      by: input.by,
    },
  });
  await tx.coinWallet.update({ where: { businessId: input.businessId }, data: { balance: balance + sign * input.amount } });
  return entry;
}

/** Списать: не хватает — 402 insufficient_coins (экран показывает «Пополнить», а не серую кнопку) */
export const spendCoins = (tx: Tx, input: CoinMoveInput) => append(tx, input, 'charge', -1);
/** Начислить: пополнение, возврат (отказ модерации), подарок платформы */
export const grantCoins = (tx: Tx, input: CoinMoveInput, kind: Exclude<CoinKind, 'charge'> = 'topup') => append(tx, input, kind, 1);

export async function coinBalance(db: Db, businessId: string): Promise<number> {
  const w = await db.coinWallet.findUnique({ where: { businessId } });
  return w?.balance ?? 0;
}
