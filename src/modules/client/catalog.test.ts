/** Каталог «кто когда свободен»: мастерские заказов (04.10.2026) — когда попадают, когда нет, где в списке (база — в памяти). Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { CatalogService } = await import('./catalog.service.js');
const { nowLocal } = await import('../../common/time/time.js');
type Ctor = ConstructorParameters<typeof CatalogService>;

type Row = Record<string, unknown>;

function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = r[k];
    if (v === null) return cur === null || cur === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(cur)) return false;
      if ('not' in o && (o.not === null ? cur === null || cur === undefined : cur === o.not)) return false;
      return true;
    }
    return cur === v;
  });
}

function memoryPrisma(tables: Record<string, Row[]>) {
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
  });
  return Object.fromEntries(['business', 'location', 'staff', 'workSchedule', 'service', 'booking'].map((n) => [n, table(n)]));
}

const today = nowLocal().slice(0, 10);
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const business = (id: string, name: string, sphereIds: string[], extra: Row = {}): Row => ({
  id, kind: 'salon', name, slug: id, sphereIds, networkId: null, ownerStaffId: `${id}-owner`, phone: '+37410000000', description: null, logoUrl: null, photos: [],
  status: 'active', createdAt: new Date('2026-01-01T00:00:00Z'), forbidHomeBookingsDuringShift: false, socials: null, bookingRules: null, brandName: null,
  ordersEnabled: null, orderPickupReminders: null, version: 1, ...extra,
});
const location = (businessId: string, district = 'kentron'): Row => ({
  id: `${businessId}-loc`, businessId, name: { ru: 'Филиал' }, address: { ru: 'ул. Абовяна 1' }, district, yandexMapsUrl: null, lat: null, lng: null,
  phone: null, extraPhones: null, hoursText: null, openHours: null, journalKind: null, tz: 'Asia/Yerevan', version: 1, deletedAt: null,
});
const staff = (id: string, businessId: string, sphereIds: string[], serviceIds: string[] = []): Row => ({
  id, businessId, name: `Мастер ${id}`, phone: '+37491000000', role: 'owner', sphereIds, serviceIds, photos: [], materials: [], workplaces: ['salon'],
  accepts: 'all', calendarVisibility: 'all', calendarMode: 'auto', confirmMode: 'auto', colorIndex: 0, status: 'active', onlineBookingEnabled: true,
  hiddenInJournal: false, assistantOnly: false, deletedAt: null, version: 1, locations: [{ locationId: `${businessId}-loc` }],
});

/** Барбершоп с мастером и окнами (завтра 10:00 или сегодня 18:00), ателье, химчистка с выключенными «Заказами», ремонт без мастеров */
function makeService(opts: { slotDay?: string; tailorBookable?: boolean; tailorNoSlots?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    business: [
      business('barber1', 'Игла Барбер', ['barber']),
      business('tailor1', 'Ателье Игла', ['tailor']),
      business('dry1', 'Химчистка Блеск', ['drycleaning'], { ordersEnabled: false }),
      business('repair1', 'Ремонт Фикс', ['repair'], { status: 'draft' }),
    ],
    location: [location('barber1'), location('tailor1'), location('dry1'), location('repair1')],
    staff: [staff('barber1-owner', 'barber1', ['barber'], ['svc1']), staff('tailor1-owner', 'tailor1', ['tailor']), staff('dry1-owner', 'dry1', ['drycleaning']), staff('repair1-owner', 'repair1', ['repair'])],
    workSchedule: [{ staffId: 'barber1-owner' }],
    service: [{ id: 'svc1', businessId: 'barber1', name: { ru: 'Мужская стрижка' }, durationMin: 30, priceMin: 5000n, priceMax: null, order: 0, kind: 'individual', sphereId: 'barber', active: true, onlineBookable: true, staffIds: ['barber1-owner'] }],
    booking: [],
  };
  if (opts.tailorBookable) {
    // У ателье есть мастер с онлайн-услугой и графиком — бизнес уже в списке обычной карточкой, второй (места) не нужно
    tables.staff![1]!.serviceIds = ['svc1'];
    tables.workSchedule!.push({ staffId: 'tailor1-owner' });
  }
  const day = opts.slotDay ?? tomorrow;
  const availability = {
    nearestSlots: async (businessId: string) =>
      opts.tailorNoSlots && businessId === 'tailor1' ? [] : [{ staffId: 'barber1-owner', locationId: 'barber1-loc', start: `${day}T10:00`, end: `${day}T10:30`, workplace: 'salon' }],
  };
  return new CatalogService(memoryPrisma(tables) as unknown as Ctor[0], availability as unknown as Ctor[1], {} as Ctor[2]);
}

const kinds = (list: Record<string, unknown>[]) => list.map((e) => `${e.kind ?? 'master'}:${(e.business as { id: string }).id}`);

test('сфера «ателье» — мастерская одной карточкой места без окон', async () => {
  const out = await makeService().catalog({ sphereId: 'tailor' });
  assert.deepEqual(kinds(out), ['orders:tailor1']);
  const e = out[0]!;
  assert.deepEqual(e.nearestSlots, []);
  assert.equal(e.hotToday, false);
  const b = e.business as Row;
  assert.equal(b.slug, 'tailor1');
  assert.equal(b.ordersEnabled, true);
  assert.deepEqual(b.sphereIds, ['tailor']);
  assert.equal((e.location as Row).district, 'kentron');
  assert.equal((e.staff as Row).id, 'tailor1-owner');
});

test('по названию и по синониму сферы находится, по чужому слову — нет', async () => {
  const svc = makeService();
  assert.deepEqual(kinds(await svc.catalog({ search: 'игла' })), ['master:barber1', 'orders:tailor1']);
  assert.deepEqual(kinds(await svc.catalog({ search: 'портной' })), ['orders:tailor1']);
  assert.deepEqual(kinds(await svc.catalog({ search: 'маникюр' })), []);
});

test('без поиска и сферы, со «свободно сегодня/завтра» мастерских нет', async () => {
  const svc = makeService();
  assert.deepEqual(kinds(await svc.catalog({})), ['master:barber1']);
  assert.deepEqual(kinds(await svc.catalog({ sphereId: 'tailor', freeTomorrow: true })), []);
  const todaySvc = makeService({ slotDay: today });
  assert.deepEqual(kinds(await todaySvc.catalog({ search: 'игла', freeToday: true })), ['master:barber1']);
  assert.deepEqual(kinds(await todaySvc.catalog({ sphereId: 'tailor', freeToday: true })), []);
});

test('«Заказы» выключены или бизнес не активен — не показываем', async () => {
  const svc = makeService();
  assert.deepEqual(kinds(await svc.catalog({ sphereId: 'drycleaning' })), []);
  assert.deepEqual(kinds(await svc.catalog({ search: 'химчистка' })), []);
  assert.deepEqual(kinds(await svc.catalog({ sphereId: 'repair' })), []);
});

test('мастера с окнами — первыми, мастерские — после; limit режет общий список', async () => {
  const svc = makeService();
  // «игла» — и в «Игла Барбер» (мастер с окнами), и в «Ателье Игла» (мастерская)
  assert.deepEqual(kinds(await svc.catalog({ search: 'игла' })), ['master:barber1', 'orders:tailor1']);
  assert.deepEqual(kinds(await svc.catalog({ search: 'игла', limit: 1 })), ['master:barber1']);
  assert.deepEqual(kinds(await svc.catalog({ sphereId: 'tailor', district: 'arabkir' })), []);
});

test('у мастерской есть мастер с окнами — одна обычная карточка, без дубля места', async () => {
  const out = await makeService({ tailorBookable: true }).catalog({ sphereId: 'tailor' });
  assert.deepEqual(kinds(out), ['master:tailor1']);
});

test('у мастера мастерской есть онлайн-услуга, но окон на 14 дней нет — карточка места, а не пропажа из поиска', async () => {
  const out = await makeService({ tailorBookable: true, tailorNoSlots: true }).catalog({ sphereId: 'tailor' });
  assert.deepEqual(kinds(out), ['orders:tailor1']);
});

test('обычные сферы — как раньше: мастер с окнами, без карточек места', async () => {
  const svc = makeService();
  assert.deepEqual(kinds(await svc.catalog({ sphereId: 'barber' })), ['master:barber1']);
  assert.deepEqual(kinds(await svc.catalog({ sphereId: 'nails' })), []);
});
