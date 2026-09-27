import { createHash } from 'node:crypto';
import type { PrismaService } from '../../src/common/prisma.service.js';
import { saveState, type Snapshot } from '../../src/modules/loyalty/port/store.js';
import { emptyState, type LoyaltyState } from '../../src/modules/loyalty/port/state.js';
import type { MockCore } from './mock-core.js';

type Rec = Record<string, unknown>;

/**
 * Этап 21, лейн loyalty: срез «loyalty» мока фронта (src/mock/slices/loyalty.ts, `areaLoyalty` из export-mock.ts) —
 * те же карты, акции с порогами, сертификаты, абонементы (с заморозкой), счета и журнал операций, что видит демо.
 * Пишется тем же port/store.ts, что и сервер при каждом вызове раздела, — формы строк не расходятся. Идемпотентно
 * (upsert). Отдельно от сида: `npx tsx prisma/seed/loyalty.ts` (досеять общую базу разработки, не трогая остальное).
 */
export async function seedLoyaltyFromMock(prisma: PrismaService, core: MockCore): Promise<void> {

  const area = ((core as Rec).areaLoyalty ?? null) as LoyaltyState | null;
  if (area) {
    const state = { ...emptyState(), ...area } as LoyaltyState;
    // id длиннее 32 (VARCHAR(32)) — короче, одинаково во всех ссылках
    let text = JSON.stringify(state);
    const long = new Set<string>();
    for (const key of ['cardTypes', 'cards', 'promotions', 'transactions', 'certificateTypes', 'certificates', 'membershipTypes', 'memberships', 'accountTypes', 'accounts', 'accountOperations', 'onlineOrders'] as const) {
      for (const e of state[key] as { id: string }[]) if (e.id.length > 32) long.add(e.id);
    }
    for (const id of long) text = text.split(`"${id}"`).join(`"${id.split('_')[0]}_${createHash('sha1').update(id).digest('hex').slice(0, 24)}"`);
    const fixed = JSON.parse(text) as LoyaltyState;
    const known = new Set(core.businesses.map((b) => String(b.id)));
    const businessIds = [...new Set([...fixed.cardTypes, ...fixed.certificateTypes, ...fixed.membershipTypes, ...fixed.accountTypes].map((e) => e.businessId))].filter((id) => known.has(id));
    const owners = new Map(core.businesses.map((b) => [String(b.id), String((b as Rec).networkId ?? b.id)]));
    const colls = ['cardTypes', 'cards', 'promotions', 'transactions', 'certificateTypes', 'certificates', 'membershipTypes', 'memberships', 'accountTypes', 'accounts', 'accountOperations', 'onlineOrders'] as const;
    // уже посеянное (повторный сид) — в снимок, чтобы upsert не спотыкался и лишнее не удалялось
    const snapshot: Snapshot = { businessIds, owners, entities: Object.fromEntries(colls.map((c) => [c, new Map<string, string>()])) as Snapshot['entities'], settings: new Map() };
    for (const c of colls) (fixed[c] as { businessId: string }[]).splice(0, Infinity, ...(fixed[c] as { businessId: string }[]).filter((e) => known.has(e.businessId)));
    const serviceBiz = new Map(((core as Rec).services as Rec[] | undefined ?? []).map((s) => [String(s.id), String(s.businessId)]));
    const saved = await prisma.$transaction((db) => saveState(db, snapshot, fixed, businessIds[0] ?? '', (id) => serviceBiz.get(id), 'seed'), { timeout: 120_000 });
    console.log(`seed: лояльность из мока — бизнесов ${businessIds.length}, строк ${saved.written} (карт ${fixed.cards.length}, сертификатов ${fixed.certificates.length}, абонементов ${fixed.memberships.length}, операций ${fixed.transactions.length})`);
  }
}

if (process.argv[1]?.endsWith('seed/loyalty.ts')) {
  const { PrismaService } = await import('../../src/common/prisma.service.js');
  const { loadMockCore } = await import('./mock-core.js');
  await import('dotenv/config');
  const prisma = new PrismaService();
  await seedLoyaltyFromMock(prisma, loadMockCore());
  await prisma.$disconnect();
}
