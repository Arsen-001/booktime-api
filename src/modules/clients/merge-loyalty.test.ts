/**
 * Ответ 13 (владелец 17.11.2026): объединение дублей переносит абонементы, сертификаты, карту лояльности и личный счёт
 * на оставшуюся карточку. Пример: у «Ани М.» абонемент на 5 визитов и 3 000 ֏ — после объединения они у «Ани Мелкумян».
 * База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { mergeLoyaltyTx } = await import('./clients.service.js');

type Row = Record<string, unknown> & { id: string };
function table(rows: Row[]) {
  const match = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    rows,
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as object)) r[k] = (r[k] as bigint) + ((v as { increment: bigint }).increment as bigint);
        else r[k] = v;
      }
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => match(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    delete: async ({ where }: { where: { id: string } }) => void rows.splice(rows.findIndex((x) => x.id === where.id), 1),
  };
}

test('абонемент, сертификат, карта и счёт дубля — у оставшейся карточки, деньги и бонусы не теряются', async () => {
  const B = 'biz_nuri';
  const db = {
    membershipSale: table([{ id: 'm1', businessId: B, clientId: 'dup', data: { id: 'm1', clientId: 'dup', visitsLeft: 5 } }]),
    certificate: table([{ id: 'c1', businessId: B, clientId: 'dup', data: null }]),
    loyaltyTx: table([
      { id: 't1', businessId: B, clientId: 'dup', source: 'card', refId: 'card_dup', data: { id: 't1', clientId: 'dup', cardId: 'card_dup' } },
      { id: 't2', businessId: B, clientId: 'dup', source: 'account', refId: 'acc_dup', data: null },
    ]),
    loyaltyCard: table([
      { id: 'card_keep', businessId: B, clientId: 'keep', cardTypeId: 'ct1', balance: 700n, data: null },
      { id: 'card_dup', businessId: B, clientId: 'dup', cardTypeId: 'ct1', balance: 300n, data: null },
    ]),
    clientAccount: table([
      { id: 'acc_keep', businessId: B, clientId: 'keep', typeId: 'dep', balance: 24000n, data: null },
      { id: 'acc_dup', businessId: B, clientId: 'dup', typeId: 'dep', balance: 3000n, data: null },
    ]),
    clientAccountOp: table([{ id: 'op1', accountId: 'acc_dup', data: { id: 'op1', accountId: 'acc_dup', amount: 3000 } }]),
    bookingPayment: table([{ id: 'p1', loyaltyAccountId: 'acc_dup' }]),
    finOp: table([{ id: 'f1', businessId: B, partyType: 'client', partyId: 'dup' }]),
  };
  await mergeLoyaltyTx(db as never, B, 'keep', 'dup');
  assert.equal(db.membershipSale.rows[0]!.clientId, 'keep');
  assert.equal((db.membershipSale.rows[0]!.data as { clientId: string }).clientId, 'keep');
  assert.equal(db.certificate.rows[0]!.clientId, 'keep');
  // карта того же типа: бонусы сложены, пустая карта дубля удалена, история бонусов — у оставшейся
  assert.deepEqual(db.loyaltyCard.rows.map((r) => [r.id, r.balance]), [['card_keep', 1000n]]);
  assert.equal(db.loyaltyTx.rows[0]!.refId, 'card_keep');
  assert.equal((db.loyaltyTx.rows[0]!.data as { cardId: string }).cardId, 'card_keep');
  // счёт того же типа: 24 000 + 3 000 = 27 000, операции и оплаты визитов — на нём, счёт дубля удалён
  assert.deepEqual(db.clientAccount.rows.map((r) => [r.id, r.balance]), [['acc_keep', 27000n]]);
  assert.equal(db.clientAccountOp.rows[0]!.accountId, 'acc_keep');
  assert.equal((db.clientAccountOp.rows[0]!.data as { accountId: string }).accountId, 'acc_keep');
  assert.equal(db.bookingPayment.rows[0]!.loyaltyAccountId, 'acc_keep');
  assert.equal(db.loyaltyTx.rows[1]!.refId, 'acc_keep');
  assert.equal(db.finOp.rows[0]!.partyId, 'keep');
});

test('у оставшейся нет карты и счёта этого типа — карта и счёт дубля просто переезжают', async () => {
  const B = 'biz_nuri';
  const db = {
    membershipSale: table([]),
    certificate: table([]),
    loyaltyTx: table([]),
    loyaltyCard: table([{ id: 'card_dup', businessId: B, clientId: 'dup', cardTypeId: 'ct1', balance: 300n, data: { id: 'card_dup', clientId: 'dup' } }]),
    clientAccount: table([{ id: 'acc_dup', businessId: B, clientId: 'dup', typeId: 'dep', balance: 3000n, data: null }]),
    clientAccountOp: table([]),
    bookingPayment: table([]),
    finOp: table([]),
  };
  await mergeLoyaltyTx(db as never, B, 'keep', 'dup');
  assert.deepEqual(db.loyaltyCard.rows.map((r) => [r.clientId, r.balance, (r.data as { clientId: string }).clientId]), [['keep', 300n, 'keep']]);
  assert.deepEqual(db.clientAccount.rows.map((r) => [r.clientId, r.balance]), [['keep', 3000n]]);
});
