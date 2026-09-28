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
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { bookingView } from '../journal/journal.views.js';
import { networkClientListBody, networkClientSearchBody } from './network.schemas.js';

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
      { phone: string; name: string; email?: string; gender: string; spend: number; visitsCount: number; lastVisitAt?: string; memberLocationIds: string[]; visitedLocationIds: string[]; onlineBooked: boolean; clientIds: string[] }
    >();
    for (const c of clients) {
      const agg = byClientId.get(c.id);
      const spend = Number(agg?._sum.total ?? 0);
      const visitsCount = agg?._count._all ?? 0;
      const lastVisitAt = agg?._max.startAt?.toISOString();
      const online = onlineSet.has(c.id);
      const row = byPhone.get(c.phone);
      if (!row) {
        byPhone.set(c.phone, { phone: c.phone, name: c.name, email: c.email ?? undefined, gender: c.gender, spend, visitsCount, lastVisitAt, memberLocationIds: [c.businessId], visitedLocationIds: visitsCount ? [c.businessId] : [], onlineBooked: online, clientIds: [c.id] });
      } else {
        row.spend += spend;
        row.visitsCount += visitsCount;
        row.memberLocationIds.push(c.businessId);
        if (visitsCount) row.visitedLocationIds.push(c.businessId);
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

  /**
   * F-11-041/042: вся база сети под фильтрами экрана (тот же набор и порядок проверок, что мок listNetworkClients).
   * Р14: SMS-провайдер ещё заглушка — журнала SMS по клиенту нет, `smsReceivedAt` пуст («получал SMS» — никто).
   */
  async list(ctx: RequestContext, networkId: string, f: z.infer<typeof networkClientListBody>) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    let rows = await this.rowsFor(network.businessIds);
    const q = f.query?.trim().toLowerCase();
    if (q) {
      const qDigits = q.replace(/\D/g, '');
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (qDigits && r.phone.replace(/\D/g, '').includes(qDigits)) || (r.email ?? '').toLowerCase().includes(q));
    }
    if (f.memberLocationIds?.length) rows = rows.filter((r) => f.memberLocationIds!.some((id) => r.memberLocationIds.includes(id)));
    if (f.visitedLocationIds?.length) rows = rows.filter((r) => f.visitedLocationIds!.some((id) => r.visitedLocationIds.includes(id)));
    if (f.gender) rows = rows.filter((r) => r.gender === f.gender);
    if (f.onlineOnly) rows = rows.filter((r) => r.onlineBooked);
    if (f.importance) rows = rows.filter((r) => r.importance === f.importance);
    if (f.spendMin != null) rows = rows.filter((r) => r.spend >= f.spendMin!);
    if (f.spendMax != null) rows = rows.filter((r) => r.spend <= f.spendMax!);
    if (f.visitsMin != null) rows = rows.filter((r) => r.visitsCount >= f.visitsMin!);
    if (f.visitsMax != null) rows = rows.filter((r) => r.visitsCount <= f.visitsMax!);
    const tz = 'Asia/Yerevan';
    const dayOf = (iso?: string) => (iso ? utcToLocalDate(new Date(iso), tz) : undefined);
    if (f.hasBookingsFrom || f.hasBookingsTo) {
      rows = rows.filter((r) => {
        const v = dayOf(r.lastVisitAt);
        if (!v) return false;
        if (f.hasBookingsFrom && v < f.hasBookingsFrom) return false;
        if (f.hasBookingsTo && v > f.hasBookingsTo) return false;
        return true;
      });
    }
    if (f.noBookingsFrom || f.noBookingsTo) {
      rows = rows.filter((r) => {
        const v = dayOf(r.lastVisitAt);
        if (!v) return true;
        return !(f.noBookingsFrom && v >= f.noBookingsFrom);
      });
    }
    if (f.smsReceived === 'received') rows = [];
    const sort = f.sort ?? 'name';
    rows.sort((a, b) => (sort === 'spend' ? b.spend - a.spend : sort === 'visits' ? b.visitsCount - a.visitsCount : a.name.localeCompare(b.name, 'ru')));
    return rows.slice(0, 5000).map((r) => ({ ...r, lastVisitAt: r.lastVisitAt ? utcToLocal(new Date(r.lastVisitAt), tz) : undefined }));
  }

  /** F-11-045 в форме экрана: по филиалам — категория (первый тег), скидка карты лояльности, сумма */
  async cardView(ctx: RequestContext, networkId: string, phone: string) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    const clients = await this.prisma.client.findMany({ where: { businessId: { in: network.businessIds }, phone, deletedAt: null }, include: { business: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
    if (!clients.length) throw new ApiError('not_found', 'Client not found');
    const clientIds = clients.map((c) => c.id);
    const [agg, cards] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds }, status: 'arrived' }, _sum: { total: true } }),
      this.prisma.loyaltyCard.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, data: true } }),
    ]);
    const spendOf = new Map(agg.map((a) => [a.clientId!, Number(a._sum.total ?? 0)]));
    const first = clients[0]!;
    return {
      phone: first.phone,
      name: first.name,
      email: first.email ?? undefined,
      gender: first.gender,
      birthday: first.birthday ?? undefined,
      byLocation: clients.map((c) => ({
        businessId: c.businessId,
        businessName: c.business.name,
        clientId: c.id,
        category: ((c.tags as string[] | null) ?? [])[0] ?? '—',
        discountPct: Number((cards.find((k) => k.clientId === c.id)?.data as { maxPercentDiscount?: number } | null)?.maxPercentDiscount ?? 0),
        spend: spendOf.get(c.id) ?? 0,
      })),
    };
  }

  /** F-11-047: все записи клиента во всех филиалах сети, с названием филиала и услуг (новые сверху) */
  async history(ctx: RequestContext, networkId: string, phone: string) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    if (!network.businessIds.length) return [];
    const clients = await this.prisma.client.findMany({ where: { businessId: { in: network.businessIds }, phone }, select: { id: true } });
    if (!clients.length) return [];
    const [bookings, businesses, locs] = await Promise.all([
      this.prisma.booking.findMany({ where: { clientId: { in: clients.map((c) => c.id) } }, orderBy: { startAt: 'desc' }, take: 500 }),
      this.prisma.business.findMany({ where: { id: { in: network.businessIds } }, select: { id: true, name: true } }),
      this.prisma.location.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { businessId: true, tz: true } }),
    ]);
    const serviceIds = [...new Set(bookings.flatMap((b) => ((b.services as { serviceId?: string }[] | null) ?? []).map((l) => l.serviceId).filter((x): x is string => Boolean(x))))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : [];
    const svcName = new Map(services.map((sv) => [sv.id, (sv.name as { ru?: string } | null)?.ru ?? sv.id]));
    const bizName = new Map(businesses.map((b) => [b.id, b.name]));
    const tzOf = new Map<string, string>();
    for (const l of locs) if (!tzOf.has(l.businessId)) tzOf.set(l.businessId, l.tz);
    return bookings.map((b) => ({
      booking: bookingView(b, tzOf.get(b.businessId) ?? 'Asia/Yerevan'),
      businessId: b.businessId,
      businessName: bizName.get(b.businessId) ?? '—',
      serviceNames: ((b.services as { serviceId?: string }[] | null) ?? []).map((l) => svcName.get(l.serviceId ?? '') ?? l.serviceId ?? ''),
    }));
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

  @Post('list')
  @ApiOperation({ summary: 'Вся база сети под фильтрами экрана (F-11-041/042), до 5000 строк' })
  @ZodBody(networkClientListBody)
  list(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(networkClientListBody)) body: z.infer<typeof networkClientListBody>) {
    return this.svc.list(ctx, n, body);
  }

  @Get(':phone/history')
  @ApiOperation({ summary: 'Все записи клиента во всех филиалах сети (F-11-047)' })
  history(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('phone') phone: string) {
    return this.svc.history(ctx, n, phone);
  }

  @Get(':phone/view')
  @ApiOperation({ summary: 'Карточка клиента сети в форме экрана: категория/скидка/сумма по филиалам (F-11-045)' })
  cardView(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('phone') phone: string) {
    return this.svc.cardView(ctx, n, phone);
  }

  @Get(':phone')
  @ApiOperation({ summary: 'Карточка клиента сети — сводка по филиалам (F-11-045…050)' })
  @ZodOk(cardOut)
  card(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('phone') phone: string) {
    return this.svc.card(ctx, n, phone);
  }
}
