/** Лёгкий список для sitemap.xml (04.10.2026): форма ответа, кто попадает, кто нет, кэш в памяти (база — в памяти). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { SitemapService, SITEMAP_TTL_SEC } = await import('./sitemap.service.js');
type Ctor = ConstructorParameters<typeof SitemapService>;
type Row = Record<string, unknown>;

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(cur)) return false;
      return true;
    }
    return cur === v;
  });
}

function memoryPrisma(tables: Record<string, Row[]>) {
  const calls: Record<string, number> = {};
  const table = (name: string) => ({
    findMany: async ({ where, select }: { where?: Row; select?: Record<string, boolean> } = {}) => {
      calls[name] = (calls[name] ?? 0) + 1;
      const rows = (tables[name] ?? []).filter((r) => matches(r, where));
      // Как Prisma: только выбранные поля — тест заодно проверяет, что тяжёлые колонки не читаются
      return select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows;
    },
  });
  return { calls, prisma: Object.fromEntries(['business', 'staff', 'location', 'service', 'workSchedule'].map((n) => [n, table(n)])) as unknown as Ctor[0] };
}

const T0 = new Date('2026-09-01T10:00:00.000Z');
const T1 = new Date('2026-10-02T12:00:00.000Z');

const business = (id: string, kind: string, sphereIds: string[], extra: Row = {}): Row => ({
  id, slug: id, kind, sphereIds, status: 'active', ordersEnabled: null, updatedAt: T0, description: { ru: 'тяжёлое поле' },
  photos: ['https://files.booktime.am/a.jpg', 'data:image/png;base64,AAAA', 'https://files.booktime.am/b.jpg'], ...extra,
});
const staff = (id: string, businessId: string, extra: Row = {}): Row => ({
  id, businessId, sphereIds: ['nails'], serviceIds: ['svc'], status: 'active', deletedAt: null, onlineBookingEnabled: true, calendarVisibility: 'all', updatedAt: T0, ...extra,
});

function world() {
  return memoryPrisma({
    business: [
      business('nuri', 'salon', ['nails']),
      business('anna', 'individual', ['hair']),
      business('draft', 'salon', ['nails'], { status: 'draft' }),
      business('empty', 'salon', ['nails']),
      business('igla', 'salon', ['tailor']),
      business('igla-off', 'salon', ['tailor'], { ordersEnabled: false }),
    ],
    staff: [
      staff('st_a', 'nuri', { updatedAt: T1 }),
      staff('st_b', 'nuri', { sphereIds: ['cosmetology'] }),
      staff('st_link', 'nuri', { calendarVisibility: 'link' }),
      staff('st_mine', 'nuri', { calendarVisibility: 'mine' }),
      staff('st_off', 'nuri', { onlineBookingEnabled: false }),
      staff('st_fired', 'nuri', { status: 'fired' }),
      staff('st_deleted', 'nuri', { deletedAt: T0 }),
      staff('st_nosched', 'nuri'),
      staff('st_nosvc', 'nuri', { serviceIds: ['svc_hidden'] }),
      staff('anna_owner', 'anna', { sphereIds: ['hair'] }),
      staff('st_draft', 'draft'),
      staff('st_empty', 'empty', { serviceIds: [] }),
    ],
    location: [
      { businessId: 'nuri', district: 'kentron', deletedAt: null },
      { businessId: 'nuri', district: 'arabkir', deletedAt: null },
      { businessId: 'nuri', district: 'davtashen', deletedAt: T0 },
      { businessId: 'anna', district: 'ajapnyak', deletedAt: null },
      { businessId: 'igla', district: 'kentron', deletedAt: null },
    ],
    service: [
      { id: 'svc', businessId: 'nuri', active: true, onlineBookable: true },
      { id: 'svc', businessId: 'anna', active: true, onlineBookable: true },
      { id: 'svc_hidden', businessId: 'nuri', active: true, onlineBookable: false },
    ],
    workSchedule: ['st_a', 'st_b', 'st_link', 'st_mine', 'st_off', 'st_fired', 'st_deleted', 'st_nosvc', 'anna_owner', 'st_draft', 'st_empty'].map((staffId) => ({ staffId })),
  });
}

test('форма ответа: бизнесы со сферами, районами, только http-фото, датой; мастера салонов со slug', async () => {
  const svc = new SitemapService(world().prisma);
  const out = await svc.sitemap();
  assert.deepEqual(Object.keys(out).sort(), ['businesses', 'masters']);
  const nuri = out.businesses.find((b) => b.slug === 'nuri')!;
  assert.deepEqual(nuri, {
    slug: 'nuri',
    kind: 'salon',
    sphereIds: ['cosmetology', 'nails'],
    districts: ['arabkir', 'kentron'],
    images: ['https://files.booktime.am/a.jpg', 'https://files.booktime.am/b.jpg'],
    updatedAt: T1.toISOString(), // позже бизнеса изменён мастер st_a
  });
  assert.deepEqual(out.masters, [
    { id: 'st_a', businessSlug: 'nuri', updatedAt: T1.toISOString() },
    { id: 'st_b', businessSlug: 'nuri', updatedAt: T0.toISOString() },
  ]);
  assert.equal(JSON.stringify(out).includes('тяжёлое поле'), false);
});

test('фильтры: черновик, бизнес без видимых мастеров, скрытые/выключенные/уволенные/без графика/без онлайн-услуги — не попадают', async () => {
  const out = await new SitemapService(world().prisma).sitemap();
  assert.deepEqual(out.businesses.map((b) => b.slug), ['anna', 'igla', 'nuri']);
  const ids = out.masters.map((m) => m.id);
  for (const hidden of ['st_link', 'st_mine', 'st_off', 'st_fired', 'st_deleted', 'st_nosched', 'st_nosvc', 'st_draft', 'st_empty']) assert.ok(!ids.includes(hidden), hidden);
});

test('мастер-одиночка — только страница бизнеса; мастерская «Заказов» — без мастеров, со своей сферой; выключенные «Заказы» — нет', async () => {
  const out = await new SitemapService(world().prisma).sitemap();
  const anna = out.businesses.find((b) => b.slug === 'anna')!;
  assert.equal(anna.kind, 'individual');
  assert.ok(!out.masters.some((m) => m.id === 'anna_owner'));
  const igla = out.businesses.find((b) => b.slug === 'igla')!;
  assert.deepEqual(igla.sphereIds, ['tailor']);
  assert.deepEqual(igla.districts, ['kentron']);
  assert.ok(!out.businesses.some((b) => b.slug === 'igla-off'));
});

test('кэш в памяти: повтор в пределах 10 минут базу не читает, после — читает заново; одновременные — один расчёт', async () => {
  const { prisma, calls } = world();
  const svc = new SitemapService(prisma);
  const [a, b] = await Promise.all([svc.sitemap(), svc.sitemap()]);
  assert.equal(a, b);
  assert.equal(calls.business, 1);
  await svc.sitemap(Date.now() + (SITEMAP_TTL_SEC - 5) * 1000);
  assert.equal(calls.business, 1);
  await svc.sitemap(Date.now() + (SITEMAP_TTL_SEC + 5) * 1000);
  assert.equal(calls.business, 2);
});

test('пустая база — пустые списки', async () => {
  const out = await new SitemapService(memoryPrisma({}).prisma).sitemap();
  assert.deepEqual(out, { businesses: [], masters: [] });
});
