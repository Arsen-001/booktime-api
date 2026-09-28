import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/common/prisma.service.js';
import type { MockCore } from './mock-core.js';

type Rec = Record<string, unknown>;
const J = (v: unknown) => v as Prisma.InputJsonValue;
const DAY = 86_400_000;

function localDate(v: unknown, fallback: Date): Date {
  if (typeof v !== 'string' || !v) return fallback;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(v)) return new Date(v);
  const d = new Date(`${v}+04:00`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function weekKey(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Этап 21 (сдача, попытка 6): сторис, новости подписчикам и продвижение из среза мока `client` — те же бизнесы и
 * статусы (активная шаблонная сторис, фото на проверке, истёкшая; разосланные новости; скидка на горящее окно,
 * «выше в поиске»). Фото на проверке получает строку очереди панели. Идемпотентно: детерминированные id.
 */
export async function seedClientPromoFromMock(prisma: PrismaService, core: MockCore): Promise<void> {
  const area = core.areaClientPromo as { stories: Rec[]; newsPosts: Rec[]; promotionSettings: Record<string, Rec> } | undefined;
  if (!area) return;
  const now = new Date();
  const known = new Set((await prisma.business.findMany({ select: { id: true } })).map((b) => b.id));
  let stories = 0;
  let news = 0;
  for (const [i, s] of area.stories.entries()) {
    const businessId = String(s.businessId);
    if (!known.has(businessId)) continue;
    const id = `story_seed_${businessId}_${i}`.slice(0, 32);
    if (await prisma.storyBooking.count({ where: { id } })) continue;
    const createdAt = localDate(s.createdAt, now);
    const photo = s.kind === 'photo';
    let moderationItemId: string | null = null;
    if (photo) {
      moderationItemId = `mod_seed_story_${i}`.slice(0, 32);
      await prisma.moderationItem.createMany({
        data: [{ id: moderationItemId, kind: 'story', businessId, refId: id, imageUrl: String(s.imageUrl ?? ''), paidCoins: Number(s.price ?? 0), status: 'pending', source: 'user', submittedAt: createdAt, history: J([{ id: `${moderationItemId}_e1`, at: String(s.createdAt), kind: 'submitted' }]) }],
        skipDuplicates: true,
      });
    }
    await prisma.storyBooking.create({
      data: {
        id,
        businessId,
        date: createdAt.toISOString().slice(0, 10),
        mode: 'place',
        price: Number(s.price ?? 1500),
        status: 'active',
        source: photo ? 'photo' : 'template',
        moderationItemId,
        views: Number(s.viewCount ?? 0),
        clicks: Number(s.clickCount ?? 0),
        bookingsFromStory: Number(s.bookingCount ?? 0),
        createdAt,
        imageUrl: String(s.imageUrl ?? ''),
        expiresAt: s.expiresAt ? localDate(s.expiresAt, now) : null,
        data: J({ kind: s.kind, lang: s.lang ?? ['ru'], showStaffNames: Boolean(s.showStaffNames), windows: s.windows ?? [], ...(s.caption ? { caption: s.caption } : {}) }),
      },
    });
    stories++;
  }
  for (const [i, p] of area.newsPosts.entries()) {
    const businessId = String(p.businessId);
    if (!known.has(businessId)) continue;
    const id = `nws_seed_${businessId}_${i}`.slice(0, 32);
    const createdAt = localDate(p.createdAt, now);
    const r = await prisma.newsPost.createMany({
      data: [{ id, businessId, weekKey: weekKey(createdAt), text: J({ ru: String(p.text ?? '') }), createdAt, status: String(p.status ?? 'sent'), paidWithCoins: Boolean(p.paidWithCoins), sentAt: (p.status ?? 'sent') === 'sent' ? createdAt : null }],
      skipDuplicates: true,
    });
    news += r.count;
  }
  let promo = 0;
  for (const [businessId, settings] of Object.entries(area.promotionSettings ?? {})) {
    if (!known.has(businessId)) continue;
    const data: Rec = { ...settings };
    for (const k of ['boostSearch', 'boostHome'] as const) {
      const v = data[k] as { active: boolean; expiresAt: string } | undefined;
      if (v) data[k] = { ...v };
    }
    const r = await prisma.businessSetting.createMany({ data: [{ businessId, area: 'client-promotion', data: J(data), updatedBy: 'seed' }], skipDuplicates: true });
    promo += r.count;
  }
  console.log(`seed: сторис ${stories}, новостей ${news}, настроек продвижения ${promo}`);
}
