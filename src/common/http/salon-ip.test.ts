/**
 * «Вход только с IP салона» (20.11.2026, DESIGN.md сайта ответ 22): адреса и сети, настоящий адрес клиента за краем
 * Railway, проверка на каждом запросе кабинета (BizGuard + DbMembership): с адреса салона — пускает, не с него —
 * ip_not_allowed и попытка для владельца, владельца — всегда, «Добавить этот адрес» — открывает. База в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { clientIp, ipAllowedBy, isValidIpRange, normalizeIp, salonAddressFor } = await import('./salon-ip.js');
const { DbMembership } = await import('./membership.js');
const { BizGuard } = await import('./guards.js');
const { StaffService } = await import('../../modules/staff/staff.service.js');

type Row = Record<string, unknown>;

// ─────────── адреса и сети ───────────

test('адрес и сеть: точное совпадение, /24, /16, IPv6 /64, ::ffff:, ошибочные строки списка пропускаются', () => {
  const salon = ['37.252.64.10', '5.77.0.0/16', '2a00:cc0:1:2::/64', 'опечатка', '300.1.1.1'];
  assert.equal(ipAllowedBy(salon, '37.252.64.10'), true);
  assert.equal(ipAllowedBy(salon, '37.252.64.11'), false);
  assert.equal(ipAllowedBy(salon, '5.77.200.3'), true);
  assert.equal(ipAllowedBy(salon, '5.78.0.1'), false);
  assert.equal(ipAllowedBy(salon, '2a00:cc0:1:2:aaaa:bbbb:cccc:dddd'), true);
  assert.equal(ipAllowedBy(salon, '2a00:cc0:1:3::1'), false);
  assert.equal(ipAllowedBy(salon, '::ffff:37.252.64.10'), true);
  assert.equal(ipAllowedBy(['37.252.64.0/24'], '37.252.64.200'), true);
  assert.equal(ipAllowedBy(['37.252.64.0/20'], '37.252.79.1'), true, 'сеть не по целым байтам');
  assert.equal(ipAllowedBy(['37.252.64.0/20'], '37.252.80.1'), false);
  assert.equal(ipAllowedBy([], '37.252.64.10'), false, 'пустой список — закрыто для всех адресов');
  assert.equal(ipAllowedBy(salon, ''), false);
  assert.equal(isValidIpRange('37.252.64.0/24'), true);
  assert.equal(isValidIpRange('37.252.64.0/33'), false);
  assert.equal(isValidIpRange('2a00:cc0::/64'), true);
  assert.equal(isValidIpRange('37.252.64'), false);
  assert.equal(isValidIpRange('1.2.3.4/8/8'), false);
  assert.equal(isValidIpRange('2a00:cc0::1::2'), false);
  assert.equal(normalizeIp(' ::FFFF:1.2.3.4 '), '1.2.3.4');
});

test('«Добавить этот адрес»: IPv4 — сам адрес, IPv6 — его сеть /64', () => {
  assert.equal(salonAddressFor('37.252.64.10'), '37.252.64.10');
  assert.equal(salonAddressFor('2a00:cc0:1:2:a:b:c:d'), '2a00:cc0:1:2::/64');
  assert.equal(salonAddressFor('2A00:CC0:1::5'), '2a00:cc0:1:0::/64');
  assert.equal(salonAddressFor('::ffff:5.77.1.2'), '5.77.1.2');
  assert.equal(salonAddressFor('не адрес'), null);
});

test('настоящий адрес: за прокси — X-Real-IP края Railway, подделанный X-Forwarded-For не помогает; локально — адрес соединения', () => {
  const req = (headers: Record<string, string>, ip: string) => ({ header: (n: string) => headers[n.toLowerCase()], ip, socket: { remoteAddress: '10.0.0.5' } });
  // Клиент прислал «я из салона» в X-Forwarded-For; край Railway поставил настоящий адрес в X-Real-IP
  assert.equal(clientIp(req({ 'x-forwarded-for': '37.252.64.10', 'x-real-ip': '93.184.12.7' }, '93.184.12.7'), 1), '93.184.12.7');
  // Без X-Real-IP — req.ip Express (последний адрес, дописанный прокси)
  assert.equal(clientIp(req({ 'x-forwarded-for': '37.252.64.10, 93.184.12.7' }, '93.184.12.7'), 1), '93.184.12.7');
  // X-Real-IP не адрес — тоже req.ip
  assert.equal(clientIp(req({ 'x-real-ip': 'salon' }, '93.184.12.7'), 1), '93.184.12.7');
  // Локально (TRUST_PROXY пуст) заголовкам не верим вовсе
  assert.equal(clientIp(req({ 'x-real-ip': '37.252.64.10' }, '::ffff:127.0.0.1'), undefined), '127.0.0.1');
});

// ─────────── проверка на каждом запросе ───────────

function cond(value: unknown, c: unknown): boolean {
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    const o = c as Row;
    if ('in' in o) return (o.in as unknown[]).includes(value);
    if ('not' in o) return value !== o.not;
    if ('lt' in o) return (value as Date) < (o.lt as Date);
    if ('gte' in o) return (value as Date) >= (o.gte as Date);
    return true; // вложенные условия (business: { leftAt: null }) в фикстуре всегда верны
  }
  return c === null ? value === null || value === undefined : value === c;
}
const matches = (r: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => cond(r[k], v));

/** Салон Nuri: владелец Нури (u_owner), мастер Ани (u_ani, галочка стоит), мастер Мариам (u_mar, галочки нет) */
function salon(opts: { ips?: string[]; ownerFlag?: boolean } = {}) {
  const businesses: Row[] = [{ id: 'biz_nuri', name: 'Nuri', kind: 'salon', networkId: null, salonIps: opts.ips ?? ['37.252.64.10'], version: 1, locations: [] }];
  const staff: Row[] = [
    { id: 'st_owner', businessId: 'biz_nuri', userId: 'u_owner', name: 'Нури', role: 'owner', status: 'active', accessEnabled: true, deletedAt: null, salonIpOnly: opts.ownerFlag ?? false, permissions: null },
    { id: 'st_ani', businessId: 'biz_nuri', userId: 'u_ani', name: 'Ани', role: 'master', status: 'active', accessEnabled: true, deletedAt: null, salonIpOnly: true, permissions: null },
    { id: 'st_mar', businessId: 'biz_nuri', userId: 'u_mar', name: 'Мариам', role: 'master', status: 'active', accessEnabled: true, deletedAt: null, salonIpOnly: false, permissions: null },
  ];
  const attempts: Row[] = [];
  const db = {
    staffLogin: { findUnique: async () => null },
    network: { findMany: async () => [] },
    staff: {
      findFirst: async ({ where }: { where: Row }) => staff.find((s) => matches(s, where)) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        staff.filter((s) => matches(s, where)).map((s) => ({ ...s, business: businesses.find((b) => b.id === s.businessId) })),
    },
    business: {
      findUniqueOrThrow: async ({ where }: { where: Row }) => ({ ...businesses.find((b) => b.id === where.id)! }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const b = businesses.find((x) => x.id === where.id && x.version === where.version);
        if (!b) return { count: 0 };
        b.salonIps = data.salonIps;
        b.version = (b.version as number) + 1;
        return { count: 1 };
      },
    },
    salonIpAttempt: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = attempts.filter((a) => matches(a, where));
        for (const a of hit) {
          a.attempts = (a.attempts as number) + 1;
          a.lastAt = data.lastAt;
        }
        return { count: hit.length };
      },
      create: async ({ data }: { data: Row }) => {
        if (attempts.some((a) => a.businessId === data.businessId && a.staffId === data.staffId && a.ip === data.ip)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        attempts.push({ attempts: 1, ...data });
        return data;
      },
      findMany: async ({ where }: { where: Row }) => attempts.filter((a) => matches(a, where)).sort((a, b) => +(b.lastAt as Date) - +(a.lastAt as Date)),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const membership = new DbMembership(db as never);
  const guard = new BizGuard({ getAllAndOverride: () => undefined } as never, membership);
  const staffService = new StaffService(db as never, { record: async () => {} } as never, {} as never, {} as never);
  /** Запрос кабинета: GET /v1/biz/biz_nuri/… от человека с адреса ip */
  const open = async (userId: string, ip: string) => {
    const req = { params: { businessId: 'biz_nuri' }, ctx: { ip, session: { userId, staffLoginId: null }, member: null as { staffId: string } | null } };
    const host = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null };
    await guard.canActivate(host as never);
    return req.ctx.member!;
  };
  const ownerCtx = (ip: string) => ({ ip, member: { businessId: 'biz_nuri', staffId: 'st_owner' } }) as never;
  return { businesses, attempts, membership, staffService, open, ownerCtx };
}

const refused = (ip: string) => (e: unknown) => {
  const err = e as { code?: string; status?: number; fields?: Record<string, string> };
  return err.code === 'ip_not_allowed' && err.status === 403 && err.fields?.ip === ip;
};

test('сотрудник с галочкой: с адреса салона — пускает, не с него — ip_not_allowed с адресом, попытка запомнена', async () => {
  const s = salon();
  assert.equal((await s.open('u_ani', '37.252.64.10')).staffId, 'st_ani');
  await assert.rejects(s.open('u_ani', '93.184.12.7'), refused('93.184.12.7'));
  assert.equal(s.attempts.length, 1);
  assert.deepEqual([s.attempts[0]!.staffId, s.attempts[0]!.ip, s.attempts[0]!.attempts], ['st_ani', '93.184.12.7', 1]);
  // Тот же адрес в ту же минуту — та же строка, без второй записи и без ошибки
  await assert.rejects(s.open('u_ani', '93.184.12.7'), refused('93.184.12.7'));
  assert.equal(s.attempts.length, 1);
  // Без галочки — с любого адреса
  assert.equal((await s.open('u_mar', '93.184.12.7')).staffId, 'st_mar');
});

test('сессия началась в салоне: смена адреса закрывает уже следующий запрос', async () => {
  const s = salon();
  await s.open('u_ani', '37.252.64.10');
  await assert.rejects(s.open('u_ani', '46.70.1.1'), refused('46.70.1.1'));
});

test('владельца не закрывает никогда — даже с галочкой в базе и пустым списком', async () => {
  const s = salon({ ips: [], ownerFlag: true });
  assert.equal((await s.open('u_owner', '93.184.12.7')).staffId, 'st_owner');
  assert.equal(s.attempts.length, 0);
  await assert.rejects(s.staffService.setSalonIpOnly(s.ownerCtx('1.1.1.1'), 'biz_nuri', 'st_owner', true), (e: { code?: string }) => e.code === 'forbidden');
});

test('«Кто я»: закрытый салон приходит с blockedIp, остальные — без него', async () => {
  const s = salon();
  const [blocked] = await s.membership.list('u_ani', null, '93.184.12.7');
  assert.equal(blocked!.blockedIp, '93.184.12.7');
  assert.equal('salonIps' in blocked!, false, 'список адресов салона сотруднику не уходит');
  const [open] = await s.membership.list('u_ani', null, '37.252.64.10');
  assert.equal(open!.blockedIp, undefined);
  const [plain] = await s.membership.list('u_ani', null);
  assert.equal(plain!.blockedIp, undefined, 'без адреса (выбор бизнеса при входе) не помечаем');
});

test('владелец видит попытку и «Добавить этот адрес» открывает вход; уже открыто — список не меняется', async () => {
  const s = salon();
  await assert.rejects(s.open('u_ani', '93.184.12.7'), refused('93.184.12.7'));
  const view = await s.staffService.salonIps(s.ownerCtx('37.252.64.10'), 'biz_nuri');
  assert.equal(view.currentIp, '37.252.64.10');
  assert.deepEqual(
    view.attempts.map((a) => [a.staffName, a.ip, a.attempts]),
    [['Ани', '93.184.12.7', 1]],
  );
  const after = await s.staffService.addSalonIp(s.ownerCtx('37.252.64.10'), 'biz_nuri', '93.184.12.7');
  assert.deepEqual(after.ips, ['37.252.64.10', '93.184.12.7']);
  assert.deepEqual(after.attempts, [], 'открытая попытка больше не показывается');
  assert.equal((await s.open('u_ani', '93.184.12.7')).staffId, 'st_ani');
  const again = await s.staffService.addSalonIp(s.ownerCtx('37.252.64.10'), 'biz_nuri', '93.184.12.7');
  assert.deepEqual(again.ips, ['37.252.64.10', '93.184.12.7']);
  assert.equal(s.businesses[0]!.version, 2, 'повторное «Добавить» базу не трогает');
});

test('IPv6: «Добавить этот адрес» добавляет сеть /64 — завтрашний адрес той же сети тоже входит', async () => {
  const s = salon();
  await assert.rejects(s.open('u_ani', '2a00:cc0:1:2:a:b:c:d'), refused('2a00:cc0:1:2:a:b:c:d'));
  const after = await s.staffService.addSalonIp(s.ownerCtx('37.252.64.10'), 'biz_nuri', '2a00:cc0:1:2:a:b:c:d');
  assert.deepEqual(after.ips, ['37.252.64.10', '2a00:cc0:1:2::/64']);
  assert.equal((await s.open('u_ani', '2a00:cc0:1:2:1:2:3:4')).staffId, 'st_ani');
});

test('список адресов целиком: ошибка в строке — invalid_ip_range с этой строкой, повторы и пустые убираются', async () => {
  const s = salon();
  await assert.rejects(
    s.staffService.setSalonIps(s.ownerCtx('1.1.1.1'), 'biz_nuri', ['37.252.64.10', '37.252.64']),
    (e: { code?: string; fields?: Record<string, string> }) => e.code === 'invalid_ip_range' && e.fields?.value === '37.252.64',
  );
  const r = await s.staffService.setSalonIps(s.ownerCtx('1.1.1.1'), 'biz_nuri', ['37.252.64.10', ' 37.252.64.10 ', '', '5.77.0.0/16']);
  assert.deepEqual(r.ips, ['37.252.64.10', '5.77.0.0/16']);
});
