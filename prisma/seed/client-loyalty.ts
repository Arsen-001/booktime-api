import type { PrismaService } from '../../src/common/prisma.service.js';
import type { MockCore } from './mock-core.js';

type Rec = Record<string, unknown>;

/**
 * Этап 21, лейн client-loyalty: витрина покупок приложения (F-14-043/044) и заявки В-17 для демо в режиме api.
 * Как у мока (src/mock/slices/client.ts): у каждого второго бизнеса (порядок core.businesses) первый тип
 * абонемента и первый тип сертификата «Доступно для продажи онлайн» (F-06-147, `data.onlineSale`), чтобы
 * демо показывало и «есть что купить», и «блока покупок нет». Плюс две заявки клиента au_01 (одна — «Я оплатил»),
 * чтобы у кабинета был экран «Заявки на покупку» с данными. Идемпотентно.
 */
export async function seedClientLoyalty(prisma: PrismaService, core: MockCore): Promise<void> {
  const onSaleBiz: string[] = [];
  let enabled = 0;
  for (const [i, b] of core.businesses.entries()) {
    if (i % 2 !== 0) continue;
    const businessId = String(b.id);
    const mt = (await prisma.membershipType.findMany({ where: { businessId, archived: false }, orderBy: { createdAt: 'asc' } })).find((t) => t.data);
    const ct = (await prisma.certificateType.findMany({ where: { businessId, archived: false }, orderBy: { createdAt: 'asc' } })).find((t) => t.data);
    if (mt?.data) {
      const d = mt.data as Rec;
      await prisma.membershipType.update({ where: { id: mt.id }, data: { data: { ...d, onlineSale: { ...((d.onlineSale as Rec) ?? {}), enabled: true } } as never } });
      enabled++;
    }
    if (ct?.data) {
      const d = ct.data as Rec;
      await prisma.certificateType.update({ where: { id: ct.id }, data: { data: { ...d, onlineSale: { ...((d.onlineSale as Rec) ?? {}), enabled: true } } as never } });
      enabled++;
    }
    if (mt?.data || ct?.data) onSaleBiz.push(businessId);
  }

  // Карты клиентов приложения из образцов этапа 11 (тип без бонусной акции) — на тип бизнеса с кэшбэк-акцией,
  // как в демо у каждой кэшбэк-карты есть правило начисления (F-14-051); без этого блок кэшбэка в приложении пуст
  let moved = 0;
  const cashbackPromos = await prisma.promotion.findMany({ where: { kind: { startsWith: 'cashback' }, active: true } });
  for (const promo of cashbackPromos) {
    const typeId = (promo.cardTypeIds as string[])[0];
    if (!typeId) continue;
    const cards = await prisma.loyaltyCard.findMany({ where: { businessId: promo.businessId, cardTypeId: `lct_${promo.businessId.slice(0, 12)}`, clientId: { not: null } } });
    for (const card of cards) {
      const client = await prisma.client.findUnique({ where: { id: card.clientId! }, select: { appUserId: true } });
      if (!client?.appUserId) continue;
      const data = card.data && typeof card.data === 'object' ? { ...(card.data as Rec), cardTypeId: typeId } : undefined;
      await prisma.loyaltyCard.update({ where: { id: card.id }, data: { cardTypeId: typeId, ...(data ? { data: data as never } : {}) } });
      moved++;
    }
    // клиент приложения этого бизнеса без карты с бонусной программой — выдать (демо «кэшбэк в приложении»)
    const appClients = await prisma.client.findMany({ where: { businessId: promo.businessId, appUserId: { not: null }, deletedAt: null }, orderBy: { id: 'asc' } });
    for (const [i, c] of appClients.entries()) {
      const has = await prisma.loyaltyCard.findFirst({ where: { clientId: c.id, cardTypeId: typeId } });
      if (has) continue;
      const id = `lc_app_${c.id}`.slice(0, 32);
      await prisma.loyaltyCard.upsert({ where: { id }, create: { id, cardTypeId: typeId, businessId: promo.businessId, clientId: c.id, number: `91${String(i + 1).padStart(7, '0')}`, balance: 1200n + BigInt(i * 300) }, update: {} });
      moved++;
    }
  }

  // Заявки В-17 клиента au_01 (если он есть в сиде) в первом бизнесе с витриной
  const user = await prisma.user.findUnique({ where: { id: 'au_01' }, select: { id: true } });
  const businessId = onSaleBiz[0];
  if (user && businessId) {
    const mt = await prisma.membershipType.findFirst({ where: { businessId, archived: false }, orderBy: { createdAt: 'asc' } });
    const ct = await prisma.certificateType.findFirst({ where: { businessId, archived: false }, orderBy: { createdAt: 'asc' } });
    const now = new Date();
    if (mt) {
      const row = { typeId: mt.id, businessId, appUserId: user.id, code: '7700000001', totalVisits: mt.totalVisits, remainingVisits: mt.totalVisits, status: 'pending_confirmation', soldAt: new Date(now.getTime() - 3_600_000), expiresAt: new Date(now.getTime() + mt.validDays * 86_400_000) };
      await prisma.membershipSale.upsert({ where: { id: 'lm_seed_app_req_1' }, create: { id: 'lm_seed_app_req_1', ...row }, update: {} });
    }
    if (ct) {
      const row = { typeId: ct.id, businessId, appUserId: user.id, code: '7700000002', total: ct.faceValue, balance: ct.faceValue, status: 'pending_confirmation', soldAt: new Date(now.getTime() - 7_200_000), expiresAt: new Date(now.getTime() + ct.validDays * 86_400_000) };
      await prisma.certificate.upsert({ where: { id: 'crt_seed_app_req_1' }, create: { id: 'crt_seed_app_req_1', ...row }, update: {} });
      await prisma.loyaltyTx.upsert({ where: { id: 'ltx_seed_app_paid_1' }, create: { id: 'ltx_seed_app_paid_1', businessId, source: 'certificate', refId: 'crt_seed_app_req_1', kind: 'paymentSent', amount: 0n, note: 'client', createdAt: new Date(now.getTime() - 3_000_000) }, update: {} });
    }
  }
  console.log(`seed: витрина покупок приложения — типов на продаже ${enabled} (бизнесов ${onSaleBiz.length}), кэшбэк-карт клиентов приложения ${moved}, заявки В-17 au_01 → ${businessId ?? '—'}`);
}

if (process.argv[1]?.endsWith('seed/client-loyalty.ts')) {
  const { PrismaService } = await import('../../src/common/prisma.service.js');
  const { loadMockCore } = await import('./mock-core.js');
  await import('dotenv/config');
  const prisma = new PrismaService();
  await seedClientLoyalty(prisma, loadMockCore());
  await prisma.$disconnect();
}
