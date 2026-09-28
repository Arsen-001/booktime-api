import { Body, Controller, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import dayjs from 'dayjs';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, isLocalDate, localDayRangeUtc, utcToLocalDate } from '../../common/time/time.js';
import { bookingView } from '../journal/journal.views.js';
import { serviceView } from '../services/services.views.js';
import { NetworkAccessService } from './network-access.service.js';
import { analyticsQuery, lostClientDaysBody, networkAnalyticsRangeQuery, networkRecordsQuery, planCellBody } from './network.schemas.js';

const summaryOut = z.object({
  from: z.string(),
  to: z.string(),
  totalRevenue: z.number(),
  totalVisits: z.number(),
  totalClients: z.number(),
  byLocation: z.array(z.object({ businessId: z.string(), businessName: z.string(), revenue: z.number(), visits: z.number(), clients: z.number(), newClients: z.number() })),
  byDay: z.array(z.object({ date: z.string(), revenue: z.number(), visits: z.number() })),
});

const planCellOut = z.object({ businessId: z.string(), kind: z.enum(['revenue', 'clients', 'avgCheck']), month: z.string(), value: z.number() });
const analyticsSettingsOut = z.object({ networkId: z.string(), lostClientDays: z.number() });
const planExecutionOut = z.array(planCellOut.extend({ actual: z.number(), pct: z.number() }));

// ─────────── Этап 21 «network+reports», попытка 3 ───────────

const bookingOut = z.record(z.string(), z.unknown());
const analyticsSummaryV2Out = z.object({
  revenue: z.number(),
  revenueDelta: z.number(),
  servicesRevenue: z.number(),
  servicesRevenueDelta: z.number(),
  goodsRevenue: z.number(),
  goodsRevenueDelta: z.number(),
  avgCheck: z.number(),
  avgCheckDelta: z.number(),
  avgCheckServices: z.number(),
  avgCheckServicesDelta: z.number(),
  occupancy: z.number(),
  occupancyDelta: z.number(),
  previous: z.object({ revenue: z.number(), servicesRevenue: z.number(), goodsRevenue: z.number(), avgCheck: z.number(), avgCheckServices: z.number(), occupancy: z.number() }),
});
const analyticsBreakdownOut = z.object({
  newClients: z.number(),
  returningClients: z.number(),
  lostClients: z.number(),
  totalBookings: z.number(),
  cancelledBookings: z.number(),
  completedBookings: z.number(),
  pendingBookings: z.number(),
  bySource: z.record(z.string(), z.number()),
  byStatus: z.record(z.string(), z.number()),
});
const serviceMigrationOut = z.array(z.object({ service: z.record(z.string(), z.unknown()), availableIn: z.array(z.string()) }));

/**
 * Аналитика и планы сети (F-11-062…078, docs/backend/02 §15): сводка «оборот/визиты/клиенты» по реальным
 * Booking (status=arrived, «пришёл · сумма» — F-00-131), день считается в поясе ФИЛИАЛА (PLAN.md §4.1: не
 * общий пояс сети). Углублённые отчёты (по сотрудникам/услугам/параметрам, F-11-069…075) требуют инфраструктуры
 * раздела «Отчёты» (этап 16, ещё не построен) — не строены здесь, см. docs/PROGRESS.md «не строил».
 */
@Injectable()
export class NetworkReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NetworkAccessService,
  ) {}

  private async tzOf(businessId: string): Promise<string> {
    const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
    return loc?.tz ?? DEFAULT_TZ;
  }

  async summary(ctx: RequestContext, networkId: string, input: z.infer<typeof analyticsQuery>) {
    const { network } = await this.access.require(ctx, networkId, 'analytics');
    if (!isLocalDate(input.from) || !isLocalDate(input.to)) throw new ApiError('bad_date', 'from/to must be YYYY-MM-DD');
    const wanted = input.businessIds?.split(',').filter(Boolean);
    const scope = wanted?.length ? network.businessIds.filter((id) => wanted.includes(id)) : network.businessIds;
    const businesses = scope.length ? await this.prisma.business.findMany({ where: { id: { in: scope } }, select: { id: true, name: true } }) : [];
    const byLocation: { businessId: string; businessName: string; revenue: number; visits: number; clients: number; newClients: number }[] = [];
    const byDayMap = new Map<string, { revenue: number; visits: number }>();
    /** Клиент считается сетью один раз по ТЕЛЕФОНУ, даже если пришёл в несколько филиалов (F-11-064) —
     *  Booking не хранит связи client (только clientId), поэтому телефон поднимается отдельным запросом ниже */
    const allArrivedClientIds = new Set<string>();
    for (const b of businesses) {
      const tz = await this.tzOf(b.id);
      const { from } = localDayRangeUtc(input.from, tz);
      const { to } = localDayRangeUtc(input.to, tz);
      const [bookings, newClients] = await Promise.all([
        this.prisma.booking.findMany({ where: { businessId: b.id, status: 'arrived', startAt: { gte: from, lt: to } }, select: { total: true, startAt: true, clientId: true } }),
        this.prisma.client.count({ where: { businessId: b.id, deletedAt: null, createdAt: { gte: from, lt: to } } }),
      ]);
      const revenue = bookings.reduce((s, x) => s + Number(x.total), 0);
      const clientsSet = new Set(bookings.map((x) => x.clientId).filter(Boolean));
      for (const cid of clientsSet) allArrivedClientIds.add(cid!);
      byLocation.push({ businessId: b.id, businessName: b.name, revenue, visits: bookings.length, clients: clientsSet.size, newClients });
      for (const bk of bookings) {
        const day = bk.startAt.toISOString().slice(0, 10);
        const cell = byDayMap.get(day) ?? { revenue: 0, visits: 0 };
        cell.revenue += Number(bk.total);
        cell.visits += 1;
        byDayMap.set(day, cell);
      }
    }
    const phoneRows = allArrivedClientIds.size ? await this.prisma.client.findMany({ where: { id: { in: [...allArrivedClientIds] } }, select: { phone: true } }) : [];
    const networkClientPhones = new Set(phoneRows.map((r) => r.phone));
    const byDay = [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
    return {
      from: input.from,
      to: input.to,
      totalRevenue: byLocation.reduce((s, l) => s + l.revenue, 0),
      totalVisits: byLocation.reduce((s, l) => s + l.visits, 0),
      totalClients: networkClientPhones.size,
      byLocation,
      byDay,
    };
  }

  async getLostClientDays(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'analytics');
    return { networkId, lostClientDays: network.lostClientDays };
  }

  async setLostClientDays(ctx: RequestContext, networkId: string, days: number) {
    await this.access.require(ctx, networkId, 'analytics');
    await this.prisma.network.update({ where: { id: networkId }, data: { lostClientDays: days, version: { increment: 1 } } });
    return { networkId, lostClientDays: days };
  }

  async listPlans(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'plans');
    if (!network.businessIds.length) return [];
    const rows = await this.prisma.networkPlanCell.findMany({ where: { networkId } });
    return rows.map((r) => ({ businessId: r.businessId, kind: r.kind as 'revenue' | 'clients' | 'avgCheck', month: r.month, value: Number(r.value) }));
  }

  async setPlanCell(ctx: RequestContext, networkId: string, input: z.infer<typeof planCellBody>) {
    const { network } = await this.access.require(ctx, networkId, 'plans');
    if (!network.businessIds.includes(input.businessId)) throw new ApiError('validation', 'business not in network');
    await this.prisma.networkPlanCell.upsert({
      where: { networkId_businessId_kind_month: { networkId, businessId: input.businessId, kind: input.kind, month: input.month } },
      create: { networkId, businessId: input.businessId, kind: input.kind, month: input.month, value: input.value, updatedBy: ctx.session!.userId },
      update: { value: input.value, updatedBy: ctx.session!.userId },
    });
    return { businessId: input.businessId, kind: input.kind, month: input.month, value: input.value };
  }

  /** F-11-068: выполнение плана — факт по тому же kind за месяц против плановой цифры */
  async planExecution(ctx: RequestContext, networkId: string, month: string, kind?: 'revenue' | 'clients' | 'avgCheck') {
    const { network } = await this.access.require(ctx, networkId, 'plans');
    const saved = await this.prisma.networkPlanCell.findMany({ where: { networkId, month, ...(kind ? { kind } : {}) } });
    // Этап 21 (сдача): с `kind` — строка на КАЖДЫЙ филиал сети (план 0, если не задан), как экран «Выполнение плана»
    const cells = kind
      ? network.businessIds.map((businessId) => saved.find((c) => c.businessId === businessId) ?? { businessId, kind, month, value: 0n })
      : saved;
    const out: { businessId: string; kind: 'revenue' | 'clients' | 'avgCheck'; month: string; value: number; actual: number; pct: number }[] = [];
    for (const cell of cells) {
      if (!network.businessIds.includes(cell.businessId)) continue;
      const tz = await this.tzOf(cell.businessId);
      const from = localDayRangeUtc(`${month}-01`, tz).from;
      const y = Number(month.slice(0, 4));
      const m = Number(month.slice(5, 7));
      const nextMonthDate = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
      const to = localDayRangeUtc(nextMonthDate, tz).from;
      const bookings = await this.prisma.booking.findMany({ where: { businessId: cell.businessId, status: 'arrived', startAt: { gte: from, lt: to } }, select: { total: true, clientId: true } });
      let actual = 0;
      if (cell.kind === 'revenue') actual = bookings.reduce((s, x) => s + Number(x.total), 0);
      else if (cell.kind === 'clients') actual = new Set(bookings.map((x) => x.clientId).filter(Boolean)).size;
      else actual = bookings.length ? Math.round(bookings.reduce((s, x) => s + Number(x.total), 0) / bookings.length) : 0;
      const planned = Number(cell.value);
      out.push({ businessId: cell.businessId, kind: cell.kind as 'revenue' | 'clients' | 'avgCheck', month, value: planned, actual, pct: planned > 0 ? Math.round((actual / planned) * 100) : 0 });
    }
    return out;
  }

  // ─────────── Этап 21 «network+reports», попытка 3 ───────────
  // `src/api/network.ts::listNetworkRecords`/`getNetworkAnalyticsSummary`/`getNetworkAnalyticsBreakdown`/
  // `listServiceMigrationRows` — контракт мока 1:1 (дельты к прошлому периоду, разбивка по статусу/источнику),
  // отдельный от `summary()`/`byLocation` выше (тот отчёт уже стоит своим путём, ничего его не зовёт с фронта).
  // День бронирования — местный (пояс ФИЛИАЛА, PLAN.md §4.1), не общий пояс сети.

  private async tzMap(businessIds: string[]): Promise<Map<string, string>> {
    if (!businessIds.length) return new Map();
    const locs = await this.prisma.location.findMany({ where: { businessId: { in: businessIds }, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { businessId: true, tz: true } });
    const map = new Map<string, string>();
    for (const l of locs) if (!map.has(l.businessId)) map.set(l.businessId, l.tz);
    return map;
  }

  /** F-11-075: записи сети — построчно, тот же `bookingView()`, что и обычный журнал */
  async records(ctx: RequestContext, networkId: string, filters: z.infer<typeof networkRecordsQuery>) {
    const { network } = await this.access.require(ctx, networkId, 'records');
    const businessIds = filters.businessId ? (network.businessIds.includes(filters.businessId) ? [filters.businessId] : []) : network.businessIds;
    if (!businessIds.length) return [];
    const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, deletedAt: null } });
    const tzByBiz = await this.tzMap(businessIds);
    return rows
      .filter((b) => {
        const tz = tzByBiz.get(b.businessId) ?? DEFAULT_TZ;
        const day = utcToLocalDate(b.startAt, tz);
        if (filters.from && day < filters.from) return false;
        if (filters.to && day > filters.to) return false;
        if (filters.onlineOnly && !ONLINE_SOURCES.has(b.source)) return false;
        if (filters.cancelled === 'cancelled' && !CANCELLED_STATUSES.has(b.status)) return false;
        if (filters.cancelled === 'notCancelled' && CANCELLED_STATUSES.has(b.status)) return false;
        return true;
      })
      .map((b) => bookingView(b, tzByBiz.get(b.businessId) ?? DEFAULT_TZ));
  }

  /** Оборот/средний чек/загрузка за период — те же слагаемые, что мок `summaryFor()` */
  private async summaryFor(businessIds: string[], from: string, to: string) {
    if (!businessIds.length) return { revenue: 0, servicesRevenue: 0, goodsRevenue: 0, avgCheck: 0, avgCheckServices: 0, occupancy: 0 };
    const tzByBiz = await this.tzMap(businessIds);
    const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, status: 'arrived' }, select: { businessId: true, startAt: true, durationMin: true, total: true, services: true } });
    const arrived = rows.filter((b) => {
      const day = utcToLocalDate(b.startAt, tzByBiz.get(b.businessId) ?? DEFAULT_TZ);
      return day >= from && day <= to;
    });
    const servicesRevenue = arrived.reduce((sum, b) => {
      const lines = Array.isArray(b.services) ? (b.services as { price: number; qty: number }[]) : [];
      return sum + lines.reduce((s, line) => s + Number(line.price) * Number(line.qty), 0);
    }, 0);
    const revenue = arrived.reduce((sum, b) => sum + Number(b.total), 0);
    const goodsRevenue = Math.max(0, revenue - servicesRevenue);
    const avgCheck = arrived.length ? revenue / arrived.length : 0;
    const avgCheckServices = arrived.length ? servicesRevenue / arrived.length : 0;
    const workedMinutes = arrived.reduce((sum, b) => sum + b.durationMin, 0);
    const staffCount = (await this.prisma.staff.count({ where: { businessId: { in: businessIds }, status: 'active', deletedAt: null } })) || 1;
    const periodDays = Math.max(1, daysBetweenLocal(from, to));
    const availableMinutes = staffCount * periodDays * 8 * 60;
    const occupancy = availableMinutes ? Math.min(100, Math.round((workedMinutes / availableMinutes) * 100)) : 0;
    return { revenue, servicesRevenue, goodsRevenue, avgCheck, avgCheckServices, occupancy };
  }

  /** F-11-062/063: сводка сети с дельтами к предыдущему такому же периоду (мок `getNetworkAnalyticsSummary`) */
  async analyticsSummaryV2(ctx: RequestContext, networkId: string, input: z.infer<typeof networkAnalyticsRangeQuery>) {
    const { network } = await this.access.require(ctx, networkId, 'analytics');
    const span = daysBetweenLocal(input.from, input.to);
    const prevTo = dayjs(input.from).subtract(1, 'day').format('YYYY-MM-DD');
    const prevFrom = dayjs(input.from).subtract(span, 'day').format('YYYY-MM-DD');
    const cur = await this.summaryFor(network.businessIds, input.from, input.to);
    const prev = await this.summaryFor(network.businessIds, prevFrom, prevTo);
    return {
      revenue: cur.revenue,
      revenueDelta: deltaPct(cur.revenue, prev.revenue),
      servicesRevenue: cur.servicesRevenue,
      servicesRevenueDelta: deltaPct(cur.servicesRevenue, prev.servicesRevenue),
      goodsRevenue: cur.goodsRevenue,
      goodsRevenueDelta: deltaPct(cur.goodsRevenue, prev.goodsRevenue),
      avgCheck: cur.avgCheck,
      avgCheckDelta: deltaPct(cur.avgCheck, prev.avgCheck),
      avgCheckServices: cur.avgCheckServices,
      avgCheckServicesDelta: deltaPct(cur.avgCheckServices, prev.avgCheckServices),
      occupancy: cur.occupancy,
      occupancyDelta: deltaPct(cur.occupancy, prev.occupancy),
      previous: prev,
    };
  }

  /** F-11-064…073: клиенты новые/вернувшиеся/потерянные + разбивка записей (мок `getNetworkAnalyticsBreakdown`) */
  async analyticsBreakdown(ctx: RequestContext, networkId: string, input: z.infer<typeof networkAnalyticsRangeQuery>) {
    const { network } = await this.access.require(ctx, networkId, 'analytics');
    const businessIds = network.businessIds;
    if (!businessIds.length) return { newClients: 0, returningClients: 0, lostClients: 0, totalBookings: 0, cancelledBookings: 0, completedBookings: 0, pendingBookings: 0, bySource: {}, byStatus: {} };
    const tzByBiz = await this.tzMap(businessIds);
    const rows = await this.prisma.booking.findMany({ where: { businessId: { in: businessIds } }, select: { businessId: true, startAt: true, status: true, source: true, clientId: true } });
    const withDay = rows.map((b) => ({ ...b, day: utcToLocalDate(b.startAt, tzByBiz.get(b.businessId) ?? DEFAULT_TZ) }));
    const inPeriod = withDay.filter((b) => b.day >= input.from && b.day <= input.to);
    const arrived = inPeriod.filter((b) => b.status === 'arrived');
    const clientIds = [...new Set(withDay.filter((b) => b.status === 'arrived' && b.clientId).map((b) => b.clientId!))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, phone: true } }) : [];
    const phoneOf = new Map(clients.map((c) => [c.id, c.phone]));
    const firstVisitByPhone = new Map<string, string>();
    const lastVisitByPhone = new Map<string, string>();
    for (const b of withDay) {
      if (b.status !== 'arrived') continue;
      const phone = b.clientId ? phoneOf.get(b.clientId) : undefined;
      if (!phone) continue;
      const first = firstVisitByPhone.get(phone);
      if (!first || b.day < first) firstVisitByPhone.set(phone, b.day);
      const last = lastVisitByPhone.get(phone);
      if (!last || b.day > last) lastVisitByPhone.set(phone, b.day);
    }
    const phonesInPeriod = new Set(arrived.map((b) => (b.clientId ? phoneOf.get(b.clientId) : undefined)).filter((p): p is string => Boolean(p)));
    let newClients = 0;
    let returningClients = 0;
    for (const phone of phonesInPeriod) {
      const first = firstVisitByPhone.get(phone);
      if (first && first >= input.from) newClients += 1;
      else returningClients += 1;
    }
    const cutoff = dayjs(input.to).subtract(network.lostClientDays, 'day').format('YYYY-MM-DD');
    let lostClients = 0;
    for (const [, last] of lastVisitByPhone) if (last <= cutoff) lostClients += 1;
    const bySource: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const b of inPeriod) {
      bySource[b.source] = (bySource[b.source] ?? 0) + 1;
      byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
    }
    return {
      newClients,
      returningClients,
      lostClients,
      totalBookings: inPeriod.length,
      cancelledBookings: inPeriod.filter((b) => CANCELLED_LIKE.has(b.status)).length,
      completedBookings: arrived.length,
      pendingBookings: inPeriod.filter((b) => PENDING_LIKE.has(b.status)).length,
      bySource,
      byStatus,
    };
  }

  /** F-11-087: таблица «Услуга / Доступно в локациях» — услуги сети, сгруппированные по ИМЕНИ (мок `nameKeyOf`) */
  async serviceMigration(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'services');
    if (!network.businessIds.length) return [];
    const services = await this.prisma.service.findMany({ where: { businessId: { in: network.businessIds } } });
    const byName = new Map<string, { service: (typeof services)[number]; availableIn: string[] }>();
    for (const s of services) {
      const key = ((s.name as { ru?: string })?.ru ?? '').trim() || s.id;
      const row = byName.get(key);
      if (row) row.availableIn.push(s.businessId);
      else byName.set(key, { service: s, availableIn: [s.businessId] });
    }
    return [...byName.values()].map((r) => ({ service: serviceView(r.service), availableIn: r.availableIn }));
  }
}

const ONLINE_SOURCES = new Set(['app', 'link', 'widget']);
const CANCELLED_STATUSES = new Set(['no_show', 'cancelled_by_client', 'cancelled_by_master']);
const CANCELLED_LIKE = new Set(['no_show', 'cancelled_by_client', 'cancelled_by_master', 'deleted']);
const PENDING_LIKE = new Set(['awaiting_confirmation', 'scheduled']);

function daysBetweenLocal(from: string, to: string): number {
  return dayjs(to).diff(dayjs(from), 'day') + 1;
}

/** Мок `delta()`: прошлого периода 0 — «было 0» отдаётся как 100% при ненулевом текущем, иначе 0 */
function deltaPct(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

@ApiTags('network')
@Controller('v1/net/:networkId')
@Authed()
export class NetworkReportsController {
  constructor(private readonly svc: NetworkReportsService) {}

  @Get('reports/summary')
  @ApiOperation({ summary: 'Сводный отчёт сети — оборот/визиты/клиенты по филиалам и дням (F-11-063…066)' })
  @ZodOk(summaryOut)
  summary(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query(new Zod(analyticsQuery)) query: z.infer<typeof analyticsQuery>) {
    return this.svc.summary(ctx, n, query);
  }

  @Get('analytics/settings')
  @ZodOk(analyticsSettingsOut)
  lostClientDays(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.getLostClientDays(ctx, n);
  }

  @Patch('analytics/settings')
  @ZodBody(lostClientDaysBody)
  @ZodOk(analyticsSettingsOut)
  setLostClientDays(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(lostClientDaysBody)) body: z.infer<typeof lostClientDaysBody>) {
    return this.svc.setLostClientDays(ctx, n, body.days);
  }

  @Get('plans')
  @ZodOk(z.array(planCellOut))
  listPlans(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listPlans(ctx, n);
  }

  @Post('plans')
  @ApiOperation({ summary: 'Ввод плана по филиалу/месяцу (F-11-077/078)' })
  @ZodBody(planCellBody)
  @ZodOk(planCellOut)
  setPlan(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(planCellBody)) body: z.infer<typeof planCellBody>) {
    return this.svc.setPlanCell(ctx, n, body);
  }

  @Get('plans/execution')
  @ApiOperation({ summary: 'Выполнение плана (F-11-068)' })
  @ZodOk(planExecutionOut)
  execution(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query('month') month: string, @Query('kind') kind?: string) {
    if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new ApiError('validation', 'month must be YYYY-MM');
    const k = kind === 'revenue' || kind === 'clients' || kind === 'avgCheck' ? kind : undefined;
    return this.svc.planExecution(ctx, n, month, k);
  }

  // ─────────── Этап 21 «network+reports», попытка 3 ───────────

  @Get('records')
  @ApiOperation({ summary: 'Записи сети, построчно (F-11-075)' })
  @ZodOk(z.array(bookingOut))
  records(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query(new Zod(networkRecordsQuery)) query: z.infer<typeof networkRecordsQuery>) {
    return this.svc.records(ctx, n, query);
  }

  @Get('analytics/summary-v2')
  @ApiOperation({ summary: 'Сводка сети с дельтами к прошлому периоду (F-11-062/063)' })
  @ZodOk(analyticsSummaryV2Out)
  analyticsSummaryV2(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query(new Zod(networkAnalyticsRangeQuery)) query: z.infer<typeof networkAnalyticsRangeQuery>) {
    return this.svc.analyticsSummaryV2(ctx, n, query);
  }

  @Get('analytics/breakdown')
  @ApiOperation({ summary: 'Клиенты новые/вернувшиеся/потерянные, разбивка записей (F-11-064…073)' })
  @ZodOk(analyticsBreakdownOut)
  analyticsBreakdown(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query(new Zod(networkAnalyticsRangeQuery)) query: z.infer<typeof networkAnalyticsRangeQuery>) {
    return this.svc.analyticsBreakdown(ctx, n, query);
  }

  @Get('service-migration')
  @ApiOperation({ summary: 'Таблица «Услуга / Доступно в локациях» (F-11-087)' })
  @ZodOk(serviceMigrationOut)
  serviceMigration(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.serviceMigration(ctx, n);
  }
}
