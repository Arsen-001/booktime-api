import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { ScheduleService } from '../schedule/schedule.service.js';
import { ReportsSettingsService } from './reports-settings.service.js';
import { inRange, localDateAt, locationsOf, tzMapOf, wideUtcBounds, type ReportRange } from './reports-common.js';
import { DEFAULT_TZ, utcToLocal } from '../../common/time/time.js';

type LocalizedText = { ru: string; hy?: string; en?: string };
const ruOf = (v: unknown): string => (v as LocalizedText | null)?.ru ?? '';

const CANCELLED_STATUSES = ['cancelled_by_client', 'cancelled_by_master'];

/** Только то, что этому отчёту нужно от ScheduleService — реальный сервис подходит по структуре (Nest DI);
 *  воркер выгрузки (jobs/reports-export.ts) не тащит его Redis/Live-зависимости, подставляет заглушку этой формы. */
export interface ScheduleHoursSource {
  hours(businessId: string, staffId: string, from: string, to: string, locationId?: string): ReturnType<ScheduleService['hours']>;
}

/**
 * Отчёты, читающие журнал записей напрямую (docs/backend/02 §16): «Визиты» (`visits`), «Записи» (`records`),
 * «События» (`events`), «Возвращаемость» (`retention`), «Загруженность» (`load`). Общее с dashboard вынесено
 * в reports-common.ts; график сотрудника — через `ScheduleService.hours()` (этап 6), не второй раз руками.
 */
@Injectable()
export class ReportsJournalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ScheduleService) private readonly schedule: ScheduleHoursSource,
    private readonly settings: ReportsSettingsService,
  ) {}

  private async staffNames(businessId: string, ids: string[]): Promise<Map<string, { name: string; specialty?: string; deletedAt: Date | null }>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.staff.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, specialty: true, deletedAt: true } });
    return new Map(rows.map((s) => [s.id, { name: s.name, specialty: ruOf(s.specialty) || undefined, deletedAt: s.deletedAt }]));
  }

  // ─────────────────────────── F-12-029…032, 038: «Визиты» ───────────────────────────

  async visits(businessId: string, locationIds: string[] | undefined, tab: 'upcoming' | 'past', canSeePhones: boolean) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const now = new Date();
    const rows = await this.prisma.booking.findMany({
      where: {
        businessId,
        locationId: { in: locations.map((l) => l.id) },
        deletedAt: null,
        status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] },
        startAt: tab === 'upcoming' ? { gte: now } : { lt: now },
      },
      orderBy: { startAt: tab === 'upcoming' ? 'asc' : 'desc' },
      take: 500,
      select: { id: true, staffId: true, clientId: true, visitorName: true, services: true, startAt: true, durationMin: true, locationId: true, status: true },
    });
    const staffMap = await this.staffNames(
      businessId,
      rows.map((r) => r.staffId),
    );
    const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => Boolean(x)))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true } }) : [];
    const clientMap = new Map(clients.map((c) => [c.id, c] as const));
    const serviceIds = [...new Set(rows.flatMap((r) => (r.services as { serviceId: string }[]).map((s) => s.serviceId)))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : [];
    const serviceNameMap = new Map(services.map((s) => [s.id, ruOf(s.name)] as const));
    const tzMap = tzMapOf(locations);

    const byDay = new Map<string, typeof rows>();
    for (const r of rows) {
      const day = localDateAt(r.startAt, r.locationId, tzMap);
      const list = byDay.get(day) ?? [];
      list.push(r);
      byDay.set(day, list);
    }
    const days = [...byDay.entries()]
      .sort(([a], [b]) => (tab === 'upcoming' ? a.localeCompare(b) : b.localeCompare(a)))
      .map(([date, list]) => ({
        date,
        rows: list.map((r) => ({
          bookingId: r.id,
          date,
          time: localDateAt(r.startAt, r.locationId, tzMap) === date ? utcToLocal(r.startAt, tzMap.get(r.locationId) ?? DEFAULT_TZ).slice(11) : '',
          durationMin: r.durationMin,
          clientName: r.clientId ? clientMap.get(r.clientId)?.name : undefined,
          clientPhone: canSeePhones && r.clientId ? clientMap.get(r.clientId)?.phone : undefined,
          visitorName: r.visitorName ?? undefined,
          services: (r.services as { serviceId: string }[]).map((s) => serviceNameMap.get(s.serviceId) ?? ''),
          staffName: staffMap.get(r.staffId)?.name ?? '',
          canConfirm: r.status === 'awaiting_confirmation',
        })),
      }));
    return { days, count: rows.length };
  }

  // ─────────────────────────── F-12-033…039: «Записи» ───────────────────────────

  async records(
    businessId: string,
    locationIds: string[] | undefined,
    q: {
      createdFrom: string;
      createdTo: string;
      staffId?: string;
      createdBy?: string;
      cancelled: 'all' | 'cancelled' | 'notCancelled';
      source: 'all' | 'online' | 'offline';
      hasServices: 'all' | 'with' | 'without';
      search?: string;
      page: number;
      pageSize: number;
    },
    canSeePhones: boolean,
    depth: 30 | 'all',
  ) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const range: ReportRange = { from: q.createdFrom, to: q.createdTo };
    const clampedFrom = depth === 30 ? maxDate(range.from, isoDaysAgo(30)) : range.from;
    const { from, to } = wideUtcBounds({ from: clampedFrom, to: range.to });

    const rows = await this.prisma.booking.findMany({
      where: {
        businessId,
        locationId: { in: locations.map((l) => l.id) },
        createdAt: { gte: from, lt: to },
        ...(q.staffId ? { staffId: q.staffId } : {}),
        ...(q.createdBy === 'client' ? { createdByRef: 'client' } : q.createdBy ? { createdByRef: q.createdBy } : {}),
        ...(q.source === 'online' ? { source: { in: ['app', 'link', 'widget'] } } : q.source === 'offline' ? { source: { in: ['journal', 'phone', 'import', 'external'] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const withCancel = rows.filter((r) => {
      const cancelled = CANCELLED_STATUSES.includes(r.status) || Boolean(r.deletedAt);
      if (q.cancelled === 'cancelled') return cancelled;
      if (q.cancelled === 'notCancelled') return !cancelled;
      return true;
    });
    const withServices = withCancel.filter((r) => {
      const has = (r.services as unknown[]).length > 0;
      if (q.hasServices === 'with') return has;
      if (q.hasServices === 'without') return !has;
      return true;
    });

    const staffMap = await this.staffNames(
      businessId,
      withServices.map((r) => r.staffId),
    );
    const clientIds = [...new Set(withServices.map((r) => r.clientId).filter((x): x is string => Boolean(x)))];
    const clients = clientIds.length ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true } }) : [];
    const clientMap = new Map(clients.map((c) => [c.id, c] as const));
    const serviceIds = [...new Set(withServices.flatMap((r) => (r.services as { serviceId: string }[]).map((s) => s.serviceId)))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : [];
    const serviceNameMap = new Map(services.map((s) => [s.id, ruOf(s.name)] as const));
    const createdByStaffIds = [...new Set(withServices.map((r) => r.createdByRef).filter((id) => id !== 'client'))];
    const createdByMap = await this.staffNames(businessId, createdByStaffIds);

    const filtered = q.search
      ? withServices.filter((r) => {
          const c = r.clientId ? clientMap.get(r.clientId) : undefined;
          const needle = q.search!.toLowerCase();
          return (c?.name.toLowerCase().includes(needle) ?? false) || (c?.phone.includes(needle) ?? false);
        })
      : withServices;

    const total = filtered.length;
    const page = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const tzMap = tzMapOf(locations);
    const rowsOut = page.map((r) => {
      const staff = staffMap.get(r.staffId);
      const client = r.clientId ? clientMap.get(r.clientId) : undefined;
      const cancelled = CANCELLED_STATUSES.includes(r.status);
      return {
        id: r.id,
        staffId: r.staffId,
        staffName: staff?.name ?? '',
        staffSpecialty: staff?.specialty,
        staffFired: Boolean(staff?.deletedAt),
        servicesLabel: (r.services as { serviceId: string }[]).map((s) => serviceNameMap.get(s.serviceId) ?? '').join(', '),
        clientId: r.clientId ?? undefined,
        clientName: r.deletedAt && r.deletedByClient ? '' : (client?.name ?? ''),
        clientPhone: canSeePhones ? client?.phone : undefined,
        visitStart: utcToLocal(r.startAt, tzMap.get(r.locationId) ?? DEFAULT_TZ),
        createdByLabel: r.createdByRef === 'client' ? 'client' : (createdByMap.get(r.createdByRef)?.name ?? ''),
        createdAt: utcToLocal(r.createdAt, tzMap.get(r.locationId) ?? DEFAULT_TZ),
        status: r.status,
        isCancelledRow: cancelled || Boolean(r.deletedAt),
        sourceLabel: r.source,
        deleted: Boolean(r.deletedAt),
        deletedAt: r.deletedAt ? utcToLocal(r.deletedAt, tzMap.get(r.locationId) ?? DEFAULT_TZ) : undefined,
        canEdit: !r.deletedAt,
        canDelete: !r.deletedAt,
      };
    });
    return { rows: rowsOut, total };
  }

  // ─────────────────────────── F-12-040: «События» (групповые записи) ───────────────────────────

  async events(businessId: string, locationIds: string[] | undefined, range: ReportRange, filters: { serviceId?: string; staffId?: string; status: 'all' | 'cancelled' | 'notCancelled' }) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { from, to } = wideUtcBounds(range);
    const tzMap = tzMapOf(locations);
    const rows = await this.prisma.groupEvent.findMany({
      where: {
        businessId,
        locationId: { in: locations.map((l) => l.id) },
        startAt: { gte: from, lt: to },
        ...(filters.serviceId ? { serviceId: filters.serviceId } : {}),
        ...(filters.staffId ? { staffId: filters.staffId } : {}),
      },
      orderBy: { startAt: 'asc' },
    });
    const inWindow = rows.filter((r) => inRange(localDateAt(r.startAt, r.locationId, tzMap), range));
    const filteredByStatus = inWindow.filter((r) => (filters.status === 'cancelled' ? r.status === 'cancelled' : filters.status === 'notCancelled' ? r.status !== 'cancelled' : true));

    const staffMap = await this.staffNames(
      businessId,
      filteredByStatus.map((r) => r.staffId),
    );
    const serviceIds = [...new Set(filteredByStatus.map((r) => r.serviceId))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : [];
    const serviceNameMap = new Map(services.map((s) => [s.id, ruOf(s.name)] as const));
    const eventIds = filteredByStatus.map((r) => r.id);
    const bookings = eventIds.length ? await this.prisma.booking.findMany({ where: { groupEventId: { in: eventIds }, deletedAt: null }, select: { groupEventId: true, status: true, paidAmount: true } }) : [];
    const createdByIds = [...new Set(filteredByStatus.map((r) => r.createdBy).filter((x): x is string => Boolean(x)))];
    const createdByMap = await this.staffNames(businessId, createdByIds);

    const rowsOut = filteredByStatus.map((r) => {
      const participants = bookings.filter((b) => b.groupEventId === r.id);
      const arrivedCount = participants.filter((b) => b.status === 'arrived').length;
      const paidCount = participants.filter((b) => b.paidAmount > 0n).length;
      const paidAmount = participants.reduce((s, b) => s + Number(b.paidAmount), 0);
      return {
        groupEventId: r.id,
        staffName: staffMap.get(r.staffId)?.name ?? '',
        serviceName: serviceNameMap.get(r.serviceId) ?? '',
        date: localDateAt(r.startAt, r.locationId, tzMap),
        time: utcToLocal(r.startAt, tzMap.get(r.locationId) ?? DEFAULT_TZ).slice(11),
        durationMin: r.durationMin,
        capacity: r.capacity,
        bookingsCount: participants.length,
        arrivedCount,
        paidCount,
        paidAmount,
        createdByLabel: r.createdBy ? (createdByMap.get(r.createdBy)?.name ?? '') : 'client',
        cancelled: r.status === 'cancelled',
      };
    });
    const totalBooked = rowsOut.reduce((s, r) => s + r.bookingsCount, 0);
    const totalCapacity = rowsOut.reduce((s, r) => s + r.capacity, 0);
    const totalArrived = rowsOut.reduce((s, r) => s + r.arrivedCount, 0);
    const totalPaid = rowsOut.reduce((s, r) => s + r.paidCount, 0);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      rows: rowsOut,
      totals: { bookedPct: pct(totalBooked, totalCapacity), arrivedPct: pct(totalArrived, totalBooked), paidPct: pct(totalPaid, totalBooked), avgFillPct: pct(totalBooked, totalCapacity) },
    };
  }

  // ─────────────────────────── F-12-019…023,026,028: «Возвращаемость» ───────────────────────────

  async retention(businessId: string, locationIds: string[] | undefined, range: ReportRange, serviceId: string | undefined) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { from, to } = wideUtcBounds(range);
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'reports' } } });
    const churnDays = (row?.data as { churnDays?: number } | undefined)?.churnDays ?? 60;
    const priorFrom = new Date(Date.parse(`${range.from}T00:00:00.000Z`) - churnDays * 86_400_000);
    const priorTo = new Date(`${range.from}T00:00:00.000Z`);

    const tzMap = tzMapOf(locations);
    const staffList = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null, role: 'master' }, select: { id: true, name: true } });
    const staffIdsInScope = staffList.map((s) => s.id);

    const currentBookings = await this.prisma.booking.findMany({
      where: { businessId, locationId: { in: locations.map((l) => l.id) }, staffId: { in: staffIdsInScope }, status: 'arrived', startAt: { gte: from, lt: to } },
      select: { staffId: true, clientId: true, startAt: true, locationId: true, services: true },
    });
    const inWindow = currentBookings
      .filter((b) => inRange(localDateAt(b.startAt, b.locationId, tzMap), range))
      .filter((b) => !serviceId || (b.services as { serviceId: string }[]).some((s) => s.serviceId === serviceId));

    const priorBookings = await this.prisma.booking.findMany({
      where: { businessId, locationId: { in: locations.map((l) => l.id) }, staffId: { in: staffIdsInScope }, status: 'arrived', startAt: { gte: priorFrom, lt: priorTo } },
      select: { staffId: true, clientId: true },
    });

    const rows = staffList.map((s) => {
      const mine = inWindow.filter((b) => b.staffId === s.id && b.clientId);
      const clients = new Set(mine.map((b) => b.clientId!));
      const priorClients = new Set(priorBookings.filter((b) => b.staffId === s.id && b.clientId).map((b) => b.clientId!));
      const priorReturned = [...priorClients].filter((c) => clients.has(c)).length;
      // F-12-019: «новый» — первый визит клиента к ЭТОМУ мастеру раньше не встречался (простая версия — не в prior window; полная история не поднимается ради среза)
      const newCount = [...clients].filter((c) => !priorClients.has(c)).length;
      const total = clients.size;
      return {
        staffId: s.id,
        staffName: s.name,
        total,
        newCount,
        newPct: total ? Math.round((newCount / total) * 1000) / 10 : 0,
        returningCount: total - newCount,
        returningPct: total ? Math.round(((total - newCount) / total) * 1000) / 10 : 0,
        priorWindowClients: priorClients.size,
        priorWindowReturned: priorReturned,
        retentionPct: priorClients.size ? Math.round((priorReturned / priorClients.size) * 1000) / 10 : null,
      };
    });
    const totalUniqueClients = new Set(inWindow.map((b) => b.clientId).filter(Boolean)).size;
    return { rows, totalUniqueClients, churnDays };
  }

  // ─────────────────────────── F-12-041…042: «Загруженность» ───────────────────────────

  async workload(businessId: string, locationIds: string[] | undefined, range: ReportRange) {
    const locations = await locationsOf(this.prisma, businessId, locationIds);
    const { from, to } = wideUtcBounds(range);
    const tzMap = tzMapOf(locations);
    const staffList = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null, role: 'master' }, select: { id: true, name: true } });

    const rows = [];
    let totalWorkedHours = 0;
    let totalScheduledHours = 0;
    for (const s of staffList) {
      const bookings = await this.prisma.booking.findMany({ where: { businessId, staffId: s.id, locationId: { in: locations.map((l) => l.id) }, status: 'arrived', startAt: { gte: from, lt: to } }, select: { startAt: true, durationMin: true, locationId: true } });
      const inWindow = bookings.filter((b) => inRange(localDateAt(b.startAt, b.locationId, tzMap), range));
      const workedMinutes = inWindow.reduce((sum, b) => sum + b.durationMin, 0);
      const workedDays = new Set(inWindow.map((b) => localDateAt(b.startAt, b.locationId, tzMap))).size;
      let scheduledMinutes: number | null = null;
      try {
        const h = await this.schedule.hours(businessId, s.id, range.from, range.to);
        scheduledMinutes = h.scheduledMinutes;
      } catch {
        scheduledMinutes = null;
      }
      const futureBookings = await this.prisma.booking.count({ where: { businessId, staffId: s.id, deletedAt: null, startAt: { gt: new Date(`${range.to}T23:59:59.999Z`) } } });
      const perm = await this.settings.getPermissions(businessId, s.id);
      const workedHours = Math.round((workedMinutes / 60) * 10) / 10;
      const scheduledHours = scheduledMinutes !== null ? Math.round((scheduledMinutes / 60) * 10) / 10 : null;
      if (perm.workloadIncluded) {
        totalWorkedHours += workedHours;
        if (scheduledHours !== null) totalScheduledHours += scheduledHours;
      }
      const byDayMap = new Map<string, number>();
      for (const b of inWindow) byDayMap.set(localDateAt(b.startAt, b.locationId, tzMap), (byDayMap.get(localDateAt(b.startAt, b.locationId, tzMap)) ?? 0) + b.durationMin);
      rows.push({
        staffId: s.id,
        staffName: s.name,
        workedDays,
        scheduledHours,
        workedHours,
        idleHours: scheduledHours !== null ? Math.round((scheduledHours - workedHours) * 10) / 10 : null,
        occupancyPct: scheduledHours && scheduledHours > 0 ? Math.round((workedHours / scheduledHours) * 1000) / 10 : null,
        futureBookings,
        byDay: [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, min]) => ({ date, occupancyPct: Math.round((min / 480) * 1000) / 10 })),
        includedInAverage: perm.workloadIncluded,
      });
    }
    return { rows, totalWorkedHours: Math.round(totalWorkedHours * 10) / 10, totalScheduledHours: Math.round(totalScheduledHours * 10) / 10 };
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
