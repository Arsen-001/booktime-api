import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { ORDER_SPHERES, ordersEnabledOf } from '../orders/order-rules.js';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Сколько держим готовый ответ в памяти процесса (и столько же — Cache-Control для CDN и Next) */
export const SITEMAP_TTL_SEC = 600;
/** Фото салона в sitemap (тег image:image) — только настоящие адреса, не data: URL */
const MAX_IMAGES = 5;

export interface SitemapBusiness {
  slug: string;
  kind: 'salon' | 'individual';
  /** Сферы мастеров, к которым можно записаться (и сферы «Заказов» мастерской) — страницы поиска «сфера» */
  sphereIds: string[];
  /** Районы филиалов — страницы «сфера × район» */
  districts: string[];
  images: string[];
  /** ISO: последнее изменение бизнеса или его видимых мастеров — lastModified */
  updatedAt: string;
}

export interface SitemapMaster {
  id: string;
  businessSlug: string;
  updatedAt: string;
}

export interface SitemapOut {
  businesses: SitemapBusiness[];
  /** Только мастера салонов: у мастера-одиночки своя страница — /b/<slug> */
  masters: SitemapMaster[];
}

const isOrdersSphere = (s: string): boolean => (ORDER_SPHERES as readonly string[]).includes(s);
const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/**
 * Лёгкий список для sitemap.xml сайта (04.10.2026): кто есть в поиске — без расчёта свободных окон, который делает
 * каталог (`GET /v1/public/catalog` считал окна каждому мастеру на 14 дней ради одного списка адресов).
 *
 * Те же правила видимости, что у каталога и публичной страницы: бизнес `active`; мастер `active`, не удалён, онлайн-
 * запись включена, виден в поиске (не «по ссылке» и не «только мои»), есть график и хотя бы одна активная онлайн-услуга.
 * Мастерские «Заказов» (ателье, ремонт, химчистка, детейлинг с включённым разделом) — в списке и без таких мастеров:
 * клиент приносит вещь, а не записывается на время.
 *
 * Ответ кэшируется в памяти процесса на SITEMAP_TTL_SEC: поисковики и сборки сайта не нагружают базу.
 */
@Injectable()
export class SitemapService {
  private cached: { at: number; data: SitemapOut } | null = null;
  private pending: Promise<SitemapOut> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async sitemap(now = Date.now()): Promise<SitemapOut> {
    if (this.cached && now - this.cached.at < SITEMAP_TTL_SEC * 1000) return this.cached.data;
    // Одновременные запросы после истечения кэша ждут один расчёт, а не считают каждый своё
    this.pending ??= this.build()
      .then((data) => {
        this.cached = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Сбросить кэш (тесты) */
  reset(): void {
    this.cached = null;
  }

  private async build(): Promise<SitemapOut> {
    const businesses = await this.prisma.business.findMany({
      where: { status: 'active' },
      select: { id: true, slug: true, kind: true, sphereIds: true, photos: true, ordersEnabled: true, updatedAt: true },
    });
    if (!businesses.length) return { businesses: [], masters: [] };
    const businessIds = businesses.map((b) => b.id);

    const [staffRows, locations, services] = await Promise.all([
      this.prisma.staff.findMany({
        where: { businessId: { in: businessIds }, status: 'active', deletedAt: null, onlineBookingEnabled: true, calendarVisibility: { notIn: ['link', 'mine'] } },
        select: { id: true, businessId: true, sphereIds: true, serviceIds: true, updatedAt: true },
      }),
      this.prisma.location.findMany({ where: { businessId: { in: businessIds }, deletedAt: null }, select: { businessId: true, district: true } }),
      this.prisma.service.findMany({ where: { businessId: { in: businessIds }, active: true, onlineBookable: true }, select: { id: true } }),
    ]);
    const scheduled = staffRows.length
      ? new Set((await this.prisma.workSchedule.findMany({ where: { staffId: { in: staffRows.map((s) => s.id) } }, select: { staffId: true } })).map((r) => r.staffId))
      : new Set<string>();
    const bookable = new Set(services.map((s) => s.id));
    const visibleStaff = staffRows.filter((s) => scheduled.has(s.id) && arr(s.serviceIds).some((id) => bookable.has(id)));

    const staffByBiz = new Map<string, typeof visibleStaff>();
    for (const s of visibleStaff) staffByBiz.set(s.businessId, [...(staffByBiz.get(s.businessId) ?? []), s]);
    const districtsByBiz = new Map<string, Set<string>>();
    for (const l of locations) if (l.district) (districtsByBiz.get(l.businessId) ?? districtsByBiz.set(l.businessId, new Set()).get(l.businessId)!).add(l.district);

    const out: SitemapOut = { businesses: [], masters: [] };
    for (const b of [...businesses].sort((x, y) => x.slug.localeCompare(y.slug))) {
      const staff = staffByBiz.get(b.id) ?? [];
      const ordersSpheres = ordersEnabledOf(b.ordersEnabled, b.sphereIds) ? arr(b.sphereIds).filter(isOrdersSphere) : [];
      if (!staff.length && !ordersSpheres.length) continue;
      const spheres = new Set([...staff.flatMap((s) => arr(s.sphereIds)), ...ordersSpheres]);
      const updatedAt = staff.reduce((d, s) => later(d, s.updatedAt), b.updatedAt);
      const kind = b.kind === 'individual' ? 'individual' : 'salon';
      out.businesses.push({
        slug: b.slug,
        kind,
        sphereIds: [...spheres].sort(),
        districts: [...(districtsByBiz.get(b.id) ?? [])].sort(),
        images: arr<unknown>(b.photos)
          .filter((p): p is string => typeof p === 'string' && /^https?:\/\//.test(p))
          .slice(0, MAX_IMAGES),
        updatedAt: updatedAt.toISOString(),
      });
      if (kind === 'salon') {
        for (const s of [...staff].sort((x, y) => x.id.localeCompare(y.id))) out.masters.push({ id: s.id, businessSlug: b.slug, updatedAt: s.updatedAt.toISOString() });
      }
    }
    return out;
  }
}
