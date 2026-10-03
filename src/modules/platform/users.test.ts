/**
 * Наша панель → «Пользователи»: фильтры → where, блокировка отзывает сессии и пишет журнал, права (только admin),
 * в карточке и списке нет секретов. База — в памяти (подмножество Prisma, которым пользуется сервис). Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { PlatformUsersService } = await import('./users.service.js');
const { AuditService } = await import('../../common/audit/audit.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');
const R = await import('./users.rules.js');
const { usersListQuery, userBlockBody } = await import('./users.schemas.js');
type RequestContext = import('../../common/http/context.js').RequestContext;

const NOW = new Date('2026-10-03T10:00:00Z');
const q = (over: Record<string, unknown> = {}) => usersListQuery.parse(over);

// ─────────── фильтры ───────────

test('фильтры: пусто → без условий; поиск по имени и цифрам номера', () => {
  assert.deepEqual(R.buildUserWhere(q(), { now: NOW }), {});
  const w = R.buildUserWhere(q({ q: 'Анна' }), { now: NOW });
  assert.deepEqual(w, { AND: [{ OR: [{ name: { contains: 'Анна' } }] }] });
  const p = R.buildUserWhere(q({ q: '091 12 34 56' }), { now: NOW });
  assert.deepEqual(p, { AND: [{ OR: [{ name: { contains: '091 12 34 56' } }, { phone: { contains: '91123456' } }] }] });
});

test('фильтры: роль клиента — без живых строк staff и сетей; «несколько» — готовое множество', () => {
  const c = R.buildUserWhere(q({ role: 'client' }), { now: NOW }) as { AND: unknown[] };
  assert.deepEqual(c.AND[0], { staff: { none: R.LIVE_STAFF }, networks: { none: { deletedAt: null } } });
  const m = R.buildUserWhere(q({ role: 'multiple' }), { now: NOW, multipleIds: ['u1', 'u2'] }) as { AND: unknown[] };
  assert.deepEqual(m.AND[0], { id: { in: ['u1', 'u2'] } });
  const a = R.buildUserWhere(q({ role: 'master' }), { now: NOW }) as { AND: unknown[] };
  assert.deepEqual(a.AND[0], { staff: { some: { ...R.LIVE_STAFF, role: 'master' } } });
});

test('фильтры: регистрация с–по (границы дня Еревана), активность, Telegram, Google, статус', () => {
  const w = R.buildUserWhere(q({ regFrom: '2026-10-01', regTo: '2026-10-02', activeDays: '7', telegram: 'yes', google: 'no', status: 'blocked' }), {
    now: NOW,
    telegram: { userIds: ['u1'], phones: ['+37491000000'] },
  }) as { AND: Record<string, unknown>[] };
  assert.deepEqual(w.AND[0], { createdAt: { gte: new Date('2026-09-30T20:00:00Z'), lt: new Date('2026-10-02T20:00:00Z') } });
  assert.deepEqual(w.AND[1], { sessions: { some: { lastSeenAt: { gte: new Date('2026-09-26T10:00:00Z') } } } });
  assert.deepEqual(w.AND[2], { OR: [{ id: { in: ['u1'] } }, { phone: { in: ['+37491000000'] } }] });
  assert.deepEqual(w.AND[3], { identities: { none: { provider: 'google' } } });
  assert.deepEqual(w.AND[4], { deletedAt: null, blockedAt: { not: null } });
  const off = R.buildUserWhere(q({ telegram: 'no' }), { now: NOW, telegram: { userIds: [], phones: [] } }) as { AND: unknown[] };
  assert.deepEqual(off.AND[0], { AND: [{ id: { notIn: [] } }, { OR: [{ phone: null }, { phone: { notIn: [] } }] }] });
});

test('фильтры: WhatsApp — по номерам, куда код дошёл в WhatsApp; «нет» — и люди без номера', () => {
  const phones = ['+37491123456'];
  assert.deepEqual(R.buildUserWhere(q({ whatsapp: 'yes' }), { now: NOW, whatsappPhones: phones }), { AND: [{ phone: { in: phones } }] });
  assert.deepEqual(R.buildUserWhere(q({ whatsapp: 'no' }), { now: NOW, whatsappPhones: phones }), { AND: [{ OR: [{ phone: null }, { phone: { notIn: phones } }] }] });
  assert.throws(() => q({ whatsapp: 'maybe' }));
});

test('первый вход: раньше код — его канал, раньше Google/Apple — они; неизвестное — null', () => {
  const at = (d: string) => new Date(`2026-09-${d}T10:00:00Z`);
  assert.equal(R.firstLoginVia({ channel: 'whatsapp', at: at('01') }, { method: 'google', at: at('10') }), 'whatsapp');
  assert.equal(R.firstLoginVia({ channel: 'telegram', at: at('10') }, { method: 'apple', at: at('01') }), 'apple');
  assert.equal(R.firstLoginVia(null, { method: 'google', at: at('01') }), 'google');
  assert.equal(R.firstLoginVia({ channel: 'sms', at: at('01') }, null), 'sms');
  assert.equal(R.firstLoginVia({ channel: 'pigeon', at: at('01') }, { method: 'password', at: at('01') }), null);
  assert.equal(R.firstLoginVia(null, null), null);
});

test('статус, роли, маска IP, сортировка с пустыми в конце', () => {
  assert.equal(R.userStatusOf({ blockedAt: new Date(), deleteRequestedAt: new Date(), deletedAt: null }), 'blocked');
  assert.equal(R.userStatusOf({ blockedAt: null, deleteRequestedAt: new Date(), deletedAt: null }), 'delete_requested');
  assert.equal(R.userStatusOf({ blockedAt: new Date(), deleteRequestedAt: null, deletedAt: new Date() }), 'deleted');
  assert.deepEqual(R.rolesOf([{ role: 'master' }, { role: 'admin' }, { role: 'master' }], true), ['owner', 'admin', 'master']);
  assert.equal(R.maskIp('93.184.216.34'), '93.184.•.•');
  assert.equal(R.maskIp('::ffff:10.1.2.3'), '10.1.•.•');
  assert.equal(R.maskIp('2a02:2168:8f00:1::5'), '2a02:2168:…');
  const s = R.sortIds([{ id: 'a', value: null }, { id: 'b', value: 5 }, { id: 'c', value: 9 }], 'desc');
  assert.deepEqual(s.map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(R.sortIds([{ id: 'a', value: null }, { id: 'b', value: 5 }, { id: 'c', value: 9 }], 'asc').map((r) => r.id), ['b', 'c', 'a']);
});

test('схемы: блок без причины не проходит, размер страницы — только 10/20/50/100', () => {
  assert.equal(userBlockBody.safeParse({ blocked: true }).success, false);
  assert.equal(userBlockBody.safeParse({ blocked: true, reason: '  ' }).success, false);
  assert.equal(userBlockBody.safeParse({ blocked: true, reason: 'Спам' }).success, true);
  assert.equal(userBlockBody.safeParse({ blocked: false }).success, true);
  assert.equal(usersListQuery.safeParse({ pageSize: '33' }).success, false);
  assert.equal(q({ pageSize: '50' }).pageSize, 50);
});

// ─────────── база в памяти ───────────

type Row = Record<string, unknown> & { id: string };

const SECRET_TOKEN_HASH = 'a'.repeat(64);
const SECRET_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
const GOOGLE_SUB = 'google-sub-1234567890';

function memoryDb() {
  const users: Row[] = [
    {
      id: 'u_anna',
      name: 'Анна',
      phone: '+37491123456',
      locale: 'ru',
      createdAt: new Date('2026-09-01T08:00:00Z'),
      blockedAt: null,
      deleteRequestedAt: null,
      deletedAt: null,
      sessionsRevokedAt: null,
      twoFactorEnabled: false,
    },
    { id: 'u_admin', name: 'Команда', phone: '+37400199990', locale: 'ru', createdAt: new Date('2026-08-01T08:00:00Z'), blockedAt: null, deleteRequestedAt: null, deletedAt: null },
    { id: 'u_reviewer', name: 'Проверка', phone: '+37400199991', locale: 'ru', createdAt: new Date('2026-08-01T08:00:00Z'), blockedAt: null, deleteRequestedAt: null, deletedAt: null },
  ];
  const sessions: Row[] = [
    { id: 's1', userId: 'u_anna', tokenHash: SECRET_TOKEN_HASH, ip: '93.184.216.34', revokedAt: null, revokeReason: null, expiresAt: new Date('2026-11-01'), lastSeenAt: new Date('2026-10-02T09:00:00Z') },
    { id: 's2', userId: 'u_anna', tokenHash: 'b'.repeat(64), ip: '93.184.216.35', revokedAt: null, revokeReason: null, expiresAt: new Date('2026-11-01'), lastSeenAt: new Date('2026-10-01T09:00:00Z') },
    { id: 's3', userId: 'u_anna', tokenHash: 'c'.repeat(64), ip: '1.1.1.1', revokedAt: new Date('2026-09-01'), revokeReason: 'logout', expiresAt: new Date('2026-11-01'), lastSeenAt: new Date('2026-09-01') },
    { id: 's4', userId: 'u_admin', tokenHash: 'd'.repeat(64), ip: '1.1.1.1', revokedAt: null, revokeReason: null, expiresAt: new Date('2026-11-01'), lastSeenAt: new Date('2026-10-03') },
  ];
  const members: Row[] = [
    { id: 'pm_admin', userId: 'u_admin', role: 'admin', disabledAt: null, passwordHash: SECRET_PASSWORD_HASH, login: 'platform' },
    { id: 'pm_reviewer', userId: 'u_reviewer', role: 'reviewer', disabledAt: null, passwordHash: SECRET_PASSWORD_HASH, login: 'rev' },
  ];
  const audit: Row[] = [];
  const loginEvents: Row[] = [
    { id: 'le1', userId: 'u_anna', at: new Date('2026-10-02T09:00:00Z'), method: 'google', app: 'client', result: 'ok', ip: '93.184.216.34', identifier: '+374 91 1•• •56', sessionId: 's1' },
    { id: 'le2', userId: 'u_anna', at: new Date('2026-10-01T09:00:00Z'), method: 'code', channel: null, app: 'client', result: 'wrong_code', ip: '2a02:2168:8f00:1::5', identifier: '+374 91 1•• •56', sessionId: null },
  ];
  const bookings: Row[] = [
    { id: 'b1', appUserId: 'u_anna', businessId: 'biz_nuri', startAt: new Date('2026-10-05T07:00:00Z'), status: 'scheduled', deletedAt: null },
    { id: 'b2', appUserId: 'u_anna', businessId: 'biz_nuri', startAt: new Date('2026-09-05T07:00:00Z'), status: 'arrived', deletedAt: null },
  ];
  const sessionMatch = (s: Row, w: Record<string, unknown>) =>
    s.userId === w.userId && (!('revokedAt' in w) || s.revokedAt === w.revokedAt) && (!w.expiresAt || (s.expiresAt as Date) > (w.expiresAt as { gt: Date }).gt);

  const db = {
    users,
    sessions,
    audit,
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) return null;
        // Как Prisma с select связей: отдаём связи, а у строк — ВСЕ поля (в т.ч. секреты), чтобы проверить, что сервис их не протаскивает
        return {
          ...u,
          staff: u.id === 'u_anna' ? [{ role: 'master', status: 'active', business: { id: 'biz_nuri', name: 'Nuri Nails', slug: 'nuri-nails', kind: 'salon' } }] : [],
          networks: [],
          identities: u.id === 'u_anna' ? [{ email: 'anna@gmail.com', subject: GOOGLE_SUB, createdAt: new Date('2026-09-10'), lastUsedAt: new Date('2026-10-02') }] : [],
          platformMember: members.find((m) => m.userId === u.id) ?? null,
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const u = users.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) if (k !== 'version') u[k] = v;
        return u;
      },
    },
    session: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        let count = 0;
        for (const s of sessions) if (sessionMatch(s, where)) (Object.assign(s, data), count++);
        return { count };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => sessions.filter((s) => sessionMatch(s, where)).length,
      findFirst: async ({ where }: { where: { userId: string } }) => {
        const own = sessions.filter((s) => s.userId === where.userId).sort((a, b) => (b.lastSeenAt as Date).getTime() - (a.lastSeenAt as Date).getTime());
        return own[0] ?? null;
      },
    },
    platformMember: {
      findUnique: async ({ where }: { where: { id: string } }) => members.find((m) => m.id === where.id) ?? null,
    },
    telegramLink: {
      findMany: async () => [{ id: 'tg1', chatId: '777000111', phone: '+37491123456', appUserId: 'u_anna', createdAt: new Date('2026-09-15'), blockedAt: null }],
    },
    booking: {
      count: async ({ where }: { where: { appUserId: string } }) => bookings.filter((b) => b.appUserId === where.appUserId).length,
      findMany: async ({ where, take }: { where: { appUserId: string }; take: number }) =>
        bookings.filter((b) => b.appUserId === where.appUserId).sort((a, b) => (b.startAt as Date).getTime() - (a.startAt as Date).getTime()).slice(0, take),
    },
    business: { findMany: async () => [{ id: 'biz_nuri', name: 'Nuri Nails' }] },
    otpRequest: {
      // Коды Анны: первый вход — кодом в WhatsApp 1 сентября, потом ещё раз в WhatsApp
      aggregate: async ({ where }: { where: { phone: string; channel: string } }) =>
        where.phone === '+37491123456' && where.channel === 'whatsapp'
          ? { _min: { usedAt: new Date('2026-09-01T08:00:00Z') }, _max: { usedAt: new Date('2026-09-20T08:00:00Z') } }
          : { _min: { usedAt: null }, _max: { usedAt: null } },
      findFirst: async ({ where }: { where: { phone: string } }) =>
        where.phone === '+37491123456' ? { channel: 'whatsapp', usedAt: new Date('2026-09-01T08:00:00Z'), codeHash: SECRET_TOKEN_HASH } : null,
    },
    loginEvent: {
      findMany: async ({ where, take }: { where: { userId: string }; take: number }) => loginEvents.filter((e) => e.userId === where.userId).slice(0, take),
      findFirst: async ({ where }: { where: { userId: string; result: string } }) => loginEvents.find((e) => e.userId === where.userId && e.result === where.result) ?? null,
    },
    auditEvent: {
      create: async ({ data }: { data: Row }) => audit.push(data),
      findFirst: async ({ where }: { where: { entityId: string; action: string } }) =>
        [...audit].reverse().find((a) => a.entityId === where.entityId && a.action === where.action) ?? null,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db;
}

function ctxOf(userId: string, platformMemberId: string): RequestContext {
  return {
    requestId: 'req-1',
    ip: '127.0.0.1',
    device: 'test',
    member: null,
    session: { sessionId: 's-platform', userId, locale: 'ru', platform: true, app: 'platform', mode: 'client', activeBusinessId: null, staffLoginId: null, platformMemberId, mustChangePassword: false },
  };
}

function setup() {
  const db = memoryDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- база в памяти вместо PrismaService
  const service = new PlatformUsersService(db as any, new AuditService());
  return { db, service };
}

test('блокировка: отзывает все активные сессии, пишет причину в журнал; разблокировка — обратно', async () => {
  const { db, service } = setup();
  const res = await service.setBlocked(ctxOf('u_admin', 'pm_admin'), 'u_anna', { blocked: true, reason: 'Спам в отзывах' });
  assert.deepEqual(res, { status: 'blocked', revokedSessions: 2 });
  const anna = db.users.find((u) => u.id === 'u_anna')!;
  assert.ok(anna.blockedAt instanceof Date);
  const own = db.sessions.filter((s) => s.userId === 'u_anna');
  assert.ok(own.every((s) => s.revokedAt));
  assert.deepEqual(own.filter((s) => s.revokeReason === 'blocked').map((s) => s.id), ['s1', 's2']);
  assert.equal(db.sessions.find((s) => s.id === 's4')!.revokedAt, null, 'чужие сессии не трогаем');
  const ev = db.audit.at(-1)!;
  assert.equal(ev.action, 'block');
  assert.equal(ev.actorType, 'platform');
  assert.equal(ev.entityType, 'user');
  assert.deepEqual((ev.diff as Record<string, unknown>).blockReason, [null, 'Спам в отзывах']);

  const card = await service.card('u_anna', new Date('2026-10-03T10:00:00Z'));
  assert.equal(card.status, 'blocked');
  assert.equal(card.blockReason, 'Спам в отзывах');
  assert.equal(card.activeSessions, 0);

  const back = await service.setBlocked(ctxOf('u_admin', 'pm_admin'), 'u_anna', { blocked: false });
  assert.deepEqual(back, { status: 'active', revokedSessions: 0 });
  assert.equal(db.audit.at(-1)!.action, 'unblock');
});

test('права: reviewer не блокирует и не завершает сессии; себя — нельзя', async () => {
  const { service } = setup();
  await assert.rejects(service.setBlocked(ctxOf('u_reviewer', 'pm_reviewer'), 'u_anna', { blocked: true, reason: 'Спам' }), (e: unknown) => e instanceof ApiError && e.code === 'forbidden');
  await assert.rejects(service.revokeSessions(ctxOf('u_reviewer', 'pm_reviewer'), 'u_anna'), (e: unknown) => e instanceof ApiError && e.code === 'forbidden');
  await assert.rejects(service.setBlocked(ctxOf('u_admin', 'pm_admin'), 'u_admin', { blocked: true, reason: 'Тест' }), (e: unknown) => e instanceof ApiError && e.code === 'conflict');
  await assert.rejects(service.setBlocked(ctxOf('u_admin', 'pm_admin'), 'u_nobody', { blocked: true, reason: 'Тест' }), (e: unknown) => e instanceof ApiError && e.code === 'not_found');
});

test('завершить все сессии: активные закрыты, событие в журнале', async () => {
  const { db, service } = setup();
  const res = await service.revokeSessions(ctxOf('u_admin', 'pm_admin'), 'u_anna');
  assert.deepEqual(res, { revoked: 2 });
  assert.ok(db.sessions.filter((s) => s.userId === 'u_anna').every((s) => s.revokedAt));
  assert.equal(db.audit.at(-1)!.action, 'sessions_revoke');
  assert.ok(db.users.find((u) => u.id === 'u_anna')!.sessionsRevokedAt instanceof Date);
});

test('карточка: все блоки, IP с маской, никаких хэшей, токенов, кодов и id Google', async () => {
  const { service } = setup();
  const card = await service.card('u_anna', new Date('2026-10-03T10:00:00Z'));
  assert.equal(card.phone, '+37491123456');
  assert.deepEqual(card.lastLogin, { at: '2026-10-02T13:00', method: 'google' });
  assert.deepEqual(card.roles, [{ businessId: 'biz_nuri', businessName: 'Nuri Nails', businessSlug: 'nuri-nails', kind: 'salon', role: 'master', fired: false }]);
  assert.equal(card.telegram.connected, true);
  assert.deepEqual(card.whatsapp, { used: true, since: '2026-09-01T12:00', lastAt: '2026-09-20T12:00' });
  assert.equal(card.firstLoginVia, 'whatsapp');
  assert.deepEqual(card.google, { linked: true, email: 'anna@gmail.com', since: '2026-09-10T04:00', lastUsedAt: '2026-10-02T04:00' });
  assert.equal(card.bookings.total, 2);
  assert.equal(card.bookings.recent[0]!.businessName, 'Nuri Nails');
  assert.equal(card.activeSessions, 2);
  assert.deepEqual(
    card.logins.map((l) => l.ip),
    ['93.184.•.•', '2a02:2168:…'],
  );
  const json = JSON.stringify(card);
  for (const secret of [SECRET_TOKEN_HASH, SECRET_PASSWORD_HASH, GOOGLE_SUB, '777000111', '93.184.216.34', 'tokenHash', 'passwordHash', 'subject', 'chatId', 'identifier', 'twoFactor', 'sessionId']) {
    assert.ok(!json.includes(secret), `в карточке не должно быть «${secret}»`);
  }
});
