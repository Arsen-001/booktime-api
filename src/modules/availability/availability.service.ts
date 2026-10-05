import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Prisma } from '../../generated/prisma/client.js';
import { LiveService } from '../../common/live/live.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal } from '../../common/time/time.js';
import { REDIS } from '../../common/tokens.js';
import {
  addDays,
  computeFreeSlots,
  computeQuickSlots,
  type BusyMinutes,
  type DayHours,
  type FreeSlot,
  type Interval,
  type MarkLike,
  type ResourceNeed,
  type ScheduleLike,
  type ServiceSlotWindow,
  type SlotRule,
  type StaffLike,
  type UnavailableRange,
  type WeekTemplate,
} from './engine.js';
import { personKeyOf } from './occupy.js';
import { dropHomeShiftSlots } from './home-shift.js';

type Db = PrismaService | Prisma.TransactionClient;

/** Настройки раздела «График» бизнеса — business_settings(area='schedule'), F4 */
export interface ScheduleSettings {
  /** F-02-079 */
  anySpecialistAllowed: boolean;
  /** F-02-066: по умолчанию включено */
  allowOnlineOverNoShow: boolean;
  /** F-02-030 */
  planningPeriodYears: number;
  /** F-02-105 */
  notifyMasterOnScheduleChange: boolean;
  /** F-02-079: у кого «Пропуск выбора сотрудника» */
  skipStaffSelection: Record<string, boolean>;
  /** F-02-085 */
  historyLimitDays: Record<string, number>;
  /** F-02-081: нет ключа — включено */
  includeInFillRate: Record<string, boolean>;
  /** F-02-090: чужая интеграция — только «подключено / нет» и настройка (Р19) */
  googleCalendar: Record<string, { connected: boolean; shareClientNames: boolean }>;
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  anySpecialistAllowed: false,
  allowOnlineOverNoShow: true,
  planningPeriodYears: 1,
  notifyMasterOnScheduleChange: false,
  skipStaffSelection: {},
  historyLimitDays: {},
  includeInFillRate: {},
  googleCalendar: {},
};

export interface RuleSetRow {
  scope: string;
  scopeId: string;
  rules: SlotRule[] | null;
  ownRules: boolean;
  unavailable: UnavailableRange[];
  bufferMin: number | null;
}

export interface SlotQueryInput {
  staffId: string;
  date: string;
  durationMin: number;
  durationMax?: number;
  bufferAfterMin?: number;
  locationId?: string;
  stepMin?: number;
  serviceId?: string;
}

const STAFF_SELECT = {
  id: true,
  businessId: true,
  userId: true,
  name: true,
  status: true,
  calendarMode: true,
  onlineBookingEnabled: true,
  serviceIds: true,
  deletedAt: true,
  locations: { select: { locationId: true } },
} as const;

export type StaffForSlots = Prisma.StaffGetPayload<{ select: typeof STAFF_SELECT }>;

const minutesSince = (at: Date, dayStart: Date) => Math.round((at.getTime() - dayStart.getTime()) / 60000);

/**
 * Свободные окна на сервере (docs/backend/04, PLAN.md §6 №6): загрузка входа из базы → чистый расчёт engine.ts →
 * кеш в Redis. Кеш сбрасывается по событию (правка графика, отметка, правила, занятость) — версией бизнеса, а не
 * перебором ключей; при записи окно всё равно проверяет «замок на мастера» (occupy.ts), кеш никогда не пропускает
 * двойную запись (04 §6).
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly live: LiveService,
  ) {}

  // ─────────── загрузка ───────────

  async staffRows(db: Db, where: Prisma.StaffWhereInput): Promise<StaffForSlots[]> {
    return db.staff.findMany({ where, select: STAFF_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  toStaffLike(s: StaffForSlots): StaffLike {
    return {
      id: s.id,
      businessId: s.businessId,
      status: s.deletedAt ? 'disabled' : s.status,
      calendarMode: s.calendarMode,
      onlineBookingEnabled: s.onlineBookingEnabled,
    };
  }

  /** Графики сотрудников с исключениями в диапазоне дат */
  async schedules(db: Db, staffIds: readonly string[], from?: string, to?: string): Promise<ScheduleLike[]> {
    if (!staffIds.length) return [];
    const rows = await db.workSchedule.findMany({
      where: { staffId: { in: [...staffIds] } },
      include: { days: from && to ? { where: { date: { gte: from, lte: to } } } : true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      staffId: r.staffId,
      locationId: r.locationId,
      workplace: r.workplace,
      week: r.week as unknown as WeekTemplate,
      openUntil: r.openUntil,
      overrides: Object.fromEntries(r.days.map((d) => [d.date, d.hours as unknown as DayHours])),
    }));
  }

  async marks(db: Db, staffIds: readonly string[], from: string, to: string): Promise<MarkLike[]> {
    if (!staffIds.length) return [];
    const rows = await db.calendarMark.findMany({
      where: { staffId: { in: [...staffIds] }, date: { gte: from, lte: to } },
      orderBy: [{ date: 'asc' }, { fromTime: 'asc' }],
    });
    return rows.map((m) => ({
      id: m.id,
      staffId: m.staffId,
      date: m.date,
      from: m.fromTime,
      to: m.toTime,
      kind: m.kind as 'busy' | 'free',
      workplace: m.workplace,
      note: m.note,
    }));
  }

  /** Занятость человека в местный день (все его бизнесы, F-00-045); просроченные «держит до» не занимают */
  async busyMinutes(db: Db, personKey: string, date: string, tz: string = DEFAULT_TZ, opts: { withMarks?: boolean } = {}): Promise<BusyMinutes[]> {
    const { from, to } = localDayRangeUtc(date, tz);
    const now = new Date();
    const rows = await db.busyBlock.findMany({
      where: {
        personKey,
        active: true,
        startAt: { lt: to },
        endAt: { gt: from },
        OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
        ...(opts.withMarks ? {} : { source: { not: 'mark_busy' } }),
      },
      orderBy: { startAt: 'asc' },
    });
    return rows.map((b) => ({
      from: Math.max(0, minutesSince(b.startAt, from)),
      to: Math.min(24 * 60, minutesSince(b.endAt, from)),
      serviceTo: Math.min(24 * 60, minutesSince(b.serviceEndAt, from)),
      source: b.source,
      sourceId: b.sourceId,
      businessId: b.businessId,
      staffId: b.staffId,
      workplace: b.workplace,
      noShow: b.noShow,
    }));
  }

  async settings(db: Db, businessId: string): Promise<ScheduleSettings> {
    const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'schedule' } } });
    return { ...DEFAULT_SCHEDULE_SETTINGS, ...((row?.data as Partial<ScheduleSettings> | null) ?? {}) };
  }

  async ruleSets(db: Db, businessId: string): Promise<Map<string, RuleSetRow>> {
    const rows = await db.onlineSlotRuleSet.findMany({ where: { businessId } });
    return new Map(
      rows.map((r) => [
        `${r.scope}:${r.scopeId}`,
        {
          scope: r.scope,
          scopeId: r.scopeId,
          rules: (r.rules as SlotRule[] | null) ?? null,
          ownRules: r.ownRules,
          unavailable: (r.unavailable as UnavailableRange[] | null) ?? [],
          bufferMin: r.bufferMin,
        },
      ]),
    );
  }

  private async tzOf(db: Db, locationId: string | undefined): Promise<string> {
    if (!locationId) return DEFAULT_TZ;
    const loc = await db.location.findUnique({ where: { id: locationId }, select: { tz: true } });
    return loc?.tz ?? DEFAULT_TZ;
  }

  // ─────────── окна ───────────

  /** Окна мастера на дату (режим клиента/онлайн-правил, 04 §2). null — сотрудник не найден в бизнесе. */
  async freeSlots(businessId: string, q: SlotQueryInput): Promise<FreeSlot[]> {
    return this.cached(businessId, 'free', q, () => this.computeFree(this.prisma, businessId, q));
  }

  async computeFree(db: Db, businessId: string, q: SlotQueryInput, preloaded?: { settings: ScheduleSettings; rules: Map<string, RuleSetRow> }): Promise<FreeSlot[]> {
    const [staff] = await this.staffRows(db, { id: q.staffId, businessId });
    if (!staff) return [];
    const tz = await this.tzOf(db, q.locationId ?? staff.locations[0]?.locationId);
    const [schedules, marks, busy] = await Promise.all([
      this.schedules(db, [staff.id], q.date, q.date),
      this.marks(db, [staff.id], q.date, q.date),
      this.busyMinutes(db, personKeyOf(staff), q.date, tz),
    ]);
    const settings = preloaded?.settings ?? (await this.settings(db, businessId));
    const rules = preloaded?.rules ?? (await this.ruleSets(db, businessId));
    const own = rules.get(`staff:${staff.id}`);
    const rulesFor = (locationId: string) => (own?.ownRules ? own.rules : (rules.get(`location:${locationId}`)?.rules ?? null));
    const unavailableFor = (locationId: string) => [...(rules.get(`location:${locationId}`)?.unavailable ?? []), ...(own?.unavailable ?? [])];
    const bufferFor = (locationId: string) => own?.bufferMin ?? rules.get(`location:${locationId}`)?.bufferMin ?? 0;
    let serviceWindow: ServiceSlotWindow | null = null;
    let resourcesFor: ((locationId: string) => ResourceNeed[]) | undefined;
    if (q.serviceId) {
      const svc = await db.service.findFirst({ where: { id: q.serviceId, businessId }, select: { id: true, onlineWindow: true } });
      serviceWindow = svc?.onlineWindow ? ({ ...(svc.onlineWindow as object), serviceId: svc.id } as ServiceSlotWindow) : null;
      resourcesFor = await this.resourceNeeds(db, businessId, q.serviceId, q.date, tz, settings.allowOnlineOverNoShow);
    }
    const slots = computeFreeSlots({
      staff: this.toStaffLike(staff),
      schedules,
      marks,
      busy,
      date: q.date,
      now: nowLocal(tz),
      durationMin: q.durationMin,
      durationMax: q.durationMax,
      bufferAfterMin: q.bufferAfterMin,
      locationId: q.locationId,
      stepMin: q.stepMin,
      rulesFor,
      unavailableFor,
      bufferFor,
      serviceWindow,
      resourcesFor,
      overNoShow: settings.allowOnlineOverNoShow,
    });
    // F-00-047: домашние окна на смене в салоне с галочкой не предлагаем (сохранение отклонило бы их — home_during_shift)
    return dropHomeShiftSlots(db, staff.id, slots, tz);
  }

  /** Ресурсы услуги по местам и их занятость в день (F-02-064, F-02-070) */
  private async resourceNeeds(db: Db, businessId: string, serviceId: string, date: string, tz: string, overNoShow: boolean) {
    const resources = (await db.resource.findMany({ where: { businessId, active: true } })).filter((r) =>
      ((r.serviceIds as string[] | null) ?? []).includes(serviceId),
    );
    if (!resources.length) return undefined;
    const { from, to } = localDayRangeUtc(date, tz);
    const now = new Date();
    const busy = await db.resourceBusy.findMany({
      where: {
        resourceId: { in: resources.map((r) => r.id) },
        active: true,
        startAt: { lt: to },
        endAt: { gt: from },
        OR: [{ holdUntil: null }, { holdUntil: { gt: now } }],
        ...(overNoShow ? { noShow: false } : {}),
      },
    });
    return (locationId: string): ResourceNeed[] =>
      resources
        .filter((r) => r.locationId === locationId)
        .map((r) => ({
          resourceId: r.id,
          instances: ((r.instances as unknown[] | null) ?? []).length,
          used: busy.filter((b) => b.resourceId === r.id).map((b) => [minutesSince(b.startAt, from), minutesSince(b.endAt, from)] as Interval),
        }));
  }

  /** Ближайшие окна на N дней (каталог «кто когда свободен») */
  async nearestSlots(businessId: string, q: Omit<SlotQueryInput, 'date'> & { days?: number; limit?: number }): Promise<FreeSlot[]> {
    const limit = Math.min(50, q.limit ?? 5);
    const days = Math.min(60, q.days ?? 14);
    const today = nowLocal().slice(0, 10);
    const out: FreeSlot[] = [];
    for (let i = 0; i < days && out.length < limit; i++) out.push(...(await this.freeSlots(businessId, { ...q, date: addDays(today, i) })));
    return out.slice(0, limit);
  }

  /** «Любой специалист» (F-02-079): окно — случайный свободный мастер из пула «Пропуск выбора сотрудника» */
  async anySpecialistSlots(businessId: string, q: Omit<SlotQueryInput, 'staffId'> & { locationId: string }) {
    const settings = await this.settings(this.prisma, businessId);
    if (!settings.anySpecialistAllowed) return [];
    const pool = (await this.staffRows(this.prisma, { businessId, status: 'active', deletedAt: null, onlineBookingEnabled: true })).filter(
      (s) =>
        s.locations.some((l) => l.locationId === q.locationId) &&
        (settings.skipStaffSelection[s.id] ?? false) &&
        (!q.serviceId || ((s.serviceIds as string[] | null) ?? []).includes(q.serviceId)),
    );
    const byTime = new Map<string, FreeSlot[]>();
    for (const s of pool) {
      for (const slot of await this.freeSlots(businessId, { ...q, staffId: s.id })) byTime.set(slot.start, [...(byTime.get(slot.start) ?? []), slot]);
    }
    return [...byTime.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, candidates]) => ({ ...candidates[Math.floor(Math.random() * candidates.length)]!, candidateIds: candidates.map((c) => c.staffId) }));
  }

  /** Окна быстрой записи мастера (F-00-060): база без правил онлайн-записи, шаг 15 */
  async quickSlots(businessId: string, q: { staffId: string; date: string; serviceId?: string; locationId?: string }): Promise<FreeSlot[]> {
    const [staff] = await this.staffRows(this.prisma, { id: q.staffId, businessId });
    if (!staff) return [];
    const svc = q.serviceId ? await this.prisma.service.findFirst({ where: { id: q.serviceId, businessId } }) : null;
    const tz = await this.tzOf(this.prisma, q.locationId ?? staff.locations[0]?.locationId);
    const [schedules, marks, busy] = await Promise.all([
      this.schedules(this.prisma, [staff.id], q.date, q.date),
      this.marks(this.prisma, [staff.id], q.date, q.date),
      this.busyMinutes(this.prisma, personKeyOf(staff), q.date, tz),
    ]);
    const slots = computeQuickSlots({
      staff: this.toStaffLike(staff),
      schedules,
      marks,
      busy,
      date: q.date,
      now: nowLocal(tz),
      durationMin: svc ? (svc.durationMax ?? svc.durationMin) : 30,
      bufferAfterMin: svc?.bufferAfterMin ?? 0,
      locationId: q.locationId,
    });
    return dropHomeShiftSlots(this.prisma, staff.id, slots, tz);
  }

  // ─────────── кеш и события ───────────

  private async cached<T>(businessId: string, kind: string, q: object, compute: () => Promise<T>): Promise<T> {
    const ver = (await this.redis.get(`slotsver:biz:${businessId}`)) ?? '0';
    const bucket = Math.floor(Date.now() / 300_000);
    const hash = createHash('sha1').update(JSON.stringify(q)).digest('hex').slice(0, 16);
    const key = `slots:${businessId}:${ver}:${kind}:${bucket}:${hash}`;
    const hit = await this.redis.get(key);
    if (hit) return JSON.parse(hit) as T;
    const value = await compute();
    await this.redis.set(key, JSON.stringify(value), 'EX', 300);
    return value;
  }

  /**
   * После коммита правки: сбросить кеш окон у всех бизнесов, где работают эти люди (запись в одном месте закрывает
   * время в другом, F-00-045), и сказать открытым экранам перечитать (SSE, F-00-001 «без перезагрузки»).
   */
  async invalidate(input: { businessIds?: string[]; personKeys?: string[]; staffIds?: string[]; dates?: string[] }): Promise<void> {
    const businessIds = new Set(input.businessIds ?? []);
    const staffIds = new Set(input.staffIds ?? []);
    if (input.personKeys?.length) {
      const rows = await this.prisma.staff.findMany({
        where: { OR: [{ userId: { in: input.personKeys } }, { id: { in: input.personKeys } }] },
        select: { id: true, businessId: true },
      });
      for (const r of rows) {
        businessIds.add(r.businessId);
        staffIds.add(r.id);
      }
    }
    for (const b of businessIds) await this.redis.incr(`slotsver:biz:${b}`);
    const dates = (input.dates ?? []).slice(0, 31);
    for (const s of staffIds) await this.live.publish(`staff:${s}`, { type: 'slots.changed', data: { staffId: s, dates } });
    for (const b of businessIds) {
      for (const d of dates) await this.live.publish(`biz:${b}:day:${d}`, { type: 'schedule.changed', data: { staffIds: [...staffIds], date: d } });
    }
  }
}
