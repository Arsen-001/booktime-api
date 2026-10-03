/**
 * Отзыв «Войти через Apple» при удалении аккаунта (04.10.2026): client_secret ES256, обмен authorizationCode на
 * зашифрованный refresh token, отзыв, пропуск без ключей, удаление аккаунта не зависит от Apple. fetch подменён.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AppleTokenClient, appleClientSecret, appleKeyConfig, APPLE_TOKEN_URL, APPLE_REVOKE_URL } = await import('./apple-tokens.js');
const { SecretBox } = await import('../../common/crypto/secret-box.js');
const { authHousekeeping } = await import('../../jobs/auth-housekeeping.js');

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const box = new SecretBox(Buffer.alloc(32, 7));

type Call = { url: string; form: URLSearchParams };
function fakeFetch(respond: (c: Call) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const c = { url, form: new URLSearchParams(String(init.body)) };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('SecretBox: туда-обратно; чужой ключ и порча — null; ключ из base64/hex/строки', () => {
  const sealed = box.seal('r.token-1');
  assert.match(sealed, /^v1\./);
  assert.notEqual(box.seal('r.token-1'), sealed, 'случайный iv');
  assert.equal(box.open(sealed), 'r.token-1');
  assert.equal(new SecretBox(Buffer.alloc(32, 8)).open(sealed), null);
  assert.equal(box.open(sealed.slice(0, -2) + 'AA'), null);
  assert.equal(SecretBox.fromEnv(''), null);
  const b64 = Buffer.alloc(32, 7).toString('base64');
  assert.equal(SecretBox.fromEnv(b64)!.open(sealed), 'r.token-1');
  assert.equal(SecretBox.fromEnv(Buffer.alloc(32, 7).toString('hex'))!.open(sealed), 'r.token-1');
  assert.ok(SecretBox.fromEnv('any passphrase'));
});

test('client_secret: ES256 JWT (iss — Team ID, sub — client_id, aud — appleid), подпись проверяется открытым ключом', () => {
  const jwt = appleClientSecret(KEY, 'am.booktime.app', NOW);
  const [h, p, s] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.sub, 'am.booktime.app');
  assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.equal(claims.exp - claims.iat, 600);
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('appleKeyConfig: все три переменные — конфиг, иначе null', () => {
  assert.equal(appleKeyConfig({}), null);
  assert.equal(appleKeyConfig({ APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K' }), null);
  assert.deepEqual(appleKeyConfig({ APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K', APPLE_PRIVATE_KEY: 'P' }), { teamId: 'T', keyId: 'K', privateKey: 'P' });
});

test('обмен кода: POST /auth/token с client_secret, refresh token сохраняется зашифрованным', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { access_token: 'a', refresh_token: 'r.secret-refresh', id_token: 'x' } }));
  const client = new AppleTokenClient({ key: KEY, box, fetch: f.fn, now: () => NOW });
  const stored = await client.exchangeCode('c.auth-code', 'am.booktime.business');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, APPLE_TOKEN_URL);
  assert.equal(f.calls[0]!.form.get('grant_type'), 'authorization_code');
  assert.equal(f.calls[0]!.form.get('code'), 'c.auth-code');
  assert.equal(f.calls[0]!.form.get('client_id'), 'am.booktime.business');
  assert.equal(f.calls[0]!.form.get('client_secret')!.split('.').length, 3);
  assert.equal(stored!.clientId, 'am.booktime.business');
  assert.ok(!stored!.refreshTokenEnc.includes('secret-refresh'), 'в базу — только шифртекст');
  assert.equal(box.open(stored!.refreshTokenEnc), 'r.secret-refresh');
});

test('обмен кода: Apple ответил ошибкой или недоступен — null, без исключения', async () => {
  const bad = new AppleTokenClient({ key: KEY, box, fetch: fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } })).fn });
  assert.equal(await bad.exchangeCode('old', 'am.booktime.app'), null);
  const down = new AppleTokenClient({ key: KEY, box, fetch: fakeFetch(() => new Error('ECONNRESET')).fn });
  assert.equal(await down.exchangeCode('c', 'am.booktime.app'), null);
});

test('нет ключа Apple или SECRETS_KEY — обмен и отзыв пропускаются, в Apple не ходим', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  for (const client of [new AppleTokenClient({ key: null, box, fetch: f.fn }), new AppleTokenClient({ key: KEY, box: null, fetch: f.fn })]) {
    assert.equal(client.enabled, false);
    assert.equal(await client.exchangeCode('c', 'am.booktime.app'), null);
    assert.equal(await client.revoke({ refreshTokenEnc: box.seal('r'), clientId: 'am.booktime.app' }), 'skipped');
  }
  assert.equal(f.calls.length, 0);
});

test('отзыв: POST /auth/revoke с расшифрованным токеном; ошибка Apple — исключение (очередь повторит); чужой шифртекст — skipped', async () => {
  const f = fakeFetch((c) => ({ status: c.form.get('token') === 'r.fail' ? 503 : 200 }));
  const client = new AppleTokenClient({ key: KEY, box, fetch: f.fn, now: () => NOW });
  assert.equal(await client.revoke({ refreshTokenEnc: box.seal('r.ok'), clientId: 'am.booktime.app' }), 'revoked');
  assert.equal(f.calls[0]!.url, APPLE_REVOKE_URL);
  assert.equal(f.calls[0]!.form.get('token'), 'r.ok');
  assert.equal(f.calls[0]!.form.get('token_type_hint'), 'refresh_token');
  assert.equal(f.calls[0]!.form.get('client_id'), 'am.booktime.app');
  await assert.rejects(client.revoke({ refreshTokenEnc: box.seal('r.fail'), clientId: 'am.booktime.app' }), /503/);
  assert.equal(await client.revoke({ refreshTokenEnc: new SecretBox(Buffer.alloc(32, 1)).seal('x'), clientId: 'am.booktime.app' }), 'skipped');
});

// ─────────── удаление аккаунта (jobs/auth-housekeeping.ts) ───────────

function housekeepingDb() {
  const users = [{ id: 'au_1', deletedAt: null as Date | null }, { id: 'au_2', deletedAt: null as Date | null }];
  const identities = [
    { userId: 'au_1', provider: 'apple', refreshTokenEnc: 'enc-1', tokenClientId: 'am.booktime.app' },
    { userId: 'au_1', provider: 'google', refreshTokenEnc: null, tokenClientId: null },
    { userId: 'au_2', provider: 'apple', refreshTokenEnc: null, tokenClientId: null },
  ];
  const count = async () => ({ count: 0 });
  // Любая модель транзакции: updateMany/deleteMany/create — пустой ответ; user.update и userIdentity.deleteMany — по-настоящему
  const tx = new Proxy({} as Record<string, unknown>, {
    get: (_t, model: string) => {
      if (model === 'user') return { update: async ({ where }: { where: { id: string } }) => Object.assign(users.find((u) => u.id === where.id)!, { deletedAt: new Date() }) };
      if (model === 'userIdentity')
        return {
          deleteMany: async ({ where }: { where: { userId: string } }) => {
            for (let i = identities.length - 1; i >= 0; i--) if (identities[i]!.userId === where.userId) identities.splice(i, 1);
            return { count: 1 };
          },
        };
      if (model === 'webhook') return { findUnique: async () => null };
      return { updateMany: count, deleteMany: count, create: async () => ({}) };
    },
  });
  const db = {
    users,
    identities,
    otpRequest: { deleteMany: count },
    loginEvent: { deleteMany: count },
    session: { deleteMany: count },
    user: { findMany: async () => users.filter((u) => !u.deletedAt).map((u) => ({ id: u.id })) },
    userIdentity: {
      findMany: async ({ where }: { where: { userId: string; provider: string } }) =>
        identities.filter((i) => i.userId === where.userId && i.provider === where.provider && i.refreshTokenEnc !== null),
    },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return db;
}

test('удаление аккаунта: токен Apple читается до стирания и уходит на отзыв; без токена — ничего', async () => {
  const db = housekeepingDb();
  const revoked: unknown[] = [];
  const res = await authHousekeeping(db as never, { revokeApple: async (t) => void revoked.push(t) });
  assert.equal(res.accountsClosed, 2);
  assert.equal(res.appleRevokes, 1);
  assert.deepEqual(revoked, [{ userId: 'au_1', refreshTokenEnc: 'enc-1', clientId: 'am.booktime.app' }]);
  assert.equal(db.identities.length, 0, 'привязки стёрты');
  assert.ok(db.users.every((u) => u.deletedAt));
});

test('удаление аккаунта: отзыв упал — аккаунт всё равно удалён; обработчика нет — пропуск', async () => {
  const db = housekeepingDb();
  const res = await authHousekeeping(db as never, {
    revokeApple: async () => {
      throw new Error('redis down');
    },
  });
  assert.equal(res.accountsClosed, 2);
  assert.equal(res.appleRevokes, 0);
  assert.ok(db.users.every((u) => u.deletedAt));
  const db2 = housekeepingDb();
  assert.equal((await authHousekeeping(db2 as never)).accountsClosed, 2);
});
