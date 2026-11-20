import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { RequestContext } from '../../common/http/context.js';
import { MEMBERSHIP_RESOLVER, type MembershipResolver } from '../../common/http/resolvers.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, nowLocal, utcToLocal } from '../../common/time/time.js';
import { getClientsBizSettings } from './clients-settings.helper.js';

/** Ещё не итоговые статусы записи (ACTIVE_STATUSES ядра сайта) */
const ACTIVE_STATUSES = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];

type Visit = { id: string; businessId: string; clientId: string | null; staffId: string; lineStaffIds: string[]; status: string; start: string; total: number; durationMin: number };

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function groupByClient(visits: Visit[]): Map<string, Visit[]> {
  const map = new Map<string, Visit[]>();
  for (const v of visits) map.set(v.clientId!, [...(map.get(v.clientId!) ?? []), v]);
  return map;
}

/** F-04-123/124/185: «потерян» — был визит когда-либо, и от последнего до `asOf` прошло больше `afterDays` (countLost сайта) */
function countLost(byClient: Map<string, Visit[]>, asOf: string, afterDays: number): number {
  const cutoff = addDays(asOf, -afterDays);
  let count = 0;
  byClient.forEach((list) => {
    const last = list.reduce((max, v) => (v.start > max ? v.start : max), list[0]!.start);
    if (last.slice(0, 10) < cutoff) count += 1;
  });
  return count;
}

/**
 * Сводка клиентов (F-04-123…125/163/185, /biz/clients/summary) и «отметьте визиты» (F-00-127) — на сервере.
 * Раньше браузер тянул все визиты салона «пришёл/не пришёл» (221 КБ) и всех клиентов (43 КБ) и считал у себя
 * (apiGetCrmSummary сайта); правила — те же, что getCrmSummary мока.
 */
@Injectable()
export class ClientsSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEMBERSHIP_RESOLVER) private readonly memberships: MembershipResolver,
  ) {}

  /** Пояс каждого филиала — время визита по местному, как у сайта */
  private async tzOf(businessIds: string[]): Promise<(locationId: string) => string> {
    const rows = await this.prisma.location.findMany({ where: { businessId: { in: businessIds } }, select: { id: true, tz: true } });
    const map = new Map(rows.map((r) => [r.id, r.tz ?? DEFAULT_TZ]));
    return (id) => map.get(id) ?? DEFAULT_TZ;
  }

  private async visits(where: Prisma.BookingWhereInput & { businessId: string | { in: string[] } }): Promise<Visit[]> {
    const rows = await this.prisma.booking.findMany({
      where,
      select: { id: true, businessId: true, locationId: true, clientId: true, staffId: true, services: true, status: true, startAt: true, total: true, durationMin: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });
    const tz = await this.tzOf(typeof where.businessId === 'string' ? [where.businessId] : where.businessId.in);
    const lineStaff = (v: unknown) => (Array.isArray(v) ? (v as { staffId?: string }[]).map((l) => l.staffId ?? '') : []);
    return rows.map((b) => ({ id: b.id, businessId: b.businessId, clientId: b.clientId, staffId: b.staffId, lineStaffIds: lineStaff(b.services), status: b.status, start: utcToLocal(b.startAt, tz(b.locationId)), total: Number(b.total), durationMin: b.durationMin }));
  }

  private async phoneClientIds(businessIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.client.findMany({ where: { businessId: { in: businessIds }, deletedAt: null, NOT: { phone: '' } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  async summary(ctx: RequestContext, businessId: string, period: { from: string; to: string }) {
    const member = ctx.member!;
    // ux-r5 №10, F-00-132: без права на отчёты сотрудник видит только свои визиты — не выручку всего салона
    const ownOnly = !member.permissions.has('reports.view') && Boolean(member.staffId);
    const [allRows, phoneIds, settings] = await Promise.all([
      this.visits({ businessId, deletedAt: null, status: { in: ['arrived', 'no_show'] } }),
      this.phoneClientIds([businessId]),
      getClientsBizSettings(this.prisma, businessId),
    ]);
    // Мастер без отчётов — только записи, где он мастер записи или строки (как listBookings({ staffId }) сайта)
    const allTime = ownOnly ? allRows.filter((v) => v.staffId === member.staffId || v.lineStaffIds.includes(member.staffId!)) : allRows;
    // «Есть телефон» (F-04-222): визит без карточки с номером не считаем
    const arrivedAllTime = allTime.filter((v) => v.status === 'arrived' && v.clientId && phoneIds.has(v.clientId));
    const visits = arrivedAllTime.filter((v) => v.start.slice(0, 10) >= period.from && v.start.slice(0, 10) <= period.to && (!ownOnly || v.staffId === member.staffId));
    const revenue = visits.reduce((s, v) => s + v.total, 0);
    const clientIds = new Set(visits.map((v) => v.clientId!));
    const staffNames = new Map((await this.prisma.staff.findMany({ where: { id: { in: [...new Set(visits.map((v) => v.staffId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const byStaffMap = new Map<string, { staffId: string; name: string; revenue: number; hoursBooked: number; visits: number }>();
    for (const v of visits) {
      const row = byStaffMap.get(v.staffId) ?? { staffId: v.staffId, name: staffNames.get(v.staffId) ?? '—', revenue: 0, hoursBooked: 0, visits: 0 };
      row.revenue += v.total;
      row.hoursBooked += v.durationMin / 60;
      row.visits += 1;
      byStaffMap.set(v.staffId, row);
    }
    // F-04-125: «Новые» — первый визит клиента (когда-либо, в этой локации) попал в период
    const byClientLocal = groupByClient(arrivedAllTime);
    let newClients = 0;
    let repeatClients = 0;
    clientIds.forEach((id) => {
      const list = byClientLocal.get(id) ?? [];
      const first = list.reduce((min, v) => (v.start < min ? v.start : min), list[0]?.start ?? '');
      if (first.slice(0, 10) >= period.from) newClients += 1;
      else repeatClients += 1;
    });
    const lostClients = countLost(byClientLocal, period.to, settings.lostAfterDays);

    // F-04-124/185 ⭐: «потерянные» по всей сети. Нужен доступ к клиентам и записям всех филиалов — иначе не считаем
    // (undefined честнее выдуманного нуля, как раньше у сайта). Мастеру без отчётов — только своё, сеть не считаем.
    let networkLostClients: number | undefined;
    const networkId = ownOnly ? null : (await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } }))?.networkId;
    if (networkId) {
      const peers = (await this.prisma.business.findMany({ where: { networkId }, select: { id: true } })).map((b) => b.id).filter((id) => id !== businessId);
      if (!peers.length) networkLostClients = lostClients;
      else {
        let allowed = Boolean(ctx.session);
        for (const id of peers) {
          if (!allowed) break;
          const m = await this.memberships.resolve(ctx.session!, id, ctx.ip);
          allowed = Boolean(m?.permissions.has('clients.view') && m.permissions.has('journal.view'));
        }
        if (allowed) {
          const ids = [businessId, ...peers];
          const [networkVisits, networkPhoneIds] = await Promise.all([this.visits({ businessId: { in: ids }, deletedAt: null, status: 'arrived' }), this.phoneClientIds(ids)]);
          networkLostClients = countLost(groupByClient(networkVisits.filter((v) => v.clientId && networkPhoneIds.has(v.clientId))), period.to, settings.lostAfterDays);
        }
      }
    }

    // F-04-163: клиент со статусом «Не пришёл», кого в этом же периоде перезаписали и он дошёл
    const noShowIds = new Set(allTime.filter((v) => v.status === 'no_show' && v.clientId).map((v) => v.clientId!));
    const rebookedNoShows = new Set(visits.filter((v) => noShowIds.has(v.clientId!)).map((v) => v.clientId)).size;

    return {
      revenue,
      clientsCount: clientIds.size,
      visitsCount: visits.length,
      byStaff: [...byStaffMap.values()].sort((a, b) => b.revenue - a.revenue),
      ownOnly,
      newClients,
      repeatClients,
      lostClients,
      ...(networkLostClients !== undefined ? { networkLostClients } : {}),
      rebookedNoShows,
    };
  }

  /**
   * F-00-127: прошедшие по времени записи без отметки «пришёл/не пришёл» — только они, а не все незакрытые записи
   * салона с будущими (82 КБ) и не все клиенты ради имён (43 КБ). Без права на чужие записи — только свои.
   */
  async pendingMarks(ctx: RequestContext, businessId: string) {
    const member = ctx.member!;
    const seeOthers = member.permissions.has('journal.others') || !member.staffId;
    const now = nowLocal();
    const rows = await this.prisma.booking.findMany({
      where: { businessId, deletedAt: null, status: { in: ACTIVE_STATUSES }, startAt: { lt: new Date(Date.now() + 86_400_000) } },
      select: { id: true, locationId: true, clientId: true, staffId: true, startAt: true, services: true, total: true, visitorName: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });
    const tz = await this.tzOf([businessId]);
    const lines = (v: unknown) => (Array.isArray(v) ? (v as { serviceId?: string; staffId?: string }[]) : []);
    const mine = rows
      .map((b) => ({ ...b, start: utcToLocal(b.startAt, tz(b.locationId)) }))
      .filter((b) => b.start < now && (seeOthers || b.staffId === member.staffId || lines(b.services).some((l) => l.staffId === member.staffId)));
    const clientIds = [...new Set(mine.map((b) => b.clientId).filter((x): x is string => Boolean(x)))];
    const names = new Map(
      (clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds }, deletedAt: null }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]),
    );
    return mine.map((b) => ({
      bookingId: b.id,
      ...(b.clientId ? { clientId: b.clientId } : {}),
      clientName: (b.clientId && names.get(b.clientId)) || b.visitorName || '—',
      staffId: b.staffId,
      start: b.start,
      services: lines(b.services).map((l) => l.serviceId ?? '').join(', '),
      total: Number(b.total),
    }));
  }
}
