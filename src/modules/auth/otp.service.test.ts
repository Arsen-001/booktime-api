/** OtpService: выбор канала, запасной канал и лимиты (база — в памяти). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SMS_MAX_PER_HOUR = '100';

const { OtpService, OTP } = await import('./otp.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');
type CodeSender = import('../../adapters/code-sender/code-sender.js').CodeSender;
type CodeChannel = import('../../adapters/code-sender/code-sender.js').CodeChannel;

type Row = Record<string, unknown> & { id: string; phone: string; purpose: string; channel: string; status: string; ip: string; sentAt: Date };

/** Ровно то подмножество Prisma, которым пользуется OtpService */
function memoryPrisma() {
  const rows: Row[] = [];
  const match = (r: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && 'gte' in v ? (r[k] as Date) >= (v as { gte: Date }).gte : r[k] === v,
    );
  const otpRequest = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => match(r, where)).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0] ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)).length,
    create: async ({ data }: { data: Omit<Row, 'sentAt' | 'status'> }) => {
      const row = { status: 'sent', attempts: 0, sentAt: new Date(), ...data } as unknown as Row;
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
  return { rows, otpRequest, $transaction: (ops: Promise<unknown>[]) => Promise.all(ops) };
}

function stub(channel: CodeChannel, enabled: boolean, fails = false) {
  const calls: string[] = [];
  const sender: CodeSender & { calls: string[] } = {
    channel,
    real: true,
    enabled,
    calls,
    async send(m) {
      calls.push(m.code);
      if (fails) throw new Error(`${channel} down`);
      return { providerMessageId: `${channel}-id` };
    },
  };
  return sender;
}

function setup(s: { tg?: boolean; wa?: boolean; sms?: boolean; tgFails?: boolean; waFails?: boolean }) {
  const prisma = memoryPrisma();
  const senders = {
    telegram: stub('telegram', s.tg ?? true, s.tgFails),
    whatsapp: stub('whatsapp', s.wa ?? false, s.waFails),
    sms: stub('sms', s.sms ?? false),
  };
  const otp = new OtpService(prisma as never, senders);
  return { prisma, senders, otp };
}

const base = { phone: '+37491123456', purpose: 'login' as const, ip: '10.0.0.1', locale: 'ru' as const };

async function apiError(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code);
}

/** Сдвинуть время всех записей назад — «прошло n секунд» */
function age(rows: Row[], sec: number) {
  rows.forEach((r) => (r.sentAt = new Date(r.sentAt.getTime() - sec * 1000)));
}

test('по умолчанию — Telegram; WhatsApp не настроен — его нет в списке каналов', async () => {
  const { otp, senders } = setup({});
  const sent = await otp.send({ ...base, channel: 'telegram' });
  assert.equal(sent.channel, 'telegram');
  assert.deepEqual(sent.channels, ['telegram']);
  assert.equal(senders.telegram.calls.length, 1);
});

test('Telegram не доставил, WhatsApp настроен → код в WhatsApp, одна запись', async () => {
  const { otp, senders, prisma } = setup({ wa: true, tgFails: true });
  const sent = await otp.send({ ...base, channel: 'telegram' });
  assert.equal(sent.channel, 'whatsapp');
  assert.deepEqual(sent.channels, ['telegram', 'whatsapp']);
  assert.equal(senders.whatsapp.calls[0], senders.telegram.calls[0], 'тот же код');
  assert.equal(prisma.rows.length, 1);
  assert.equal(prisma.rows[0]!.channel, 'whatsapp');
  assert.equal(prisma.rows[0]!.status, 'sent');
  assert.equal(prisma.rows[0]!.providerMessageId, 'whatsapp-id');
});

test('Telegram не доставил, WhatsApp не настроен → code_not_delivered (как раньше)', async () => {
  const { otp, prisma } = setup({ tgFails: true });
  await apiError(otp.send({ ...base, channel: 'telegram' }), 'code_not_delivered');
  assert.equal(prisma.rows[0]!.status, 'failed');
});

test('«Прислать в WhatsApp» уважает 60 с между кодами и часовой лимит', async () => {
  const { otp, prisma, senders } = setup({ wa: true });
  assert.equal((await otp.send({ ...base, channel: 'telegram' })).channel, 'telegram');
  await apiError(otp.send({ ...base, channel: 'whatsapp' }), 'code_resend_wait');
  assert.equal(senders.whatsapp.calls.length, 0);
  age(prisma.rows, OTP.resendSec);
  const again = await otp.send({ ...base, channel: 'whatsapp' });
  assert.equal(again.channel, 'whatsapp');
  // прежний код больше не действует
  assert.equal(prisma.rows[0]!.status, 'superseded');
  for (let i = 2; i < OTP.perPhoneHour; i++) {
    age(prisma.rows, OTP.resendSec);
    await otp.send({ ...base, channel: i % 2 ? 'telegram' : 'whatsapp' });
  }
  age(prisma.rows, OTP.resendSec);
  await apiError(otp.send({ ...base, channel: 'whatsapp' }), 'rate_limited');
});

test('запасной канал не тратит лишний код из лимита', async () => {
  const { otp, prisma } = setup({ wa: true, tgFails: true });
  await otp.send({ ...base, channel: 'telegram' });
  assert.equal(prisma.rows.length, 1);
});

test('SMS — последним: Telegram и WhatsApp не доставили → SMS', async () => {
  const { otp, senders } = setup({ wa: true, sms: true, tgFails: true, waFails: true });
  const sent = await otp.send({ ...base, channel: 'telegram' });
  assert.equal(sent.channel, 'sms');
  assert.deepEqual(sent.channels, ['telegram', 'whatsapp', 'sms']);
  assert.equal(senders.sms.calls.length, 1);
});

test('SMS: не больше smsPerPhoneDay в сутки на номер — дальше SMS не предлагается и не шлётся', async () => {
  const { otp, prisma, senders } = setup({ sms: true });
  for (let i = 0; i < OTP.smsPerPhoneDay; i++) {
    if (i) age(prisma.rows, 3600); // за пределами часового лимита, но в тех же сутках
    assert.equal((await otp.send({ ...base, channel: 'sms' })).channel, 'sms');
  }
  age(prisma.rows, 3600);
  const sent = await otp.send({ ...base, channel: 'sms' });
  assert.equal(sent.channel, 'telegram');
  assert.deepEqual(sent.channels, ['telegram']);
  assert.equal(senders.sms.calls.length, OTP.smsPerPhoneDay);
});

test('SMS: не больше smsPerIpHour в час с одного адреса (разные номера — накрутка)', async () => {
  const { otp } = setup({ sms: true });
  for (let i = 0; i < OTP.smsPerIpHour; i++) {
    assert.equal((await otp.send({ ...base, phone: `+3749100000${i}`, channel: 'sms' })).channel, 'sms');
  }
  const sent = await otp.send({ ...base, phone: '+37491000099', channel: 'sms' });
  assert.equal(sent.channel, 'telegram');
});

test('SMS выключен — запрос channel=sms уходит в Telegram', async () => {
  const { otp, senders } = setup({});
  const sent = await otp.send({ ...base, channel: 'sms' });
  assert.equal(sent.channel, 'telegram');
  assert.equal(senders.sms.calls.length, 0);
});

// ─────────── вход проверяющих магазинов (REVIEW_LOGIN_PHONES + REVIEW_LOGIN_CODE) ───────────

const { env } = await import('../../common/config/env.js');
const REVIEW_PHONE = '+37400000101';

function withReview(phones: string[], code: string | undefined, fn: () => Promise<void>) {
  return async () => {
    const before = { phones: env.REVIEW_LOGIN_PHONES, code: env.REVIEW_LOGIN_CODE };
    env.REVIEW_LOGIN_PHONES = phones;
    env.REVIEW_LOGIN_CODE = code;
    try {
      await fn();
    } finally {
      env.REVIEW_LOGIN_PHONES = before.phones;
      env.REVIEW_LOGIN_CODE = before.code;
    }
  };
}

test('вход проверяющих: env пустой — обычный случайный код, сообщение уходит', withReview([], undefined, async () => {
  const { otp, senders, prisma } = setup({});
  const sent = await otp.send({ ...base, phone: REVIEW_PHONE, channel: 'telegram' });
  assert.equal(sent.channel, 'telegram');
  assert.equal(senders.telegram.calls.length, 1);
  assert.equal(prisma.rows[0]!.channel, 'telegram');
}));

test('вход проверяющих: задан только номер без кода — выключено', withReview([REVIEW_PHONE], undefined, async () => {
  const { otp, senders } = setup({});
  await otp.send({ ...base, phone: REVIEW_PHONE, channel: 'telegram' });
  assert.equal(senders.telegram.calls.length, 1);
}));

test('вход проверяющих: номер из списка — постоянный код, ничего не отправлено, вход проходит', withReview([REVIEW_PHONE], '4821', async () => {
  const { otp, senders, prisma } = setup({});
  const sent = await otp.send({ ...base, phone: REVIEW_PHONE, channel: 'telegram' });
  assert.equal(sent.channel, 'telegram');
  assert.deepEqual(sent.channels, ['telegram']);
  assert.equal(senders.telegram.calls.length, 0);
  assert.equal(prisma.rows.length, 1);
  assert.equal(prisma.rows[0]!.channel, 'review');
  const ok = await otp.verify({ phone: REVIEW_PHONE, purpose: 'login' }, '4821');
  assert.equal(ok.id, sent.challengeId);
}));

test('вход проверяющих: неверный код отклоняется, попытки считаются', withReview([REVIEW_PHONE], '4821', async () => {
  const { otp } = setup({});
  await otp.send({ ...base, phone: REVIEW_PHONE, channel: 'telegram' });
  await apiError(otp.verify({ phone: REVIEW_PHONE, purpose: 'login' }, '0000'), 'wrong_code');
  for (let i = 2; i < OTP.maxAttempts; i++) await apiError(otp.verify({ phone: REVIEW_PHONE, purpose: 'login' }, '0000'), 'wrong_code');
  await apiError(otp.verify({ phone: REVIEW_PHONE, purpose: 'login' }, '0000'), 'code_attempts');
  await apiError(otp.verify({ phone: REVIEW_PHONE, purpose: 'login' }, '4821'), 'code_attempts');
}));

test('вход проверяющих: чужой номер с этим кодом — обычный код и wrong_code', withReview([REVIEW_PHONE], '4821', async () => {
  const { otp, senders } = setup({});
  await otp.send({ ...base, channel: 'telegram' });
  assert.equal(senders.telegram.calls.length, 1);
  const real = senders.telegram.calls[0]!;
  if (real !== '4821') await apiError(otp.verify({ phone: base.phone, purpose: 'login' }, '4821'), 'wrong_code');
}));

test('вход проверяющих: лимиты те же — 60 с между кодами и часовой лимит', withReview([REVIEW_PHONE], '4821', async () => {
  const { otp, prisma } = setup({});
  const p = { ...base, phone: REVIEW_PHONE, channel: 'telegram' as const };
  await otp.send(p);
  await apiError(otp.send(p), 'code_resend_wait');
  for (let i = 1; i < OTP.perPhoneHour; i++) {
    age(prisma.rows, OTP.resendSec);
    await otp.send(p);
  }
  age(prisma.rows, OTP.resendSec);
  await apiError(otp.send(p), 'rate_limited');
}));
