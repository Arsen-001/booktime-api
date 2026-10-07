/**
 * «Места» (03.10.2026): фильтры и сортировка списка, импорт с upsert по «имя|адрес», статус места из визитов.
 * Без базы — таблицы подменены памятью. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { ProspectsService } = await import('./prospects.service.js');
const L = await import('./prospects.logic.js');

type Row = Record<string, unknown> & { id: string };

function where(row: Row, w: Record<string, unknown> | undefined): boolean {
  if (!w) return true;
  for (const [k, cond] of Object.entries(w)) {
    if (cond === undefined) continue;
    const v = row[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as { in?: unknown[]; not?: unknown; gte?: number; lte?: number };
      if (c.in && !c.in.includes(v)) return false;
      if ('not' in c && v === c.not) return false;
      if (c.gte !== undefined && (typeof v !== 'number' || v < c.gte)) return false;
      if (c.lte !== undefined && (typeof v !== 'number' || v > c.lte)) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

function table(rows: Row[]) {
  return {
    rows,
    findMany: async ({ where: w }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => where(r, w)),
    findUnique: async ({ where: w }: { where: Record<string, unknown> }) => rows.find((r) => where(r, w)) ?? null,
    count: async ({ where: w }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => where(r, w)).length,
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) rows.push({ version: 1, createdAt: new Date(), updatedAt: new Date(), note: null, tags: null, reviews: null, address: null, branches: null, staffEstimate: null, staffSource: null, bookingUrl: null, website: null, instagram: null, phone: null, category: 'other', district: 'unknown', bookingSystem: 'unknown', ...d });
      return { count: data.length };
    },
    update: async ({ where: w, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === w.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (k === 'version') r.version = (r.version as number) + 1;
        else r[k] = v;
      }
      return r;
    },
    updateMany: async ({ where: w, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => where(r, w));
      for (const r of hit) for (const [k, v] of Object.entries(data)) r[k] = k === 'version' ? (r.version as number) + 1 : v;
      return { count: hit.length };
    },
    delete: async ({ where: w }: { where: { id: string } }) => {
      rows.splice(rows.findIndex((r) => r.id === w.id), 1);
    },
  };
}

function setup(prospects: Row[] = [], visits: Row[] = []) {
  const prisma = {
    prospect: table(prospects),
    salesVisit: table(visits),
    batches: [] as { size: number; timeout?: number }[],
    $transaction: async (ops: Promise<unknown>[], opts?: { timeout?: number }) => {
      prisma.batches.push({ size: ops.length, timeout: opts?.timeout });
      return Promise.all(ops);
    },
  };
  return { svc: new ProspectsService(prisma as never), prisma };
}

const P = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  name: id,
  category: 'nails',
  district: 'kentron',
  address: null,
  branches: null,
  staffEstimate: null,
  staffSource: null,
  bookingSystem: 'unknown',
  bookingUrl: null,
  website: null,
  instagram: null,
  phone: null,
  reviews: null,
  sourceUrls: [],
  note: null,
  tags: null,
  dedupKey: L.dedupKeyOf(String(over.name ?? id), over.address as string | undefined),
  version: 1,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  ...over,
});
const V = (id: string, prospectId: string, status: string, visitedAt: string, businessId: string | null = null): Row => ({
  id,
  prospectId,
  status,
  visitedAt,
  createdAt: new Date(`${visitedAt}T10:00:00Z`),
  businessId,
  responsibleId: 'team_1',
  note: null,
});

// ─────────────────────────── правила ───────────────────────────

test('ключ дедупликации: регистр, кавычки, ё и лишние пробелы не важны', () => {
  assert.equal(L.dedupKeyOf('Салон «Ёлка»', 'ул. Абовяна,  10'), L.dedupKeyOf('салон ёлка', 'Ул Абовяна 10'));
  assert.notEqual(L.dedupKeyOf('Ева', 'Абовяна 10'), L.dedupKeyOf('Ева', 'Туманяна 5'));
});

test('районы импорта (snake_case) → DistrictId фронта, неизвестное → unknown', () => {
  assert.equal(L.mapDistrict('ajapnyak'), 'achapnyak');
  assert.equal(L.mapDistrict('malatia_sebastia'), 'malatia-sebastia');
  assert.equal(L.mapDistrict('Nor-Nork'), 'nor-nork');
  assert.equal(L.mapDistrict('kanaker_zeytun'), 'kanaker-zeytun');
  assert.equal(L.mapDistrict('unknown'), 'unknown');
  assert.equal(L.mapDistrict('gyumri'), 'unknown');
  assert.equal(L.mapDistrict(undefined), 'unknown');
});

test('строка импорта: snake_case → поля, неизвестная система/сфера → unknown/other, без имени — пропуск', () => {
  const r = L.parseImportRow({
    name: ' Nail Bar ',
    category: 'nails',
    district: 'arabkir',
    address: 'Комитаса 5',
    branches: 2,
    staff_estimate: '7',
    staff_source: 'instagram',
    booking_system: 'Altegio',
    booking_url: 'https://n.altegio.me/x',
    phone: '+374 10 123456',
    reviews: { rating: 4.83, count: 120, source: 'Google' },
    source_urls: ['https://a', 'https://a', 'https://b'],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.data.name, 'Nail Bar');
  assert.equal(r.data.staffEstimate, 7);
  assert.equal(r.data.bookingSystem, 'altegio');
  assert.deepEqual(r.data.reviews, { rating: 4.8, count: 120, text: 'Google' });
  assert.deepEqual(r.data.sourceUrls, ['https://a', 'https://b']);
  const odd = L.parseImportRow({ name: 'X', category: 'tattoo', booking_system: 'yclients' });
  assert.ok(odd.ok && odd.data.category === 'other' && odd.data.bookingSystem === 'unknown' && odd.data.district === 'unknown');
  assert.deepEqual(L.parseImportRow({ category: 'nails' }), { ok: false, reason: 'name_required' });
  assert.deepEqual(L.parseImportRow('строка'), { ok: false, reason: 'not_object' });
});

test('системы записи макета (03.10.2026): Emly выключен, Booker.am, Sonline; порядок — сначала проще подключить', () => {
  for (const sys of ['emly_off', 'booker', 'sonline'] as const) {
    const r = L.parseImportRow({ name: `Место ${sys}`, booking_system: sys });
    assert.ok(r.ok && r.data.bookingSystem === sys, sys);
  }
  assert.deepEqual(L.BOOKING_SYSTEMS.slice(0, 3), ['phone_whatsapp', 'instagram', 'emly_off']);
  assert.equal(L.BOOKING_SYSTEMS.length, new Set(L.BOOKING_SYSTEMS).size);
});

test('сортировка «больше отзывов»: без отзывов — в конце, при равенстве — по мастерам', () => {
  const rows = [
    { name: 'Б', staffEstimate: 3, reviews: null },
    { name: 'А', staffEstimate: 9, reviews: { count: 40 } },
    { name: 'В', staffEstimate: 12, reviews: { count: 40 } },
    { name: 'Г', staffEstimate: 30, reviews: { count: 5 } },
  ];
  assert.deepEqual(L.sortProspects(rows, 'reviews_desc').map((r) => r.name), ['В', 'А', 'Г', 'Б']);
});

test('статус места: не были → последний визит → работает в BookTime при бизнесе', () => {
  assert.equal(L.statusFromVisits([]).status, 'new');
  const visits = [V('v1', 'p', 'refused', '2026-09-01'), V('v2', 'p', 'thinking', '2026-09-20')] as never[];
  const info = L.statusFromVisits(visits);
  assert.equal(info.status, 'thinking');
  assert.equal(info.lastVisit?.id, 'v2');
  assert.equal(info.visitCount, 2);
  assert.equal(L.statusFromVisits([V('v1', 'p', 'connected', '2026-09-01', 'biz_1'), V('v2', 'p', 'refused', '2026-09-20')] as never[]).status, 'live');
});

test('сортировка по мастерам: неизвестное число — в конце в обе стороны', () => {
  const rows = [{ name: 'Б', staffEstimate: 3 }, { name: 'А', staffEstimate: null }, { name: 'В', staffEstimate: 10 }];
  assert.deepEqual(L.sortProspects(rows, 'staff_desc').map((r) => r.name), ['В', 'Б', 'А']);
  assert.deepEqual(L.sortProspects(rows, 'staff_asc').map((r) => r.name), ['Б', 'В', 'А']);
  assert.deepEqual(L.sortProspects(rows, 'name_asc').map((r) => r.name), ['А', 'Б', 'В']);
});

// ─────────────────────────── сервис ───────────────────────────

function city() {
  return setup(
    [
      P('p1', { name: 'Ева', bookingSystem: 'altegio', staffEstimate: 8, district: 'kentron', category: 'nails' }),
      P('p2', { name: 'Гарни', bookingSystem: 'emly', staffEstimate: 3, district: 'arabkir', category: 'barber' }),
      P('p3', { name: 'Лилит', bookingSystem: 'phone_whatsapp', staffEstimate: null, district: 'kentron', category: 'hair' }),
      P('p4', { name: 'Ноян SPA', bookingSystem: 'altegio', staffEstimate: 15, district: 'avan', category: 'massage_spa' }),
    ],
    [V('v1', 'p1', 'thinking', '2026-09-10'), V('v2', 'p1', 'refused', '2026-09-25'), V('v3', 'p4', 'connected', '2026-09-12', 'biz_9'), V('v4', 'p2', 'thinking', '2026-09-01')],
  );
}

test('список: фильтр по системам (мультивыбор), сфере, району, мастеров от/до, статусу, поиску', async () => {
  const { svc } = city();
  const ids = async (f: Parameters<typeof svc.list>[0]) => (await svc.list(f)).items.map((i) => i.id);
  assert.deepEqual(await ids({ systems: ['altegio'] }), ['p4', 'p1']);
  assert.deepEqual(await ids({ systems: ['altegio', 'emly'], sort: 'name_asc' }), ['p2', 'p1', 'p4']);
  assert.deepEqual(await ids({ category: 'barber' }), ['p2']);
  assert.deepEqual(await ids({ district: 'kentron' }), ['p1', 'p3']);
  assert.deepEqual(await ids({ staffMin: 5 }), ['p4', 'p1']);
  assert.deepEqual(await ids({ staffMin: 1, staffMax: 10 }), ['p1', 'p2']);
  assert.deepEqual(await ids({ status: 'refused' }), ['p1']);
  assert.deepEqual(await ids({ status: 'live' }), ['p4']);
  assert.deepEqual(await ids({ status: 'new' }), ['p3']);
  assert.deepEqual(await ids({ q: 'ноян' }), ['p4']);
});

test('список: сортировка по мастерам по умолчанию, страницы и счётчики систем без фильтра системы', async () => {
  const { svc } = city();
  const res = await svc.list({ district: 'kentron', systems: ['altegio'], pageSize: 1, page: 1 });
  assert.equal(res.total, 1);
  assert.equal(res.systemCounts.altegio, 1);
  assert.equal(res.systemCounts.phone_whatsapp, 1, 'счётчик системы считается при остальных фильтрах, но без самой системы');
  assert.equal(res.systemCounts.emly, 0);
  assert.equal(res.totalAll, 4);
  const all = await svc.list({ pageSize: 2, page: 2 });
  assert.deepEqual(all.items.map((i) => i.id), ['p2', 'p3'], 'p4 (15) → p1 (8) | p2 (3) → p3 (неизвестно)');
  assert.equal(all.items[0]!.status, 'thinking');
  assert.equal(all.items[0]!.lastVisit?.id, 'v4');
});

test('импорт: добавляет новое, обновляет по ключу «имя|адрес», не стирает пустым, пропускает плохие строки', async () => {
  const { svc, prisma } = setup([P('p1', { name: 'Nail Bar', address: 'Комитаса 5', bookingSystem: 'unknown', phone: '+37410111111', note: 'ручная заметка', sourceUrls: ['https://old'] })]);
  const report = await svc.import([
    { name: 'nail bar', address: 'комитаса, 5', booking_system: 'emly', staff_estimate: 6, source_urls: ['https://new'] },
    { name: 'Barber Point', district: 'nor_nork', category: 'barber', booking_system: 'dikidi', source_urls: [] },
    { name: 'Barber Point', district: 'nor_nork', staff_estimate: 4 },
    { category: 'nails' },
    42,
  ]);
  assert.deepEqual(report, { added: 1, updated: 1, unchanged: 0, skipped: 2, errors: [{ index: 3, reason: 'name_required' }, { index: 4, reason: 'not_object' }] });
  const p1 = prisma.prospect.rows.find((r) => r.id === 'p1')!;
  assert.equal(p1.bookingSystem, 'emly');
  assert.equal(p1.staffEstimate, 6);
  assert.equal(p1.phone, '+37410111111', 'пустое в импорте не стирает телефон');
  assert.equal(p1.note, 'ручная заметка', 'заметку импорт не трогает');
  assert.deepEqual(p1.sourceUrls, ['https://old', 'https://new']);
  assert.equal(p1.version, 2);
  const bp = prisma.prospect.rows.find((r) => r.name === 'Barber Point')!;
  assert.equal(bp.district, 'nor-nork');
  assert.equal(bp.staffEstimate, 4, 'повтор в том же файле слился с первой строкой');
  const again = await svc.import([{ name: 'Barber Point', district: 'nor_nork' }]);
  assert.deepEqual(again, { added: 0, updated: 0, unchanged: 1, skipped: 0, errors: [] });
});

test('импорт большого файла: обновления идут порциями по 50 с запасом времени, все строки обновлены', async () => {
  const existing = Array.from({ length: 120 }, (_, i) => P(`p${i}`, { name: `Salon ${i}`, address: `Комитаса ${i}` }));
  const { svc, prisma } = setup(existing);
  const report = await svc.import(existing.map((_, i) => ({ name: `Salon ${i}`, address: `Комитаса ${i}`, staff_estimate: i + 1 })));
  assert.equal(report.updated, 120);
  assert.deepEqual(prisma.batches.map((b) => b.size), [50, 50, 20]);
  assert.ok(prisma.batches.every((b) => (b.timeout ?? 0) >= 30_000), 'транзакции не с лимитом 5 с по умолчанию');
  assert.equal(prisma.prospect.rows.find((r) => r.id === 'p119')!.staffEstimate, 120);
});

test('удаление места снимает связь у визитов, визиты остаются', async () => {
  const { svc, prisma } = city();
  await svc.remove('p1');
  assert.equal(prisma.prospect.rows.some((r) => r.id === 'p1'), false);
  assert.equal(prisma.salesVisit.rows.filter((v) => v.prospectId === null).length, 2);
});

test('экспорт CSV: заголовки как в импорте, статус и последний визит', async () => {
  const { svc } = city();
  const res = await svc.exportCsv({ systems: ['altegio'] });
  assert.equal(res.rows, 2);
  const lines = res.csv.replace('﻿', '').trim().split('\r\n');
  assert.ok(lines[0]!.startsWith('name;category;district;address'));
  assert.ok(lines[1]!.startsWith('Ноян SPA;massage_spa;avan'));
  assert.ok(lines[1]!.includes(';live;2026-09-12;'));
});
