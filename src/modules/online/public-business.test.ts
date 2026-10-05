/** Публичная страница /b/<slug>: мастерская заказов без онлайн-услуг (05.10.2026) — база в памяти. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { OnlineService } = await import('./online.service.js');
type Ctor = ConstructorParameters<typeof OnlineService>;
type Row = Record<string, unknown>;

/** Только равенство и `in` — больше publicBusinessData не просит */
function matches(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      return !('in' in o) || (o.in as unknown[]).includes(r[k]);
    }
    return v === null ? r[k] === null || r[k] === undefined : r[k] === v;
  });
}

function memoryPrisma(tables: Record<string, Row[]>) {
  const table = (name: string) => ({
    findMany: async ({ where }: { where?: Row } = {}) => (tables[name] ?? []).filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => (tables[name] ?? []).find((r) => matches(r, where)) ?? null,
    groupBy: async () => [],
  });
  return Object.fromEntries(['business', 'location', 'staff', 'service', 'serviceCategory', 'bookingLink', 'workSchedule', 'businessSetting', 'onlineRecord', 'booking'].map((n) => [n, table(n)]));
}

const business = (id: string, sphereIds: string[], extra: Row = {}): Row => ({
  id, kind: 'salon', name: id, slug: id, sphereIds, networkId: null, ownerStaffId: `${id}-owner`, phone: '+37410000000', description: null, logoUrl: null, photos: [],
  status: 'active', createdAt: new Date('2026-01-01T00:00:00Z'), forbidHomeBookingsDuringShift: false, socials: null, bookingRules: null, brandName: null,
  ordersEnabled: null, orderPickupReminders: null, version: 1, ...extra,
});
const staff = (businessId: string, serviceIds: string[]): Row => ({
  id: `${businessId}-owner`, businessId, name: 'Мастер', phone: '+37491000000', role: 'owner', sphereIds: [], serviceIds, photos: [], materials: [], workplaces: ['salon'],
  accepts: 'all', calendarVisibility: 'all', status: 'active', onlineBookingEnabled: true, deletedAt: null, version: 1, locations: [],
});

function makeService() {
  const tables: Record<string, Row[]> = {
    business: [business('fixpoint', ['repair']), business('barber', ['barber']), business('atelier-off', ['tailor'], { ordersEnabled: false })],
    location: [],
    staff: [staff('fixpoint', []), staff('barber', ['svc1']), staff('atelier-off', [])],
    service: [{ id: 'svc1', businessId: 'barber', name: { ru: 'Стрижка' }, durationMin: 30, priceMin: 5000n, priceMax: null, order: 0, kind: 'individual', sphereId: 'barber', active: true, onlineBookable: true, staffIds: ['barber-owner'] }],
    serviceCategory: [],
    bookingLink: [],
    workSchedule: [{ businessId: 'barber', staffId: 'barber-owner' }],
    businessSetting: [],
    onlineRecord: [],
    booking: [],
  };
  const moderation = { hiddenRefIds: async () => new Set<string>() };
  return new OnlineService(memoryPrisma(tables) as unknown as Ctor[0], {} as Ctor[1], {} as Ctor[2], {} as Ctor[3], moderation as unknown as Ctor[4]);
}

test('мастерская без онлайн-услуг — страница открывается, ordersEnabled: true, услуг и мастеров нет', async () => {
  const d = await makeService().publicBusinessData('fixpoint');
  assert.equal(d.ordersEnabled, true);
  assert.equal(d.business.ordersEnabled, true);
  assert.deepEqual(d.services, []);
  assert.deepEqual(d.staff, []);
});

test('обычный салон — ordersEnabled: false, запись как раньше', async () => {
  const d = await makeService().publicBusinessData('barber');
  assert.equal(d.ordersEnabled, false);
  assert.equal(d.services.length, 1);
  assert.equal(d.staff.length, 1);
});

test('ателье с выключенными «Заказами» — ordersEnabled: false', async () => {
  const d = await makeService().publicBusinessData('atelier-off');
  assert.equal(d.ordersEnabled, false);
});
