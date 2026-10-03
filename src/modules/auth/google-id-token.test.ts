/** Проверка Google ID token: подпись по JWKS, aud, iss, срок, email_verified (ключи — свои, сеть не нужна). Запуск: npm test */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { GoogleIdTokenVerifier } = await import('./google-id-token.js');
const { ApiError } = await import('../../common/errors/api-error.js');

const CLIENT_WEB = 'web-123.apps.googleusercontent.com';
const CLIENT_ANDROID = 'android-456.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function keyPair() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}
const google = keyPair();
const attacker = keyPair();

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function makeToken(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_WEB,
    sub: '1098765432101234567890',
    email: 'anna@gmail.com',
    email_verified: true,
    name: 'Анна Петросян',
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 3600,
    ...claims,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? google.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function verifier(clientIds = [CLIENT_WEB, CLIENT_ANDROID]) {
  let fetches = 0;
  const v = new GoogleIdTokenVerifier({
    clientIds,
    now: () => NOW,
    fetchJwks: async () => {
      fetches++;
      return { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }], maxAgeSec: 3600 };
    },
  });
  return { v, fetches: () => fetches };
}

async function rejects(p: Promise<unknown>, code: string, reason?: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code && (!reason || reason.test(e.message)));
}

test('верный токен → sub, почта, имя', async () => {
  const { v } = verifier();
  const p = await v.verify(makeToken({}));
  assert.deepEqual(p, { sub: '1098765432101234567890', email: 'anna@gmail.com', name: 'Анна Петросян' });
});

test('aud — любой из наших Client ID (web, android)', async () => {
  const { v } = verifier();
  assert.equal((await v.verify(makeToken({ aud: CLIENT_ANDROID }))).email, 'anna@gmail.com');
});

test('подделанная подпись (чужой ключ с тем же kid) → google_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({}, { key: attacker.privateKey })), 'google_invalid', /signature/);
});

test('изменённое тело при старой подписи → google_invalid', async () => {
  const { v } = verifier();
  const [h, , s] = makeToken({}).split('.');
  const forged = `${h}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_WEB, sub: 'victim', email: 'x@gmail.com', email_verified: true, exp: NOW / 1000 + 60 })}.${s}`;
  await rejects(v.verify(forged), 'google_invalid', /signature/);
});

test('alg none / HS256 → google_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({}, { alg: 'none' })), 'google_invalid', /alg/);
  await rejects(v.verify(makeToken({}, { alg: 'HS256' })), 'google_invalid', /alg/);
});

test('чужой aud (токен для другого сайта) → google_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ aud: 'evil.apps.googleusercontent.com' })), 'google_invalid', /audience/);
});

test('чужой iss → google_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ iss: 'https://evil.example' })), 'google_invalid', /issuer/);
});

test('просроченный (дольше запаса 60 с) → google_invalid; в пределах запаса — проходит', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ exp: Math.floor(NOW / 1000) - 120 })), 'google_invalid', /expired/);
  assert.ok(await v.verify(makeToken({ exp: Math.floor(NOW / 1000) - 30 })));
});

test('почта не подтверждена → google_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify(makeToken({ email_verified: false })), 'google_invalid', /email not verified/);
  await rejects(v.verify(makeToken({ email_verified: undefined })), 'google_invalid', /email not verified/);
});

test('мусор вместо токена → google_invalid', async () => {
  const { v } = verifier();
  await rejects(v.verify('not-a-jwt'), 'google_invalid');
  await rejects(v.verify('a.b.c'), 'google_invalid');
});

test('незнакомый kid → ключи перечитываются не чаще раза в минуту', async () => {
  const { v, fetches } = verifier();
  await v.verify(makeToken({}));
  assert.equal(fetches(), 1);
  await rejects(v.verify(makeToken({}, { kid: 'k2' })), 'google_invalid', /unknown signing key/);
  assert.equal(fetches(), 1, 'только что читали — повторно не идём');
  await v.verify(makeToken({}));
  assert.equal(fetches(), 1, 'ключи из кэша');
});

test('нет GOOGLE_CLIENT_ID → google_disabled', async () => {
  const { v } = verifier([]);
  assert.equal(v.enabled, false);
  await rejects(v.verify(makeToken({})), 'google_disabled');
});
