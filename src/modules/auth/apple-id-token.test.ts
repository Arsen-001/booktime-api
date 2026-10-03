/** Проверка Apple identity token: подпись по JWKS, aud, iss, срок, почта может отсутствовать (ключи — свои, сеть не нужна). Запуск: npm test */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AppleIdTokenVerifier } = await import('./apple-id-token.js');
const { ApiError } = await import('../../common/errors/api-error.js');

const APP_CLIENT = 'am.booktime.app';
const APP_BUSINESS = 'am.booktime.business';
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

const apple = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function makeToken(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'A1' });
  const body = b64({
    iss: 'https://appleid.apple.com',
    aud: APP_CLIENT,
    sub: '001234.abcdef0123456789abcdef0123456789.1200',
    email: 'anna@icloud.com',
    email_verified: 'true',
    is_private_email: 'false',
    auth_time: Math.floor(NOW / 1000) - 10,
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 600,
    ...claims,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? apple.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function verifier(clientIds = [APP_CLIENT, APP_BUSINESS], fail = false) {
  let fetches = 0;
  const v = new AppleIdTokenVerifier({
    clientIds,
    now: () => NOW,
    fetchJwks: async () => {
      fetches++;
      if (fail) throw new Error('network down');
      return { keys: [{ ...apple.publicKey.export({ format: 'jwk' }), kid: 'A1', alg: 'RS256', use: 'sig' }] };
    },
  });
  return { v, fetches: () => fetches };
}

async function rejects(p: Promise<unknown>, code: string, reason?: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code && (!reason || reason.test(e.message)));
}

test('верный токен → sub, почта и client_id (aud); имени в токене нет', async () => {
  const { v } = verifier();
  assert.deepEqual(await v.verify(makeToken({})), {
    sub: '001234.abcdef0123456789abcdef0123456789.1200',
    email: 'anna@icloud.com',
    name: null,
    clientId: APP_CLIENT,
  });
});

test('aud — любой из APPLE_CLIENT_IDS (приложение бизнеса)', async () => {
  const { v } = verifier();
  assert.equal((await v.verify(makeToken({ aud: APP_BUSINESS }))).email, 'anna@icloud.com');
});

test('без почты → email null; private relay — как есть; email_verified=true булевым тоже годится', async () => {
  const { v } = verifier();
  assert.equal((await v.verify(makeToken({ email: undefined, email_verified: undefined }))).email, null);
  assert.equal((await v.verify(makeToken({ email: 'x1y2@privaterelay.appleid.com', is_private_email: 'true' }))).email, 'x1y2@privaterelay.appleid.com');
  assert.equal((await v.verify(makeToken({ email_verified: true }))).email, 'anna@icloud.com');
  assert.equal((await v.verify(makeToken({ email_verified: 'false' }))).email, null, 'неподтверждённую почту не берём');
});

test('подделанная подпись (чужой ключ с тем же kid) → apple_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({}, { key: attacker.privateKey })), 'apple_invalid', /signature/);
});

test('alg none / HS256 → apple_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({}, { alg: 'none' })), 'apple_invalid', /alg/);
  await rejects(v.verify(makeToken({}, { alg: 'HS256' })), 'apple_invalid', /alg/);
});

test('чужой aud → apple_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ aud: 'com.evil.app' })), 'apple_invalid', /audience/);
});

test('чужой iss (в т.ч. Google) → apple_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ iss: 'https://accounts.google.com' })), 'apple_invalid', /issuer/);
  await rejects(v.verify(makeToken({ iss: 'appleid.apple.com' })), 'apple_invalid', /issuer/);
});

test('просроченный (дольше запаса 60 с) → apple_invalid; в пределах запаса — проходит; iat из будущего — нет', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ exp: Math.floor(NOW / 1000) - 120 })), 'apple_invalid', /expired/);
  assert.ok(await v.verify(makeToken({ exp: Math.floor(NOW / 1000) - 30 })));
  await rejects(v.verify(makeToken({ iat: Math.floor(NOW / 1000) + 600 })), 'apple_invalid', /future/);
});

test('без sub → apple_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ sub: undefined })), 'apple_invalid', /subject/);
});

test('мусор вместо токена → apple_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify('not-a-jwt'), 'apple_invalid');
  await rejects(v.verify('a.b.c'), 'apple_invalid');
});

test('незнакомый kid → ключи перечитываются не чаще раза в минуту', async () => {
  const { v, fetches } = verifier();
  await v.verify(makeToken({}));
  await rejects(v.verify(makeToken({}, { kid: 'B2' })), 'apple_invalid', /unknown signing key/);
  await v.verify(makeToken({}));
  assert.equal(fetches(), 1);
});

test('ключи Apple недоступны → apple_unavailable', async () => {
  const { v } = verifier(undefined, true);
  await rejects(v.verify(makeToken({})), 'apple_unavailable');
});

test('нет APPLE_CLIENT_IDS → apple_disabled', async () => {
  const { v } = verifier([]);
  assert.equal(v.enabled, false);
  await rejects(v.verify(makeToken({})), 'apple_disabled');
});
