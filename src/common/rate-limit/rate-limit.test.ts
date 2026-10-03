/** Лимиты по IP и SSR сайта (X-BT-SSR, 04.10.2026): кто получает повышенный предел, кто нет (Redis — в памяти). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SSR_SHARED_SECRET = 'ssr-secret-for-tests';
process.env.SSR_RATE_MULTIPLIER = '10';

const { RateLimitGuard, RateLimitService, effectiveRule, isOwnSsr, SSR_HEADER } = await import('./rate-limit.js');
const { ApiError } = await import('../errors/api-error.js');
type Rule = Parameters<typeof effectiveRule>[0];

/** Ровно то подмножество ioredis, которым пользуется RateLimitService.hit */
function memoryRedis() {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    counts,
    multi() {
      const ops: (() => [null, number])[] = [];
      const chain = {
        incr(k: string) {
          ops.push(() => [null, counts.set(k, (counts.get(k) ?? 0) + 1).get(k)!]);
          return chain;
        },
        ttl(k: string) {
          ops.push(() => [null, ttls.get(k) ?? -1]);
          return chain;
        },
        exec: async () => ops.map((op) => op()),
      };
      return chain;
    },
    expire: async (k: string, sec: number) => void ttls.set(k, sec),
  };
}

const RULE: Rule = { bucket: 'public-business', limit: 3, windowSec: 60, by: 'ip' };

function guardWith(rule: Rule) {
  const redis = memoryRedis();
  const reflector = { get: () => rule };
  const guard = new RateLimitGuard(reflector as never, new RateLimitService(redis as never));
  const call = (headers: Record<string, string> = {}, method = 'GET', ip = '76.76.21.1') => {
    const req = { method, ctx: { ip, session: null }, header: (n: string) => headers[n.toLowerCase()] };
    const host = { getHandler: () => null, switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: () => undefined }) }) };
    return guard.canActivate(host as never);
  };
  return { call, redis };
}

const limited = (e: unknown) => e instanceof ApiError && e.code === 'rate_limited';

test('isOwnSsr: только точное совпадение с заданным секретом; без секрета — никогда', () => {
  assert.equal(isOwnSsr('ssr-secret-for-tests'), true);
  assert.equal(isOwnSsr('ssr-secret-for-test'), false);
  assert.equal(isOwnSsr('ssr-secret-for-testsX'), false);
  assert.equal(isOwnSsr(undefined), false);
  assert.equal(isOwnSsr(''), false);
  assert.equal(isOwnSsr(['ssr-secret-for-tests']), false);
  assert.equal(isOwnSsr('ssr-secret-for-tests', ''), false, 'SSR_SHARED_SECRET не задан — обычные лимиты');
  assert.equal(isOwnSsr('', ''), false);
});

test('effectiveRule: SSR — своя корзина и предел × множитель; запись, лимит по сессии и неверный секрет — как у всех', () => {
  const req = (headers: Record<string, string>, method = 'GET') => ({ method, header: (n: string) => headers[n] });
  const ok = { [SSR_HEADER]: 'ssr-secret-for-tests' };
  assert.deepEqual(effectiveRule(RULE, req(ok)), { bucket: 'ssr:public-business', limit: 30 });
  assert.deepEqual(effectiveRule(RULE, req({})), { bucket: 'public-business', limit: 3 });
  assert.deepEqual(effectiveRule(RULE, req({ [SSR_HEADER]: 'wrong' })), { bucket: 'public-business', limit: 3 });
  assert.deepEqual(effectiveRule(RULE, req(ok, 'POST')), { bucket: 'public-business', limit: 3 }, 'запись не ускоряем');
  assert.deepEqual(effectiveRule({ ...RULE, by: 'session' }, req(ok)), { bucket: 'public-business', limit: 3 });
  assert.deepEqual(effectiveRule(RULE, req(ok), ''), { bucket: 'public-business', limit: 3 }, 'секрет не задан');
});

test('guard: обычный посетитель упирается в лимит, SSR с тем же IP — нет; счётчики раздельные', async () => {
  const { call, redis } = guardWith(RULE);
  for (let i = 0; i < 3; i++) assert.equal(await call(), true);
  await assert.rejects(call(), limited);
  // Тот же адрес Vercel, но с секретом: своя корзина и предел 30
  for (let i = 0; i < 30; i++) assert.equal(await call({ [SSR_HEADER]: 'ssr-secret-for-tests' }), true);
  await assert.rejects(call({ [SSR_HEADER]: 'ssr-secret-for-tests' }), limited);
  // Чужой секрет — обычная корзина, она уже исчерпана
  await assert.rejects(call({ [SSR_HEADER]: 'guess' }), limited);
  assert.equal(redis.counts.get('rl:public-business:76.76.21.1'), 5);
  assert.equal(redis.counts.get('rl:ssr:public-business:76.76.21.1'), 31);
});
