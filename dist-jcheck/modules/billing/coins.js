import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { utcToLocal } from '../../common/time/time.js';
/** CoinMove фронта (src/domain/core.ts) */
export function coinMoveView(e) {
    return { id: e.id, businessId: e.businessId, amount: e.amount, kind: e.kind, reason: e.reason, area: e.area, refId: e.refId ?? undefined, by: e.by, at: utcToLocal(e.at) };
}
/** Строка кошелька под блокировкой (06 §2.2: `SELECT … FOR UPDATE` строки баланса) — только внутри транзакции */
async function lockWallet(tx, businessId) {
    await tx.coinWallet.createMany({ data: [{ businessId, balance: 0 }], skipDuplicates: true });
    const rows = await tx.$queryRaw `SELECT balance FROM coin_wallets WHERE business_id = ${businessId} FOR UPDATE`;
    return Number(rows[0]?.balance ?? 0);
}
async function append(tx, input, kind, sign) {
    if (!Number.isInteger(input.amount) || input.amount <= 0)
        throw new ApiError('validation', 'Coin amount must be a positive integer', { amount: 'positive' });
    const balance = await lockWallet(tx, input.businessId);
    if (sign < 0 && balance < input.amount)
        throw new ApiError('insufficient_coins', `Balance ${balance} < ${input.amount}`);
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
export const spendCoins = (tx, input) => append(tx, input, 'charge', -1);
/** Начислить: пополнение, возврат (отказ модерации), подарок платформы */
export const grantCoins = (tx, input, kind = 'topup') => append(tx, input, kind, 1);
export async function coinBalance(db, businessId) {
    const w = await db.coinWallet.findUnique({ where: { businessId } });
    return w?.balance ?? 0;
}
//# sourceMappingURL=coins.js.map