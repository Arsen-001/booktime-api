/**
 * Основная ссылка записи (F-03-004): у каждого бизнеса она есть сразу. Регистрация и демо-данные её не заводили —
 * «Виджет для сайта» показывал «Не удалось загрузить» (проход кабинета 17.11.2026). Список ссылок заводит её сам,
 * один раз. Название (20.11.2026): новая основная — без названия, старая «Форма компании» (по-русски, слово Altegio) —
 * тоже «без названия»; в ответе подпись на языке запроса («Основная ссылка» / «Main link» / «Հիմնական հղում»),
 * своё название владельца — как есть. База в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { OnlineService } = await import('./online.service.js');
const { requestLocale } = await import('../../common/i18n/i18n.js');
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
      findFirst: async ({ where }: { where: Row }) => byWhere('bookingLink', where)[0] ?? null,
      count: async ({ where }: { where: Row }) => byWhere('bookingLink', where).length,
      create: async ({ data }: { data: Row }) => {
        const row = { createdAt: new Date(), version: 1, networkId: null, staffId: null, ...data };
        tables.bookingLink.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = byWhere('bookingLink', where);
        for (const r of rows) Object.assign(r, data, { version: (r.version as number) + 1 });
        return { count: rows.length };
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

const ctx = { member: { staffId: 'st1' } } as unknown as Parameters<InstanceType<typeof OnlineService>['updateLink']>[0];
const linkRow = (over: Row): Row => ({ id: 'l1', businessId: 'b1', name: '', kind: 'normal', bookingType: 'mixed', defaultLocale: 'ru', primary: true, formId: '1', config: {}, createdAt: new Date(), version: 1, locationId: null, networkId: null, staffId: null, ...over });

test('нет ни одной ссылки — список заводит основную без названия в действующем филиале', async () => {
  const { svc, tables } = makeService();
  const [link, ...rest] = await svc.listLinks('b1');
  assert.equal(rest.length, 0);
  assert.ok(link);
  assert.equal(link.primary, true);
  assert.equal(tables.bookingLink[0]!.name, '');
  assert.equal(link.name, 'Основная ссылка');
  assert.equal(link.nameDefault, true);
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
  const { svc, tables } = makeService([linkRow({ name: 'Моя', primary: false })]);
  const list = await svc.listLinks('b1');
  assert.equal(list.length, 1);
  assert.equal(tables.bookingLink.length, 1);
});

test('новая основная ссылка — подпись на языке запроса hy/ru/en', async () => {
  const { svc } = makeService();
  assert.equal((await svc.listLinks('b1', 'hy'))[0]!.name, 'Հիմնական հղում');
  assert.equal((await svc.listLinks('b1', 'ru'))[0]!.name, 'Основная ссылка');
  assert.equal((await svc.listLinks('b1', 'en'))[0]!.name, 'Main link');
});

test('старая «Форма компании» — это «без названия»: подпись на hy/ru/en, слова Altegio нет', async () => {
  const { svc } = makeService([linkRow({ name: 'Форма компании' })]);
  for (const [locale, label] of [['hy', 'Հիմնական հղում'], ['ru', 'Основная ссылка'], ['en', 'Main link']] as const) {
    const [link] = await svc.listLinks('b1', locale);
    assert.equal(link!.name, label);
    assert.equal(link!.nameDefault, true);
    assert.equal((await svc.getLink('b1', 'l1', locale)).name, label);
  }
});

test('своё название владельца — как есть на любом языке', async () => {
  const { svc } = makeService([linkRow({ name: 'Instagram' })]);
  for (const locale of ['hy', 'ru', 'en'] as const) {
    const link = await svc.getLink('b1', 'l1', locale);
    assert.equal(link.name, 'Instagram');
    assert.equal(link.nameDefault, false);
  }
});

test('ссылка без названия перестала быть основной — «Ссылка на запись», не «Основная»', async () => {
  const { svc } = makeService([linkRow({ name: 'Форма компании', primary: false })]);
  assert.equal((await svc.getLink('b1', 'l1', 'ru')).name, 'Ссылка на запись');
  assert.equal((await svc.getLink('b1', 'l1', 'en')).name, 'Booking link');
  assert.equal((await svc.getLink('b1', 'l1', 'hy')).name, 'Գրանցման հղում');
});

test('сохранение ссылки без названия с её же подписью — названия по-прежнему нет; своё — сохраняется', async () => {
  const { svc, tables } = makeService([linkRow({ name: 'Форма компании' })]);
  // старый кабинет шлёт name целиком при любом сохранении (подпись на языке браузера)
  const kept = await svc.updateLink(ctx, 'b1', 'l1', { name: 'Main link', theme: 'dark' }, undefined, 'hy');
  assert.equal(tables.bookingLink[0]!.name, '');
  assert.equal(kept.name, 'Հիմնական հղում');
  assert.equal(kept.nameDefault, true);
  assert.equal((kept as Row).theme, 'dark');
  await svc.updateLink(ctx, 'b1', 'l1', { name: 'Форма компании' }, undefined, 'ru');
  assert.equal(tables.bookingLink[0]!.name, '');
  // nameDefault из ответа, присланный обратно, в настройки не попадает
  await svc.updateLink(ctx, 'b1', 'l1', { nameDefault: true } as never, undefined, 'ru');
  assert.equal((tables.bookingLink[0]!.config as Row).nameDefault, undefined);
  // своё название владельца
  const renamed = await svc.updateLink(ctx, 'b1', 'l1', { name: 'Запись с сайта' }, undefined, 'en');
  assert.equal(renamed.name, 'Запись с сайта');
  assert.equal(renamed.nameDefault, false);
  // у ссылки уже своё название — «Основная ссылка» владелец может назвать и сам
  await svc.updateLink(ctx, 'b1', 'l1', { name: 'Основная ссылка' }, undefined, 'en');
  assert.equal(tables.bookingLink[0]!.name, 'Основная ссылка');
});

test('язык запроса: Accept-Language, иначе язык сессии, иначе ru', () => {
  assert.equal(requestLocale({ headers: { 'accept-language': 'hy-AM,hy;q=0.9,en;q=0.5' } }), 'hy');
  assert.equal(requestLocale({ headers: { 'accept-language': 'en' }, ctx: { session: { locale: 'hy' } } }), 'en');
  assert.equal(requestLocale({ headers: { 'accept-language': 'de-DE' }, ctx: { session: { locale: 'en' } } }), 'en');
  assert.equal(requestLocale({ headers: {} }), 'ru');
});
