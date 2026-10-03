/**
 * «Войти через Apple» (AuthService): непривязанный Apple → pendingApple → номер и код → привязка и вход; дальше — вход
 * одним нажатием; чужой номер Apple-входом не занять; почты может не быть. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AuthService } = await import('./auth.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');
const { memoryDb } = await import('./login-fixtures.test.js');
type Row = import('./login-fixtures.test.js').Row;
type AppleProfile = import('./apple-id-token.js').AppleProfile;
type GoogleProfile = import('./google-id-token.js').GoogleProfile;
type PendingLinkStore<P> = import('./pending-link.js').PendingLinkStore<P>;
type RequestContext = import('../../common/http/context.js').RequestContext;

const CODE = '1234';
const PHONE = '+37491123456';
const ANNA: AppleProfile = { sub: 'a-anna', email: 'anna@icloud.com', name: null, clientId: 'am.booktime.app' };
const HIDDEN: AppleProfile = { sub: 'a-hidden', email: null, name: null };

function memoryPending<P>(prefix: string): PendingLinkStore<P> {
  const rows = new Map<string, P>();
  let n = 0;
  return {
    put: async (p) => {
      const token = `${prefix}-token-${String(++n).padStart(8, '0')}`;
      rows.set(token, p);
      return token;
    },
    take: async (t) => {
      const p = rows.get(t) ?? null;
      rows.delete(t);
      return p;
    },
  };
}

function setup(tokenClient?: { exchangeCode: (code: string, clientId: string) => Promise<{ refreshTokenEnc: string; clientId: string } | null> }) {
  const db = memoryDb();
  // Проверка самого токена — в apple-id-token.test.ts; здесь identityToken — имя профиля
  const appleTokens: Record<string, AppleProfile> = { anna: ANNA, hidden: HIDDEN };
  const apple = {
    enabled: true,
    verify: async (t: string) => {
      const p = appleTokens[t];
      if (!p) throw new ApiError('apple_invalid', 'Apple sign-in failed: bad signature');
      return p;
    },
  };
  const googleTokens: Record<string, GoogleProfile> = { anna: { sub: 'g-anna', email: 'anna@gmail.com', name: 'Анна G' } };
  const google = { enabled: true, verify: async (t: string) => googleTokens[t]! };
  const otp = {
    verify: async (_where: unknown, code: string) => {
      if (code !== CODE) throw new ApiError('wrong_code', 'Wrong code');
      return { subjectId: null };
    },
  };
  const sessionStore = {
    open: async (_ctx: unknown, _res: unknown, input: Row) => {
      const id = `ses_${db.sessions.length + 1}`;
      db.sessions.push({ mode: 'client', activeBusinessId: null, mustChangePassword: false, ...input, id });
      return id;
    },
  };
  const auditService = { record: async (_tx: unknown, _ctx: unknown, input: Row) => void db.audit.push(input) };
  const memberships = { list: async () => [] };
  const auth = new AuthService(
    db as never,
    otp as never,
    sessionStore as never,
    auditService as never,
    memberships as never,
    google as never,
    memoryPending<GoogleProfile>('g'),
    apple as never,
    memoryPending<AppleProfile>('a'),
    tokenClient as never,
  );
  const ctx = { ip: '10.0.0.1', device: 'test', session: null, member: null } as unknown as RequestContext;
  return { db, auth, ctx, res: {} as never };
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code);
}

test('Apple не привязан → pendingApple (почта, имя из первого ответа Apple), сессии нет, человек не заведён', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true, name: '  Анна Петросян ' });
  assert.equal(r.session, null);
  assert.equal(r.pendingApple?.email, 'anna@icloud.com');
  assert.equal(r.pendingApple?.name, 'Анна Петросян');
  assert.equal(r.pendingApple?.expiresIn, 600);
  assert.equal(db.sessions.length, 0);
  assert.equal(db.users.length, 0);
  const ev = db.events.at(-1)!;
  assert.equal(ev.method, 'apple');
  assert.equal(ev.result, 'apple_unlinked');
  assert.equal(ev.identifier, 'a•••@icloud.com');
});

test('неверный токен → apple_invalid и запись в журнале входов', async () => {
  const { auth, ctx, res, db } = setup();
  await rejects(auth.appleLogin(ctx, res, { identityToken: 'forged', app: 'client' }), 'apple_invalid');
  assert.equal(db.events.at(-1)?.result, 'apple_invalid');
  assert.equal(db.sessions.length, 0);
});

test('номер + код с pendingApple → человек с этим номером (имя из Apple), Apple привязан, вход', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true, name: 'Анна' });
  const view = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: r.pendingApple!.token });
  assert.equal(view.appleLinked, true);
  assert.equal(view.googleLinked, undefined);
  assert.equal(view.user.phone, PHONE);
  assert.equal(view.user.name, 'Анна');
  assert.equal(db.identities.length, 1);
  assert.deepEqual([db.identities[0]!.provider, db.identities[0]!.subject, db.identities[0]!.email], ['apple', 'a-anna', 'anna@icloud.com']);
  assert.ok(db.events.some((e) => e.method === 'apple' && e.result === 'apple_linked'));
  assert.ok(db.audit.some((a) => a.action === 'appleLinked'));
});

test('повторный вход через Apple — сразу сессия, без кода; тот же человек и в кабинете бизнеса', async () => {
  const { auth, ctx, res, db } = setup();
  const first = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true });
  const linked = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: first.pendingApple!.token });
  const again = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client' });
  assert.equal(again.pendingApple, null);
  assert.equal(again.session?.user.id, linked.user.id);
  assert.equal(db.events.filter((e) => e.method === 'apple' && e.result === 'ok').length, 1);
  const biz = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'business' });
  assert.equal(biz.session?.user.id, linked.user.id);
  assert.equal(db.sessions.at(-1)!.app, 'business');
});

test('Apple без почты: pendingApple с email null, привязка, имя — номер, если не ввели', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.appleLogin(ctx, res, { identityToken: 'hidden', app: 'client', consent: true });
  assert.equal(r.pendingApple?.email, null);
  assert.equal(r.pendingApple?.name, null);
  assert.equal(db.events.at(-1)?.identifier, null);
  const view = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: r.pendingApple!.token });
  assert.equal(view.appleLinked, true);
  assert.equal(view.user.name, PHONE);
  assert.equal(db.identities[0]!.email, null);
  assert.ok((await auth.appleLogin(ctx, res, { identityToken: 'hidden', app: 'client' })).session);
});

test('чужой номер не занять: Apple уже у Анны → apple_taken, Apple-вход по-прежнему ведёт к Анне', async () => {
  const { auth, ctx, res, db } = setup();
  const a = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true });
  const b = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true });
  const anna = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: a.pendingApple!.token });
  const bob = await auth.verifyCode(ctx, res, { phone: '+37499000000', code: CODE, app: 'client', consent: true, name: 'Боб', pendingApple: b.pendingApple!.token });
  assert.equal(bob.appleLinked, false);
  assert.equal(db.identities.length, 1);
  assert.equal(db.identities[0]!.userId, anna.user.id);
  assert.ok(db.events.some((e) => e.method === 'apple' && e.result === 'apple_taken'));
  assert.equal((await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client' })).session?.user.id, anna.user.id);
});

test('погашенный или выдуманный pendingApple → вход по коду идёт, appleLinked false, apple_expired', async () => {
  const { auth, ctx, res, db } = setup();
  const view = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, name: 'Анна', pendingApple: 'no-such-token-0000000' });
  assert.equal(view.appleLinked, false);
  assert.equal(db.identities.length, 0);
  assert.ok(db.events.some((e) => e.result === 'apple_expired'));
});

test('пришли оба токена (Google и Apple) — привязываются оба', async () => {
  const { auth, ctx, res, db } = setup();
  const g = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const a = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true, name: 'Анна A' });
  const view = await auth.verifyCode(ctx, res, {
    phone: PHONE,
    code: CODE,
    app: 'client',
    consent: true,
    pendingGoogle: g.pendingGoogle!.token,
    pendingApple: a.pendingApple!.token,
  });
  assert.equal(view.googleLinked, true);
  assert.equal(view.appleLinked, true);
  assert.equal(view.user.name, 'Анна G', 'имя: введённое → Google → Apple → номер');
  assert.deepEqual(db.identities.map((i) => i.provider).sort(), ['apple', 'google']);
});

test('заблокированный человек через Apple не входит', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true });
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: r.pendingApple!.token });
  db.users[0]!.blockedAt = new Date();
  await rejects(auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client' }), 'account_blocked');
  assert.equal(db.events.at(-1)?.result, 'blocked');
});

test('клиент без принятого соглашения (привязал Apple в кабинете бизнеса) — нужен consent', async () => {
  const { auth, ctx, res } = setup();
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'business' });
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'business', pendingApple: r.pendingApple!.token });
  await rejects(auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client' }), 'consent_required');
  assert.equal((await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true })).session?.consent, true);
});

// ─────────── authorizationCode → refresh token (04.10.2026, отзыв при удалении аккаунта) ───────────

function tokenStub(fail = false) {
  const calls: [string, string][] = [];
  return {
    calls,
    exchangeCode: async (code: string, clientId: string) => {
      calls.push([code, clientId]);
      return fail ? null : { refreshTokenEnc: `enc(${code})`, clientId };
    },
  };
}

test('authorizationCode при первом входе: обмен по client_id из токена, токен ждёт в pendingApple и ложится на привязку', async () => {
  const tokens = tokenStub();
  const { auth, ctx, res, db } = setup(tokens);
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true, authorizationCode: 'code-1' });
  assert.deepEqual(tokens.calls, [['code-1', 'am.booktime.app']]);
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: r.pendingApple!.token });
  assert.equal(db.identities[0]!.refreshTokenEnc, 'enc(code-1)');
  assert.equal(db.identities[0]!.tokenClientId, 'am.booktime.app');
});

test('authorizationCode при повторном входе обновляет сохранённый токен; без кода — токен не трогается', async () => {
  const tokens = tokenStub();
  const { auth, ctx, res, db } = setup(tokens);
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true });
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: r.pendingApple!.token });
  assert.equal(db.identities[0]!.refreshTokenEnc, undefined);
  assert.ok((await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', authorizationCode: 'code-2' })).session);
  assert.equal(db.identities[0]!.refreshTokenEnc, 'enc(code-2)');
  await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client' });
  assert.equal(db.identities[0]!.refreshTokenEnc, 'enc(code-2)');
  assert.equal(tokens.calls.length, 1);
});

test('обмен не удался (Apple недоступен, ключа нет) — вход всё равно идёт, токена нет', async () => {
  const { auth, ctx, res, db } = setup(tokenStub(true));
  const r = await auth.appleLogin(ctx, res, { identityToken: 'anna', app: 'client', consent: true, authorizationCode: 'code-x' });
  const view = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingApple: r.pendingApple!.token });
  assert.equal(view.appleLinked, true);
  assert.equal(db.identities[0]!.refreshTokenEnc, undefined);
});
