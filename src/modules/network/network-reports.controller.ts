import { Body, Controller, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, isLocalDate, localDayRangeUtc } from '../../common/time/time.js';
import { NetworkAccessService } from './network-access.service.js';
import { analyticsQuery, lostClientDaysBody, planCellBody } from './network.schemas.js';

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
  async planExecution(ctx: RequestContext, networkId: string, month: string) {
    const { network } = await this.access.require(ctx, networkId, 'plans');
    const cells = await this.prisma.networkPlanCell.findMany({ where: { networkId, month } });
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
  execution(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Query('month') month: string) {
    return this.svc.planExecution(ctx, n, month);
  }
}
