/**
 * Основная ссылка записи (F-03-004): у каждого бизнеса она есть сразу. Регистрация и демо-данные её не заводили —
 * «Виджет для сайта» показывал «Не удалось загрузить» (проход кабинета 17.11.2026). Список ссылок заводит её сам,
 * один раз. База в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { OnlineService } = await import('./online.service.js');
type Ctor = ConstructorParameters<typeof OnlineService>;
type Row = Record<string, unknown>;

function makeService(links: Row[] = []) {
  const tables: { bookingLink: Row[]; location: Row[] } = {
    bookingLink: links,
    location: [
      { id: 'loc_old', businessId: 'b1', deletedAt: new Date('2026-01-01T00:00:00Z'), sortOrder: 0 },
      { id: 'loc_main', businessId: 'b1', deletedAt: null, sortOrder: 1 },
    ],
  };
  const byWhere = (name: 'bookingLink' | 'location', where: Row = {}) =>
    tables[name].filter((r) => Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : r[k] === v)));
  const db = {
    bookingLink: {
      findMany: async ({ where }: { where: Row }) => byWhere('bookingLink', where),
      count: async ({ where }: { where: Row }) => byWhere('bookingLink', where).length,
      create: async ({ data }: { data: Row }) => {
        const row = { createdAt: new Date(), version: 1, networkId: null, staffId: null, ...data };
        tables.bookingLink.push(row);
        return row;
      },
    },
    location: { findFirst: async ({ where }: { where: Row }) => byWhere('location', where)[0] ?? null },
    $queryRaw: async () => [],
  };
  // Транзакции идут по очереди, как под FOR UPDATE на строке бизнеса
  let queue = Promise.resolve();
  const prisma = {
    ...db,
    $transaction: (fn: (tx: typeof db) => Promise<unknown>) => {
      const run = queue.then(() => fn(db));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  const svc = new OnlineService(prisma as unknown as Ctor[0], {} as Ctor[1], {} as Ctor[2], {} as Ctor[3], {} as Ctor[4]);
  return { svc, tables };
}

test('нет ни одной ссылки — список заводит основную «Форма компании» в действующем филиале', async () => {
  const { svc, tables } = makeService();
  const [link, ...rest] = await svc.listLinks('b1');
  assert.equal(rest.length, 0);
  assert.ok(link);
  assert.equal(link.primary, true);
  assert.equal(link.name, 'Форма компании');
  assert.equal(link.kind, 'normal');
  assert.equal(link.locationId, 'loc_main');
  assert.equal((link as Row).bookingFlow, 'menu');
  assert.equal(tables.bookingLink.length, 1);
});

test('два запроса сразу — основная ссылка одна', async () => {
  const { svc, tables } = makeService();
  await Promise.all([svc.listLinks('b1'), svc.listLinks('b1')]);
  assert.equal(tables.bookingLink.length, 1);
});

test('ссылки уже есть — ничего не заводится', async () => {
  const { svc, tables } = makeService([{ id: 'l1', businessId: 'b1', name: 'Моя', kind: 'normal', primary: false, formId: '1', config: {}, createdAt: new Date(), version: 1 }]);
  const list = await svc.listLinks('b1');
  assert.equal(list.length, 1);
  assert.equal(tables.bookingLink.length, 1);
});
