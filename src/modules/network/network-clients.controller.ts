import { Body, Controller, Get, Injectable, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NetworkAccessService } from './network-access.service.js';
import { networkClientSearchBody } from './network.schemas.js';

const ONLINE_SOURCES = ['app', 'link', 'widget'];

export type NetworkImportanceClass = 'gold' | 'silver' | 'bronze' | 'none';

/** F-11-041 importanceOf — то же деление, что в моке (src/api/network.ts) */
export function importanceOf(spend: number): NetworkImportanceClass {
  if (spend >= 100_000) return 'gold';
  if (spend >= 30_000) return 'silver';
  if (spend > 0) return 'bronze';
  return 'none';
}

const clientRowOut = z.object({
  phone: z.string(),
  name: z.string(),
  email: z.string().optional(),
  gender: z.string(),
  spend: z.number(),
  visitsCount: z.number(),
  lastVisitAt: z.string().optional(),
  locationsCount: z.number(),
  memberLocationIds: z.array(z.string()),
  onlineBooked: z.boolean(),
  importance: z.enum(['gold', 'silver', 'bronze', 'none']),
  clientIds: z.array(z.string()),
});

const searchOut = z.object({ rows: z.array(clientRowOut), total: z.number(), page: z.number(), pageSize: z.number() });

const cardOut = z.object({
  phone: z.string(),
  name: z.string(),
  totalSpend: z.number(),
  totalVisits: z.number(),
  locations: z.array(z.object({ businessId: z.string(), businessName: z.string(), clientId: z.string(), spend: z.number(), visitsCount: z.number(), lastVisitAt: z.string().optional() })),
});

/**
 * Общая клиентская база сети (F-11-040…053, docs/backend/02 §15): одна строка — один ТЕЛЕФОН, склеенный по всем
 * Client бизнеса сети (F-11-041), как в моке computeNetworkClientRows. Тонкие фильтры (пол/сумма/визиты/SMS/
 * период без записей — F-11-042), выгрузка (F-11-044) и сообщения/лояльность/счета в карточке (F-11-047…050) —
 * не строены (см. docs/PROGRESS.md «не строил»): поиск по имени/телефону + карточка по локациям — основа раздела.
 */
@Injectable()
export class NetworkClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NetworkAccessService,
  ) {}

  private async rowsFor(businessIds: string[]) {
    if (!businessIds.length) return [];
    const clients = await this.prisma.client.findMany({ where: { businessId: { in: businessIds }, deletedAt: null }, select: { id: true, businessId: true, phone: true, name: true, email: true, gender: true } });
    if (!clients.length) return [];
    const clientIds = clients.map((c) => c.id);
    const [arrivedAgg, onlineRows] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['clientId'], where: { businessId: { in: businessIds }, clientId: { in: clientIds }, status: 'arrived' }, _sum: { total: true }, _count: { _all: true }, _max: { startAt: true } }),
      this.prisma.booking.findMany({ where: { businessId: { in: businessIds }, clientId: { in: clientIds }, source: { in: ONLINE_SOURCES } }, select: { clientId: true }, distinct: ['clientId'] }),
    ]);
    const byClientId = new Map(arrivedAgg.map((a) => [a.clientId!, a]));
    const onlineSet = new Set(onlineRows.map((r) => r.clientId!));
    const byPhone = new Map<
      string,
      { phone: string; name: string; email?: string; gender: string; spend: number; visitsCount: number; lastVisitAt?: string; memberLocationIds: string[]; onlineBooked: boolean; clientIds: string[] }
    >();
    for (const c of clients) {
      const agg = byClientId.get(c.id);
      const spend = Number(agg?._sum.total ?? 0);
      const visitsCount = agg?._count._all ?? 0;
      const lastVisitAt = agg?._max.startAt?.toISOString();
      const online = onlineSet.has(c.id);
      const row = byPhone.get(c.phone);
      if (!row) {
        byPhone.set(c.phone, { phone: c.phone, name: c.name, email: c.email ?? undefined, gender: c.gender, spend, visitsCount, lastVisitAt, memberLocationIds: [c.businessId], onlineBooked: online, clientIds: [c.id] });
      } else {
        row.spend += spend;
        row.visitsCount += visitsCount;
        row.memberLocationIds.push(c.businessId);
        row.onlineBooked = row.onlineBooked || online;
        row.clientIds.push(c.id);
        if (lastVisitAt && (!row.lastVisitAt || lastVisitAt > row.lastVisitAt)) row.lastVisitAt = lastVisitAt;
      }
    }
    return [...byPhone.values()].map((r) => ({ ...r, locationsCount: r.memberLocationIds.length, importance: importanceOf(r.spend) }));
  }

  async search(ctx: RequestContext, networkId: string, input: z.infer<typeof networkClientSearchBody>) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    const scope = input.businessIds?.length ? network.businessIds.filter((id) => input.businessIds!.includes(id)) : network.businessIds;
    let rows = await this.rowsFor(scope);
    const q = input.search?.trim().toLowerCase();
    if (q) {
      const qDigits = q.replace(/\D/g, '');
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (qDigits && r.phone.replace(/\D/g, '').includes(qDigits)) || (r.email ?? '').toLowerCase().includes(q));
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const total = rows.length;
    const page = rows.slice((input.page - 1) * input.pageSize, (input.page - 1) * input.pageSize + input.pageSize);
    return { rows: page, total, page: input.page, pageSize: input.pageSize };
  }

  async card(ctx: RequestContext, networkId: string, phone: string) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    if (!network.businessIds.length) throw new ApiError('not_found', 'Client not found');
    const clients = await this.prisma.client.findMany({ where: { businessId: { in: network.businessIds }, phone, deletedAt: null }, include: { business: { select: { name: true } } } });
    if (!clients.length) throw new ApiError('not_found', 'Client not found');
    const clientIds = clients.map((c) => c.id);
    const agg = await this.prisma.booking.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds }, status: 'arrived' }, _sum: { total: true }, _count: { _all: true }, _max: { startAt: true } });
    const byClientId = new Map(agg.map((a) => [a.clientId!, a]));
    const locations = clients.map((c) => {
      const a = byClientId.get(c.id);
      return { businessId: c.businessId, businessName: c.business.name, clientId: c.id, spend: Number(a?._sum.total ?? 0), visitsCount: a?._count._all ?? 0, lastVisitAt: a?._max.startAt?.toISOString() };
    });
    return { phone, name: clients[0]!.name, totalSpend: locations.reduce((s, l) => s + l.spend, 0), totalVisits: locations.reduce((s, l) => s + l.visitsCount, 0), locations };
  }
}

@ApiTags('network')
@Controller('v1/net/:networkId/clients')
@Authed()
export class NetworkClientsController {
  constructor(private readonly svc: NetworkClientsService) {}

  @Post('search')
  @ApiOperation({ summary: 'Общая база клиентов сети — по телефону, склеено по филиалам (F-11-040…042)' })
  @ZodBody(networkClientSearchBody)
  @ZodOk(searchOut)
  search(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkClientSearchBody)) body: z.infer<typeof networkClientSearchBody>) {
    return this.svc.search(ctx, n, body);
  }

  @Get(':phone')
  @ApiOperation({ summary: 'Карточка клиента сети — сводка по филиалам (F-11-045…050)' })
  @ZodOk(cardOut)
  card(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('phone') phone: string) {
    return this.svc.card(ctx, n, phone);
  }
}
