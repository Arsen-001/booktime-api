import { createHash } from 'node:crypto';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/common/prisma.service.js';
import type { MockCore } from './mock-core.js';

type Rec = Record<string, unknown>;
const J = (v: unknown) => v as Prisma.InputJsonValue;

/** Время мока — «YYYY-MM-DDTHH:mm[:ss]» по Еревану (+04:00, без перехода на летнее) */
function localDate(v: unknown, fallback: Date): Date {
  if (typeof v !== 'string' || !v) return fallback;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(v)) return new Date(v);
  const d = new Date(`${v}+04:00`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const shortId = (prefix: string, key: string) => `${prefix}_${createHash('sha1').update(key).digest('hex').slice(0, 24)}`;

/** Поля AppInstall мока, которые на сервере живут в IntegrationConnection.config (connections.service.ts) */
const CONFIG_KEYS = [
  'authKey', 'senderName', 'senderNameStatus', 'whatsappNumberMode', 'metaTemplatesApproved', 'gaStreams', 'kommoSyncMode', 'kommoDedupe',
  'cascadeOrder', 'negativeReviewIntercept', 'messageBalanceAmd', 'demoLoyaltyStamps', 'fastSignFilledCount', 'paymentHistory', 'lastChatbotTest',
  'interceptedReviewsCount', 'lastRetentionRunCount',
];

/**
 * Этап 21 (сдача, попытка 6): маркетплейс интеграций из среза мока `integrations` — каталог (id совпадают с моком),
 * отзывы, промоблок, демо-подключения первых бизнесов (SMS-агрегатор, WhatsApp, штамп-карта, GA, Kommo, FastSign…)
 * с их настройками. Встроенные приложения у каждого филиала сеет seed.ts (этап 17) — здесь пропускаются.
 * Идемпотентно: каталог — upsert, остальное — детерминированные id + skipDuplicates.
 */
export async function seedIntegrationsFromMock(prisma: PrismaService, core: MockCore): Promise<void> {
  const area = core.areaIntegrations as { apps: Rec[]; installs: Rec[]; reviews: Rec[]; promoBlocks: Rec[] } | undefined;
  if (!area) {
    console.log('seed: интеграции — среза мока нет, пропущено');
    return;
  }
  const now = new Date();
  for (const app of area.apps) {
    const { id, code, categoryId, builtin, hiddenFromCatalog, featuredRank, installsCount, rating, reviewsCount, ...rest } = app;
    const row = {
      code: String(code),
      categoryId: String(categoryId),
      builtin: Boolean(builtin),
      hidden: Boolean(hiddenFromCatalog),
      featuredRank: typeof featuredRank === 'number' ? featuredRank : null,
      installsCount: Number(installsCount ?? 0),
      rating: Number(rating ?? 0),
      reviewsCount: Number(reviewsCount ?? 0),
      data: J({ ...rest, ...(builtin ? { builtin } : {}), ...(hiddenFromCatalog ? { hiddenFromCatalog } : {}) }),
    };
    await prisma.integrationCatalogApp.upsert({ where: { id: String(id) }, create: { id: String(id), ...row }, update: row });
  }

  const locations = new Set((await prisma.location.findMany({ select: { id: true } })).map((l) => l.id));
  const installs = area.installs.filter((i) => !String(i.appId).startsWith('ia_builtin') && locations.has(String(i.locationId)));
  const connections: Prisma.IntegrationConnectionCreateManyInput[] = installs.map((i) => {
    const config: Rec = {};
    for (const k of CONFIG_KEYS) if (i[k] !== undefined) config[k] = i[k];
    return {
      id: shortId('ic', String(i.id)).slice(0, 32),
      businessId: String(i.businessId),
      locationId: String(i.locationId),
      appId: String(i.appId),
      status: String(i.status),
      grantedScopes: J(i.grantedScopes ?? []),
      connectedAt: localDate(i.connectedAt, now),
      activatesBy: i.activatesBy ? localDate(i.activatesBy, now) : null,
      activatedAt: i.activatedAt ? localDate(i.activatedAt, now) : null,
      paidUntil: i.paidUntil ? localDate(i.paidUntil, now) : null,
      systemUserId: i.systemUserId ? shortId('iasu', String(i.systemUserId)).slice(0, 32) : null,
      errorText: (i.errorText as string | undefined) ?? null,
      lastEventAt: i.lastEventAt ? localDate(i.lastEventAt, now) : null,
      lastEventKind: (i.lastEventKind as string | undefined) ?? null,
      ...(i.recentErrors ? { recentErrors: J(i.recentErrors) } : {}),
      ...(Object.keys(config).length ? { config: J(config) } : {}),
    };
  });
  const conn = await prisma.integrationConnection.createMany({ data: connections, skipDuplicates: true });

  const reviews = await prisma.integrationAppReview.createMany({
    data: area.reviews.map((r) => ({
      id: shortId('iarev', String(r.id)).slice(0, 32),
      appId: String(r.appId),
      businessId: String(r.businessId),
      authorName: String(r.authorName),
      rating: Number(r.rating),
      text: String(r.text),
      createdAt: localDate(r.createdAt, now),
    })),
    skipDuplicates: true,
  });

  const promo = await prisma.integrationPromoBlock.createMany({
    data: area.promoBlocks
      .filter((b) => locations.has(String(b.locationId)))
      .map((b) => {
        const { id, businessId, locationId, enabled, createdAt, ...data } = b;
        return { id: shortId('ipb', String(id)).slice(0, 32), businessId: String(businessId), locationId: String(locationId), enabled: Boolean(enabled), data: J(data), createdAt: localDate(createdAt, now) };
      }),
    skipDuplicates: true,
  });
  console.log(`seed: маркетплейс интеграций — каталог ${area.apps.length}, подключений ${conn.count}, отзывов ${reviews.count}, промоблоков ${promo.count}`);
}
