/**
 * Места подписки (проход 17.11.2026, группа 4): то же правило, что у сайта (src/areas/staff/pricing.ts) — ассистент
 * по галочке или должности «Ассистент…» и приглашённый, ещё не вошедший мастер — бесплатно. Раньше «Ассистент
 * мастера» без галочки сайт считал бесплатным, а подписка — платным (лицензия 24 000 ֏ против 32 000 ֏ в подписке).
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { computeSeats, isAssistant } = await import('./billing-seats.js');
type PrismaService = import('../../common/prisma.service.js').PrismaService;

const prices = { individual: 5000, masterSeat: 4000, adminExtraSeat: 2000, minPaidMasters: 2 } as unknown as Parameters<typeof computeSeats>[2];

function db(staff: Record<string, unknown>[], scheduled: string[]) {
  return {
    business: { findUnique: async () => ({ kind: 'salon' }) },
    staff: { findMany: async () => staff },
    workSchedule: { findMany: async () => scheduled.map((staffId) => ({ staffId })) },
  } as unknown as PrismaService;
}

const st = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, role, status: 'active', position: null, assistantOnly: false, serviceIds: ['sv_1'], hiredAt: new Date('2026-01-01'), ...extra,
});

test('ассистент — по галочке или по должности на любом языке', () => {
  assert.equal(isAssistant({ assistantOnly: true, position: null }), true);
  assert.equal(isAssistant({ assistantOnly: false, position: { ru: 'Ассистент мастера' } }), true);
  assert.equal(isAssistant({ assistantOnly: false, position: { en: 'Nail assistant' } }), true);
  assert.equal(isAssistant({ assistantOnly: false, position: { hy: 'Վարպետի օգնական' } }), true);
  assert.equal(isAssistant({ assistantOnly: false, position: { ru: 'Мастер маникюра' } }), false);
});

test('ассистент по должности и приглашённый — бесплатно; владелец с услугами и графиком — платно', async () => {
  const r = await computeSeats(
    db(
      [
        st('owner', 'owner'),
        st('admin', 'admin'),
        st('m1', 'master'),
        st('m2', 'master'),
        st('asst', 'master', { position: { ru: 'Ассистент мастера' } }),
        st('inv', 'master', { status: 'invited' }),
      ],
      ['owner', 'm1', 'm2'],
    ),
    'biz_1',
    prices,
  );
  const by = Object.fromEntries(r.seats.map((s) => [s.staffId, s]));
  assert.equal(by.owner!.reasonKey, 'ownerAsMaster');
  assert.equal(by.asst!.paid, false);
  assert.equal(by.asst!.reasonKey, 'assistantFree');
  assert.equal(by.inv!.paid, false);
  assert.equal(by.inv!.reasonKey, 'invitedPending');
  assert.equal(r.monthlyTotal, 3 * 4000);
});
