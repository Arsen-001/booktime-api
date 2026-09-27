import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, isLocalDate, utcToLocalDate } from '../../common/time/time.js';
import { locationsOf, localDateAt, requireRange, tzMapOf, wideUtcBounds, type ReportRange } from '../reports/reports-common.js';
import { resolveScopeBusinessIds } from '../loyalty/loyalty.owner.js';

/**
 * Этап 21 (лейн client): отчёты раздела «Приложение» (`src/areas/client/apps/ReportsAppScreen.tsx`,
 * `TeamAppScreen.tsx`, F-14-123…129) — своя, лёгкая форма (6 чисел), НЕ форма большого раздела «Отчёты»
 * (`reports.controller.ts`, `GET .../reports/{name}`, F-12-*): тот реестр уже занят под CSV-выгрузку и
 * свою форму `overview` (там «отменено»/«не пришёл» объединены в один `cancelled`, а здесь нужны раздельно —
 * F-14-123 показывает оба числа). Поэтому — отдельный маленький сервис, не расширение реестра `reports`.
 * День/период считаем в поясе ФИЛИАЛА записи (PLAN §4.1), как `reports-dashboard.service.ts`; у клиента
 * (`Client.createdAt`) своего филиала нет — берём общий пояс сети/бизнеса по умолчанию (Asia/Yerevan), так же
 * не пытаясь считать это по филиалу, как не делает и мок (`dayjs(c.createdAt)` без пояса вовсе).
 */

export interface AppDailyReportMetrics {
  revenue: number;
  bookingsCount: number;
  newClients: number;
  cancelledCount: number;
  noShowCount: number;
  avgCheck: number;
}

const ARRIVED = 'arrived';
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master'];
const NO_SHOW = 'no_show';

@Injectable()
export class AppReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async metricsFor(businessId: string, range: ReportRange): Promise<AppDailyReportMetrics> {
    const locations = await locationsOf(this.prisma, businessId);
    const empty: AppDailyReportMetrics = { revenue: 0, bookingsCount: 0, newClients: 0, cancelledCount: 0, noShowCount: 0, avgCheck: 0 };
    if (!locations.length) return empty;
    const tzMap = tzMapOf(locations);
    const { from, to } = wideUtcBounds(range);

    const [bookingsRaw, clientsRaw] = await Promise.all([
      this.prisma.booking.findMany({
        where: { businessId, locationId: { in: locations.map((l) => l.id) }, startAt: { gte: from, lt: to }, deletedAt: null },
        select: { status: true, total: true, startAt: true, locationId: true },
      }),
      this.prisma.client.findMany({
        where: { businessId, deletedAt: null, createdAt: { gte: from, lt: to } },
        select: { createdAt: true },
      }),
    ]);

    const bookings = bookingsRaw.filter((b) => {
      const d = localDateAt(b.startAt, b.locationId, tzMap);
      return d >= range.from && d <= range.to;
    });
    const newClients = clientsRaw.filter((c) => {
      const d = utcToLocalDate(c.createdAt, DEFAULT_TZ);
      return d >= range.from && d <= range.to;
    }).length;

    const arrived = bookings.filter((b) => b.status === ARRIVED);
    const revenue = arrived.reduce((s, b) => s + Number(b.total), 0);
    return {
      revenue,
      bookingsCount: bookings.length,
      newClients,
      cancelledCount: bookings.filter((b) => CANCELLED.includes(b.status)).length,
      noShowCount: bookings.filter((b) => b.status === NO_SHOW).length,
      avgCheck: arrived.length ? Math.round(revenue / arrived.length) : 0,
    };
  }

  /** F-14-123: сегодня + вчера, одним и тем же расчётом */
  async daily(businessId: string, date: string): Promise<{ today: AppDailyReportMetrics; yesterday: AppDailyReportMetrics }> {
    if (!isLocalDate(date)) throw new ApiError('validation', 'date must be YYYY-MM-DD', { date: 'bad_date' });
    const yesterday = new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    const [today, prev] = await Promise.all([this.metricsFor(businessId, { from: date, to: date }), this.metricsFor(businessId, { from: yesterday, to: yesterday })]);
    return { today, yesterday: prev };
  }

  /** F-14-124: произвольный период */
  async period(businessId: string, from: string, to: string): Promise<AppDailyReportMetrics & { days: number }> {
    const range = requireRange({ from, to });
    const metrics = await this.metricsFor(businessId, range);
    const days = Math.round((Date.parse(`${range.to}T00:00:00.000Z`) - Date.parse(`${range.from}T00:00:00.000Z`)) / 86_400_000) + 1;
    return { ...metrics, days };
  }

  /** F-14-126: «Моя аналитика» одного мастера/администратора — своя выручка и число записей за период */
  async myAnalytics(businessId: string, staffId: string, from: string, to: string): Promise<{ revenue: number; bookingsCount: number }> {
    const range = requireRange({ from, to });
    const locations = await locationsOf(this.prisma, businessId);
    if (!locations.length) return { revenue: 0, bookingsCount: 0 };
    const tzMap = tzMapOf(locations);
    const { from: gte, to: lt } = wideUtcBounds(range);
    const rows = await this.prisma.booking.findMany({
      where: { businessId, staffId, locationId: { in: locations.map((l) => l.id) }, startAt: { gte, lt }, deletedAt: null },
      select: { status: true, total: true, startAt: true, locationId: true },
    });
    const inRange = rows.filter((b) => {
      const d = localDateAt(b.startAt, b.locationId, tzMap);
      return d >= range.from && d <= range.to;
    });
    const revenue = inRange.filter((b) => b.status === ARRIVED).reduce((s, b) => s + Number(b.total), 0);
    return { revenue, bookingsCount: inRange.length };
  }

  /**
   * F-14-129: показатели дня по каждому филиалу сети. `locationIds` мока — на самом деле businessId каждого
   * филиала (в этой модели один филиал = один Business, joined by networkId) — пересекаем с реальными
   * филиалами СЕТИ вызывающего бизнеса, чтобы запрос с чужим businessId в списке не утёк чужие цифры.
   */
  async networkDay(callerBusinessId: string, requestedIds: string[], date: string): Promise<Array<{ businessId: string; name: string; metrics: AppDailyReportMetrics }>> {
    if (!isLocalDate(date)) throw new ApiError('validation', 'date must be YYYY-MM-DD', { date: 'bad_date' });
    const scope = await resolveScopeBusinessIds(this.prisma, callerBusinessId);
    const ids = requestedIds.filter((id) => scope.includes(id));
    if (!ids.length) return [];
    const businesses = await this.prisma.business.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(businesses.map((b) => [b.id, b.name]));
    const results = await Promise.all(ids.map(async (id) => ({ businessId: id, name: nameOf.get(id) ?? id, metrics: await this.metricsFor(id, { from: date, to: date }) })));
    return results;
  }
}
