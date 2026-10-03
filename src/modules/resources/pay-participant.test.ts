/**
 * Оплата участника группового события (F-16-060/061, F-06-072; хвост qa/full-test-0930, 03.10.2026): наличные и карта —
 * оплата визита через финансы (BookingPaymentsService.pay → операция в кассе), а не отметка prepayment.paid мимо кассы;
 * «Абонемент» списывает одно посещение; отмена нал/карты отменяет платёж визита. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { ResourcesEventsService } = await import('./resources-events.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

type Row = Record<string, unknown>;

function bookingRow(over: Row = {}): Row {
  const at = new Date('2026-10-03T10:00:00Z');
  return {
    id: 'bk_1', businessId: 'biz_1', locationId: 'loc_1', staffId: 'st_1', clientId: 'cl_1', appUserId: null,
    startAt: at, endAt: at, durationMin: 60, status: 'scheduled', services: [{ serviceId: 'sv_yoga', price: 4000 }], total: 4000n,
    resourceIds: [], workplace: 'hall', source: 'journal', createdByRef: 'st_1', forWhom: 'self', visitorName: null, comment: null,
    prepayment: null, holdUntil: null, confirmDeadline: null, cancelledLate: false, cancelReason: null, cancelledBy: null,
    groupEventId: 'ev_1', seriesId: null, visitId: null, staffAssignment: null, extras: {}, paidAmount: 0n, onlineMeta: null,
    createdAt: at, updatedAt: at, deletedAt: null, version: 1, ...over,
  };
}

function setup(opts: { memberships?: { id: string; applicable: boolean; balanceVisits: number }[]; lines?: Row[] } = {}) {
  const booking = bookingRow();
  const calls: { pay: unknown[][]; cancelLine: string[]; loyalty: { op: string; args: unknown[] }[] } = { pay: [], cancelLine: [], loyalty: [] };
  const bookingTable = {
    findFirst: async () => booking,
    findUniqueOrThrow: async () => booking,
    update: async ({ data }: { data: Row }) => {
      for (const [k, v] of Object.entries(data)) if (k !== 'version') booking[k] = v;
      return booking;
    },
  };
  const prisma = {
    booking: bookingTable,
    bookingPayment: { findMany: async () => opts.lines ?? [] },
    finOp: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const payments = {
    pay: async (...args: unknown[]) => {
      calls.pay.push(args);
      booking.paidAmount = 4000n;
    },
    cancelLine: async (_ctx: unknown, _biz: string, lineId: string) => {
      calls.cancelLine.push(lineId);
    },
  };
  const loyalty = {
    scopeOf: async (b: string) => [b],
    run: async (op: string, args: unknown[]) => {
      calls.loyalty.push({ op, args });
      if (op === 'getLoyaltyBookingSummary') return { memberships: opts.memberships ?? [] };
      return {};
    },
  };
  const resources = { tzOfBusiness: async () => 'Asia/Yerevan' };
  const audit = { record: async () => undefined };
  const svc = new ResourcesEventsService(prisma as never, {} as never, {} as never, resources as never, audit as never, payments as never, loyalty as never);
  return { svc, booking, calls };
}

const ctx = { requestId: 'r', ip: '', device: '', session: null, member: { businessId: 'biz_1', staffId: 'st_admin', permissions: new Set<string>() } } as never;

for (const method of ['cash', 'card'] as const) {
  test(`${method}: оплата визита через финансы (касса), без отметки prepayment.paid`, async () => {
    const { svc, booking, calls } = setup();
    const view = await svc.payParticipant(ctx, 'biz_1', 'bk_1', method);
    assert.equal(calls.pay.length, 1);
    assert.deepEqual(calls.pay[0]!.slice(1), ['biz_1', 'bk_1', { mode: 'quick', methodKey: method }]);
    assert.equal(booking.prepayment, null, 'деньги не уходят мимо кассы отметкой предоплаты');
    assert.equal((booking.extras as { participantPayment?: { method: string } }).participantPayment?.method, method);
    assert.equal(view.id, 'bk_1');
  });
}

test('cash → отмена: платёж визита отменяется в финансах, отметка снимается', async () => {
  const lines = [
    { id: 'bp_1', groupId: 'g_1' },
    { id: 'bp_2', groupId: 'g_1' },
  ];
  const { svc, booking, calls } = setup({ lines });
  await svc.payParticipant(ctx, 'biz_1', 'bk_1', 'cash');
  await svc.cancelParticipantPayment(ctx, 'biz_1', 'bk_1');
  assert.deepEqual(calls.cancelLine, ['bp_1'], 'одна группа строк — одна отмена');
  assert.equal((booking.extras as { participantPayment?: unknown }).participantPayment, undefined);
});

test('абонемент: списывает одно посещение с применимого абонемента', async () => {
  const { svc, calls } = setup({ memberships: [{ id: 'mb_old', applicable: false, balanceVisits: 5 }, { id: 'mb_1', applicable: true, balanceVisits: 3 }] });
  await svc.payParticipant(ctx, 'biz_1', 'bk_1', 'membership');
  assert.equal(calls.pay.length, 0, 'абонемент — не деньги в кассу');
  const summary = calls.loyalty.find((c) => c.op === 'getLoyaltyBookingSummary')!;
  assert.deepEqual(summary.args, ['biz_1', 'cl_1', ['sv_yoga']]);
  const adjust = calls.loyalty.find((c) => c.op === 'adjustMembership')!;
  assert.deepEqual(adjust.args.slice(0, 3), ['biz_1', 'mb_1', { balanceVisits: 2 }]);
});

test('абонемент: нет подходящего — 422 no_membership, ничего не списано и не отмечено', async () => {
  const { svc, booking, calls } = setup({ memberships: [{ id: 'mb_1', applicable: true, balanceVisits: 0 }] });
  await assert.rejects(svc.payParticipant(ctx, 'biz_1', 'bk_1', 'membership'), (e: unknown) => e instanceof ApiError && e.code === 'no_membership' && e.status === 422);
  assert.ok(!calls.loyalty.some((c) => c.op === 'adjustMembership'));
  assert.equal((booking.extras as { participantPayment?: unknown }).participantPayment, undefined);
});
