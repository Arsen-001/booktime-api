/**
 * «Войти через Google» (AuthService): непривязанный Google → pendingGoogle → номер и код → привязка и вход;
 * дальше — вход одним нажатием; чужой номер Google-входом не занять. База — в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AuthService } = await import('./auth.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');
type GoogleProfile = import('./google-id-token.js').GoogleProfile;
type GooglePendingStore = import('./google-pending.js').GooglePendingStore;
type RequestContext = import('../../common/http/context.js').RequestContext;
const { memoryDb } = await import('./login-fixtures.test.js');
type Row = import('./login-fixtures.test.js').Row;

const CODE = '1234';
const PHONE = '+37491123456';
const ANNA: GoogleProfile = { sub: 'g-anna', email: 'anna@gmail.com', name: 'Анна' };
const EVE: GoogleProfile = { sub: 'g-eve', email: 'eve@gmail.com', name: 'Ева' };

function setup() {
  const db = memoryDb();
  const pendingRows = new Map<string, GoogleProfile>();
  let n = 0;
  const pending: GooglePendingStore = {
    put: async (p) => {
      const token = `pending-token-${String(++n).padStart(8, '0')}`;
      pendingRows.set(token, p);
      return token;
    },
    take: async (t) => {
      const p = pendingRows.get(t) ?? null;
      pendingRows.delete(t);
      return p;
    },
  };
  // Проверка самого токена — в google-id-token.test.ts; здесь idToken — имя профиля
  const tokens: Record<string, GoogleProfile> = { anna: ANNA, eve: EVE };
  const google = {
    enabled: true,
    verify: async (idToken: string) => {
      const p = tokens[idToken];
      if (!p) throw new ApiError('google_invalid', 'Google sign-in failed: bad signature');
      return p;
    },
  };
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
  const auth = new AuthService(db as never, otp as never, sessionStore as never, auditService as never, memberships as never, google as never, pending, {} as never, {} as never);
  const ctx = { ip: '10.0.0.1', device: 'test', session: null, member: null } as unknown as RequestContext;
  return { db, auth, ctx, res: {} as never, pendingRows };
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ApiError && e.code === code);
}

test('Google не привязан → pendingGoogle, сессии нет, человек не заведён', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  assert.equal(r.session, null);
  assert.equal(r.pendingGoogle?.email, 'anna@gmail.com');
  assert.equal(r.pendingGoogle?.name, 'Анна');
  assert.equal(db.sessions.length, 0);
  assert.equal(db.users.length, 0);
  assert.equal(db.events.at(-1)?.result, 'google_unlinked');
});

test('неверный токен → google_invalid и запись в журнале входов', async () => {
  const { auth, ctx, res, db } = setup();
  await rejects(auth.googleLogin(ctx, res, { idToken: 'forged', app: 'client' }), 'google_invalid');
  assert.equal(db.events.at(-1)?.result, 'google_invalid');
  assert.equal(db.sessions.length, 0);
});

test('номер + код с pendingGoogle → человек с этим номером, Google привязан, вход', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const view = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingGoogle: r.pendingGoogle!.token });
  assert.equal(view.googleLinked, true);
  assert.equal(view.user.phone, PHONE);
  assert.equal(view.user.name, 'Анна', 'имя из Google, если не ввели');
  assert.equal(db.identities.length, 1);
  assert.equal(db.identities[0]!.userId, view.user.id);
  assert.equal(db.identities[0]!.subject, 'g-anna');
  assert.ok(db.events.some((e) => e.method === 'google' && e.result === 'google_linked'));
});

test('повторный вход через Google — сразу сессия, без кода', async () => {
  const { auth, ctx, res, db } = setup();
  const first = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const linked = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingGoogle: first.pendingGoogle!.token });
  const again = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client' });
  assert.equal(again.pendingGoogle, null);
  assert.equal(again.session?.user.id, linked.user.id);
  assert.equal(db.sessions.length, 2);
  assert.equal(db.sessions.at(-1)!.userId, linked.user.id);
  const ok = db.events.filter((e) => e.method === 'google' && e.result === 'ok');
  assert.equal(ok.length, 1);
  // Тот же Google входит и в кабинет бизнеса — человек тот же
  const biz = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'business' });
  assert.equal(biz.session?.user.id, linked.user.id);
  assert.equal(db.sessions.at(-1)!.app, 'business');
});

test('неверный код не тратит pendingGoogle; верный — гасит его (второй раз не привяжет)', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const token = r.pendingGoogle!.token;
  await rejects(auth.verifyCode(ctx, res, { phone: PHONE, code: '0000', app: 'client', consent: true, pendingGoogle: token }), 'wrong_code');
  assert.equal(db.identities.length, 0);
  const ok = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingGoogle: token });
  assert.equal(ok.googleLinked, true);
  // Тот же токен к другому номеру — уже погашен: вход по коду есть, привязки нет
  const other = await auth.verifyCode(ctx, res, { phone: '+37499000000', code: CODE, app: 'client', consent: true, name: 'Ева', pendingGoogle: token });
  assert.equal(other.googleLinked, false);
  assert.equal(db.identities.length, 1);
  assert.equal(db.identities[0]!.userId, ok.user.id);
});

test('чужой номер не занять: Google уже у Анны — привязать его к другому номеру нельзя', async () => {
  const { auth, ctx, res, db } = setup();
  // Два ожидания одного Google (две вкладки) — первое привязывает к номеру Анны
  const a = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const b = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const anna = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingGoogle: a.pendingGoogle!.token });
  const bob = await auth.verifyCode(ctx, res, { phone: '+37499000000', code: CODE, app: 'client', consent: true, name: 'Боб', pendingGoogle: b.pendingGoogle!.token });
  assert.equal(bob.googleLinked, false);
  assert.equal(db.identities.length, 1);
  assert.equal(db.identities[0]!.userId, anna.user.id);
  assert.ok(db.events.some((e) => e.result === 'google_taken'));
  // А Google-вход по-прежнему ведёт к Анне
  assert.equal((await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client' })).session?.user.id, anna.user.id);
});

test('Google существующего человека: привязка к уже заведённому номеру, без нового аккаунта', async () => {
  const { auth, ctx, res, db } = setup();
  const before = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, name: 'Анна' });
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  const after = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', pendingGoogle: r.pendingGoogle!.token });
  assert.equal(after.user.id, before.user.id);
  assert.equal(db.users.length, 1);
  assert.equal(after.googleLinked, true);
});

test('заблокированный человек через Google не входит', async () => {
  const { auth, ctx, res, db } = setup();
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingGoogle: r.pendingGoogle!.token });
  db.users[0]!.blockedAt = new Date();
  await rejects(auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client' }), 'account_blocked');
});

test('клиент без принятого соглашения (привязал Google в кабинете бизнеса) — нужен consent', async () => {
  const { auth, ctx, res } = setup();
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'business' });
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'business', pendingGoogle: r.pendingGoogle!.token });
  await rejects(auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client' }), 'consent_required');
  const ok = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  assert.equal(ok.session?.consent, true);
});

test('профиль: привязать, заменить другим Google, отвязать', async () => {
  const { auth, ctx, res, db } = setup();
  const me = await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, name: 'Анна' });
  const authed = { ...ctx, session: { sessionId: 'ses_1', userId: me.user.id, app: 'client', staffLoginId: null, platformMemberId: null } } as unknown as RequestContext;
  assert.deepEqual(await auth.googleStatus(authed), { enabled: true, email: null });
  assert.equal((await auth.linkGoogle(authed, { idToken: 'anna' })).email, 'anna@gmail.com');
  assert.equal((await auth.linkGoogle(authed, { idToken: 'eve' })).email, 'eve@gmail.com');
  assert.equal(db.identities.length, 1, 'один Google на человека');
  assert.deepEqual(await auth.unlinkGoogle(authed), { enabled: true, email: null });
  assert.equal(db.identities.length, 0);
});

test('профиль: Google, привязанный к другому человеку, не перехватить', async () => {
  const { auth, ctx, res } = setup();
  const r = await auth.googleLogin(ctx, res, { idToken: 'anna', app: 'client', consent: true });
  await auth.verifyCode(ctx, res, { phone: PHONE, code: CODE, app: 'client', consent: true, pendingGoogle: r.pendingGoogle!.token });
  const bob = await auth.verifyCode(ctx, res, { phone: '+37499000000', code: CODE, app: 'client', consent: true, name: 'Боб' });
  const authed = { ...ctx, session: { sessionId: 'ses_2', userId: bob.user.id, app: 'client', staffLoginId: null, platformMemberId: null } } as unknown as RequestContext;
  await rejects(auth.linkGoogle(authed, { idToken: 'anna' }), 'google_taken');
});
