import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { Prisma, type Booking as BookingRow } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import type { Permission } from '../../common/permissions/permissions.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { LiveService } from '../../common/live/live.service.js';
import { DEFAULT_TZ, localDayRangeUtc, localToUtc, nowLocal, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { toMinutes } from '../availability/engine.js';
import { OccupyService, personKeyOf, visibilityOf, type BlockInput, type ResourceBlockInput } from '../availability/occupy.js';
import { isLocale, t, type Locale } from '../../common/i18n/i18n.js';
import { customTemplateOf } from '../notify/notify-types.service.js';
import { notifyKindOf } from '../notify/kinds.js';
import { isStaffEventEnabled } from '../notify/notify-staff-prefs.service.js';
import { enqueueClientNotification, enqueueOutbox } from '../notify/outbox.js';
import { LoyaltyProgramService } from '../loyalty/loyalty-program.service.js';
import { TechCardsService } from '../stock/tech-cards.service.js';
import { recordPrepaymentReceivedTx, recordPrepaymentRefundTx } from '../finance/prepayment-ops.js';
import { JournalSettingsService } from './journal-settings.js';
import { UpsellService } from './upsell.service.js';
import { waitlistOffer } from './waitlist-match.js';
import { bookingView, eventView, extrasView, type BookingView } from './journal.views.js';
import {
  PREPAYMENT_HOLD_MIN,
  canReschedule,
  canTransition,
  clientCancelOutcome,
  confirmDeadlineOf,
  effectiveBookingRules,
  extrasOf,
  isActiveStatus,
  isCancelled,
  isOnlineSource,
  linesDuration,
  linesTotal,
  makeServiceLine,
  newBookingStatus,
  normalizeNoShowRule,
  noShowPeriodStart,
  prepaymentNeed,
  noShowDelta,
  occupiesTime,
  prepaymentAmount,
  canPayInFull,
  requiresPrepayment,
  type BookingExtras,
  type BookingRules,
  type BookingStatus,
  type EffectiveBookingRules,
  type PrepaymentRule,
  type ServiceLine,
  type StatusActor,
} from './rules.js';
import { attachReferralInTx } from '../loyalty/referral.service.js';
import { PICKUP_KIND } from '../orders/order-rules.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
/** ru-заглушка для LocalizedText (этап 10: пуш всегда несёт хоть какое-то название услуги) */
const pickRu = (v: unknown): string | undefined => (v as Record<string, string> | null | undefined)?.ru;
const renderTemplate = (template: string, params: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);

// ─────────────────────────── права журнала (docs/backend/03 §2, rules/permissions фронта) ───────────────────────────

const REQUIRES: Partial<Record<Permission, Permission[]>> = {
  'journal.edit': ['journal.view'],
  'journal.create': ['journal.view', 'journal.edit'],
  'journal.reschedule': ['journal.view', 'journal.edit'],
  'journal.others': ['journal.view'],
};
const OWN_SCOPED: Permission[] = ['journal.view', 'journal.edit', 'journal.create', 'journal.reschedule'];

/** canWith фронта: право + базовые права + «чужие записи» (journal.others) */
export function canJournal(ctx: RequestContext, permission: Permission, targetStaffId?: string | null): boolean {
  const m = ctx.member;
  if (!m) return false;
  if (!m.permissions.has(permission)) return false;
  if (REQUIRES[permission]?.some((p) => !m.permissions.has(p))) return false;
  const foreign = Boolean(targetStaffId && targetStaffId !== m.staffId);
  if (foreign && OWN_SCOPED.includes(permission) && !m.permissions.has('journal.others') && m.kind !== 'individual') return false;
  return true;
}

export function assertJournal(ctx: RequestContext, permission: Permission, targetStaffId?: string | null): void {
  if (!canJournal(ctx, permission, targetStaffId)) throw new ApiError('forbidden', `Missing permission: ${permission}`);
}

// ─────────────────────────── кто действует ───────────────────────────

export interface BookingActor {
  kind: 'staff' | 'client' | 'system' | 'link_holder';
  /** В событиях: id сотрудника | 'client' | 'system' */
  ref: string;
  name: string;
  ctx: RequestContext | null;
}

export function staffActor(ctx: RequestContext): BookingActor {
  return { kind: 'staff', ref: ctx.member!.staffId, name: ctx.member!.name, ctx };
}
export function clientActor(ctx: RequestContext | null, kind: 'client' | 'link_holder' = 'client'): BookingActor {
  return { kind, ref: 'client', name: kind, ctx };
}
export const SYSTEM_ACTOR: BookingActor = { kind: 'system', ref: 'system', name: 'system', ctx: null };

// ─────────────────────────── входы ───────────────────────────

export interface PlaceLineInput {
  serviceId: string;
  staffId?: string;
  qty?: number;
  discountPct?: number;
  unitPrice?: number;
  /** ⭐ Допродажа: строка — сопутствующая к этой услуге (ставит сам сервер из addOns; у онлайн-записи с клиента не берётся) */
  upsellOf?: string;
}

/** PlaceBookingInput фронта (src/domain/rules/booking-flow.ts) — единый поток записи */
export interface PlaceInput {
  source: string;
  businessId: string;
  staffId: string;
  start: string;
  services: PlaceLineInput[];
  locationId?: string;
  workplace?: string;
  client?: { clientId?: string; appUserId?: string; phone?: string; name?: string };
  forWhom?: string;
  visitorName?: string;
  comment?: string;
  groupEventId?: string;
  resourceIds?: string[];
  staffAssignment?: string;
  createdBy?: string;
  status?: BookingStatus;
  seriesId?: string;
  visitId?: string;
  /** ⭐ Клиент выбрал «Оплатить всё сразу» вместо процента предоплаты мастера (онлайн) */
  payInFull?: boolean;
  /**
   * О28 «Другое время» (online.bookAlternativeTime): клиент берёт окно, которое предложил сам мастер, — второй раз
   * заявку мастеру не шлём (сразу «Записан»; предоплата — всё равно «ждёт предоплату»). Только для серверных вызовов.
   */
  acceptsOffer?: boolean;
  /**
   * ⭐ Допродажа при записи (01.10.2026): клиент добавил сопутствующие из карточки услуги. Услуги становятся строками
   * записи (upsellOf, продлевают время у того же мастера), товары — товарными строками визита к оплате на месте.
   * Сервер проверяет список, мастера, время, остаток и цену (UpsellService).
   */
  addOns?: { serviceIds?: string[]; productIds?: string[] };
  /** «Пригласи подругу»: код из личной ссылки — привязка нового клиента к пригласившему (attachReferralInTx) */
  referralCode?: string;
  /**
   * ⭐ Выдача по времени (06.10.2026): запись на скрытую услугу «Выдача заказа» (kind pickup) по ссылке готового заказа —
   * только из OrderPickupService. Услуга не онлайн (в общем потоке её нет), окно проверяется как у онлайн-записи,
   * статус — сразу «Записан» (без подтверждения и предоплаты: время предложила сама мастерская).
   */
  orderPickup?: boolean;
}

/** BookingInput фронта (createBooking «как есть»: строки уже посчитаны) */
export interface RawInput {
  businessId: string;
  locationId: string;
  staffId: string;
  clientId?: string;
  appUserId?: string;
  start: string;
  durationMin?: number;
  status: BookingStatus;
  services: ServiceLine[];
  resourceIds?: string[];
  workplace?: string;
  source: string;
  createdBy?: string;
  forWhom?: string;
  visitorName?: string;
  comment?: string;
  prepayment?: { amount: number; paid: boolean; holdUntil?: string; full?: boolean };
  groupEventId?: string;
  seriesId?: string;
  visitId?: string;
  staffAssignment?: string;
  /** Номер доп. места участника группового события (1, 2…; eventExtraSeat фронта, client-2-fix) — в extras.extraSeat */
  extraSeat?: number;
}

export interface BookingPatch {
  start?: string;
  staffId?: string;
  locationId?: string;
  clientId?: string | null;
  services?: ServiceLine[];
  durationMin?: number;
  resourceIds?: string[];
  workplace?: string;
  comment?: string | null;
  visitorName?: string | null;
  forWhom?: string;
  visitId?: string | null;
  seriesId?: string | null;
  groupEventId?: string | null;
  staffAssignment?: string | null;
  status?: BookingStatus;
  prepayment?: { amount: number; paid: boolean; holdUntil?: string; full?: boolean } | null;
}

export interface BookingQuery {
  businessIds: string[];
  locationId?: string;
  staffId?: string;
  clientId?: string;
  appUserId?: string;
  from?: string;
  to?: string;
  statuses?: string[];
  includeDeleted?: boolean;
  groupEventId?: string;
  seriesId?: string;
  visitId?: string;
  ids?: string[];
}

interface StaffBrief {
  id: string;
  businessId: string;
  userId: string | null;
  name: string;
  status: string;
  confirmMode: string;
  calendarVisibility: string;
  onlineBookingEnabled: boolean;
  accepts: string;
  prepayment: unknown;
  bookingRules: unknown;
  serviceIds: unknown;
  locations: { locationId: string }[];
}

const STAFF_SELECT = {
  id: true,
  businessId: true,
  userId: true,
  name: true,
  status: true,
  confirmMode: true,
  calendarVisibility: true,
  onlineBookingEnabled: true,
  accepts: true,
  prepayment: true,
  bookingRules: true,
  serviceIds: true,
  locations: { select: { locationId: true } },
} as const;

/** Что поменялось в одной записи — для событий, SSE и сброса кеша окон после коммита */
interface Touched {
  businessIds: Set<string>;
  staffIds: Set<string>;
  personKeys: Set<string>;
  dates: Set<string>;
}

const touched = (): Touched => ({ businessIds: new Set(), staffIds: new Set(), personKeys: new Set(), dates: new Set() });

/**
 * Записи (docs/backend/01 §7, 02 §4, 04 §4; PLAN §6 №7): создание по единому потоку, перенос, статусы, удаление и
 * восстановление (7 дней), подтверждение (В-03), ручная предоплата (В-05), отмена клиентом (В-04). Всё, что занимает
 * время, идёт через «замок на мастера» (availability/occupy.ts, PLAN §4.2) в той же транзакции.
 */
@Injectable()
export class BookingsService {
  private readonly tzCache = new Map<string, string>();

  constructor(
    readonly prisma: PrismaService,
    private readonly occupy: OccupyService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    readonly settings: JournalSettingsService,
    private readonly loyaltyProgram: LoyaltyProgramService,
    private readonly techCards: TechCardsService,
    private readonly upsell: UpsellService,
  ) {}

  // ─────────── пояса ───────────

  async tzOfLocation(db: Db, locationId: string | null | undefined): Promise<string> {
    if (!locationId) return DEFAULT_TZ;
    const hit = this.tzCache.get(locationId);
    if (hit) return hit;
    const loc = await db.location.findUnique({ where: { id: locationId }, select: { tz: true } });
    const tz = loc?.tz ?? DEFAULT_TZ;
    this.tzCache.set(locationId, tz);
    return tz;
  }

  async tzOfBusiness(db: Db, businessId: string): Promise<string> {
    const key = `biz:${businessId}`;
    const hit = this.tzCache.get(key);
    if (hit) return hit;
    const loc = await db.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
    const tz = loc?.tz ?? DEFAULT_TZ;
    this.tzCache.set(key, tz);
    return tz;
  }

  async view(db: Db, row: BookingRow): Promise<BookingView> {
    return bookingView(row, await this.tzOfLocation(db, row.locationId));
  }

  async views(db: Db, rows: BookingRow[]): Promise<BookingView[]> {
    const out: BookingView[] = [];
    for (const r of rows) out.push(await this.view(db, r));
    return out;
  }

  async extras(db: Db, row: BookingRow) {
    return extrasView(row, await this.tzOfLocation(db, row.locationId));
  }

  // ─────────── чтение ───────────

  async find(db: Db, businessIds: string[], id: string): Promise<BookingRow> {
    const row = await db.booking.findFirst({ where: { id, businessId: { in: businessIds } } });
    if (!row) throw new ApiError('not_found', 'Booking not found');
    return row;
  }

  async list(q: BookingQuery): Promise<BookingView[]> {
    const tz = await this.tzOfBusiness(this.prisma, q.businessIds[0] ?? '');
    const where: Prisma.BookingWhereInput = { businessId: { in: q.businessIds } };
    if (!q.includeDeleted) where.deletedAt = null;
    if (q.locationId) where.locationId = q.locationId;
    if (q.clientId) where.clientId = q.clientId;
    if (q.appUserId) where.appUserId = q.appUserId;
    if (q.statuses?.length) where.status = { in: q.statuses };
    if (q.groupEventId) where.groupEventId = q.groupEventId;
    if (q.seriesId) where.seriesId = q.seriesId;
    if (q.visitId) where.visitId = q.visitId;
    if (q.ids) where.id = { in: q.ids };
    const range: Prisma.DateTimeFilter = {};
    if (q.from) range.gte = localDayRangeUtc(q.from, tz).from;
    if (q.to) range.lt = localDayRangeUtc(q.to, tz).to;
    if (q.from || q.to) where.startAt = range;
    let rows = await this.prisma.booking.findMany({ where, orderBy: { startAt: 'asc' } });
    if (q.staffId) rows = rows.filter((b) => b.staffId === q.staffId || arr<ServiceLine>(b.services).some((l) => l.staffId === q.staffId));
    return this.views(this.prisma, rows);
  }

  // ─────────── занятость записи ───────────

  private async staffBriefs(db: Db, ids: string[]): Promise<Map<string, StaffBrief>> {
    const rows = await db.staff.findMany({ where: { id: { in: [...new Set(ids)] } }, select: STAFF_SELECT });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async bufferOf(db: Db, lines: readonly ServiceLine[]): Promise<number> {
    const ids = [...new Set(lines.map((l) => l.serviceId))];
    if (!ids.length) return 0;
    const rows = await db.service.findMany({ where: { id: { in: ids } }, select: { bufferAfterMin: true } });
    return Math.max(0, ...rows.map((r) => r.bufferAfterMin ?? 0));
  }

  /** Экземпляр ресурса или сам ресурс → ресурс, число экземпляров, экземпляр */
  private async resourceBlocks(db: Db, businessId: string, ids: readonly string[]): Promise<{ resourceId: string; instances: number; instanceId: string | null }[]> {
    if (!ids.length) return [];
    const resources = await db.resource.findMany({ where: { businessId }, select: { id: true, instances: true } });
    const out: { resourceId: string; instances: number; instanceId: string | null }[] = [];
    for (const id of ids) {
      const direct = resources.find((r) => r.id === id);
      if (direct) {
        out.push({ resourceId: direct.id, instances: Math.max(1, arr(direct.instances).length), instanceId: null });
        continue;
      }
      const owner = resources.find((r) => arr<{ id: string }>(r.instances).some((i) => i.id === id));
      if (owner) out.push({ resourceId: owner.id, instances: Math.max(1, arr(owner.instances).length), instanceId: id });
    }
    return out;
  }

  /**
   * Занять время записи (все люди строк + ресурсы) в транзакции. Возвращает ключи людей для сброса кеша.
   * replace — перенос/правка: прежняя занятость этой записи снимается в той же транзакции.
   */
  async occupyBooking(
    tx: Tx,
    row: Pick<BookingRow, 'id' | 'businessId' | 'locationId' | 'staffId' | 'startAt' | 'durationMin' | 'workplace' | 'holdUntil' | 'status'> & { services: unknown; resourceIds: unknown },
    opts: { replace?: boolean; allowOverlap?: boolean; ignoreNoShow?: boolean } = {},
  ): Promise<string[]> {
    const lines = arr<ServiceLine>(row.services);
    const staffIds = [...new Set([row.staffId, ...lines.map((l) => l.staffId).filter(Boolean)])];
    const staff = await this.staffBriefs(tx, staffIds);
    const buffer = await this.bufferOf(tx, lines);
    const endAt = addMin(row.startAt, row.durationMin);
    const endWithBuffer = addMin(row.startAt, row.durationMin + buffer);
    const blocks: BlockInput[] = staffIds
      .map((id) => staff.get(id))
      .filter((s): s is StaffBrief => Boolean(s))
      .map((s) => ({
        personKey: personKeyOf(s),
        staffId: s.id,
        businessId: row.businessId,
        locationId: row.locationId,
        workplace: row.workplace,
        startAt: row.startAt,
        endAt: endWithBuffer,
        serviceEndAt: endAt,
        source: 'booking' as const,
        sourceId: row.id,
        visibilityLabel: visibilityOf(row.workplace),
        holdUntil: row.holdUntil,
      }));
    const resources: ResourceBlockInput[] = (await this.resourceBlocks(tx, row.businessId, arr(row.resourceIds))).map((r) => ({
      resourceId: r.resourceId,
      instances: r.instances,
      instanceId: r.instanceId,
      businessId: row.businessId,
      startAt: row.startAt,
      endAt: endWithBuffer,
      source: 'booking' as const,
      sourceId: row.id,
      holdUntil: row.holdUntil,
    }));
    const keys = await this.occupy.occupy(tx, {
      blocks,
      resources,
      ...(opts.replace ? { replace: { source: 'booking' as const, sourceId: row.id } } : {}),
      allowOverlap: opts.allowOverlap,
      ignoreNoShow: opts.ignoreNoShow,
    });
    if (row.status === 'no_show') await this.occupy.setNoShow(tx, 'booking', row.id, true);
    return keys;
  }

  /** Подобрать по одному свободному экземпляру каждого ресурса, привязанного к услугам (F-16-011…013) */
  private async pickResources(tx: Tx, businessId: string, locationId: string, serviceIds: string[], startAt: Date, endAt: Date): Promise<string[]> {
    const required = (await tx.resource.findMany({ where: { businessId, locationId, active: true }, select: { id: true, instances: true, serviceIds: true } })).filter((r) =>
      arr(r.serviceIds).some((id) => serviceIds.includes(id)),
    );
    if (!required.length) return [];
    const now = new Date();
    const picked: string[] = [];
    for (const r of required) {
      const instances = arr<{ id: string }>(r.instances).map((i) => i.id);
      const busy = await tx.resourceBusy.findMany({
        where: { resourceId: r.id, active: true, startAt: { lt: endAt }, endAt: { gt: startAt }, OR: [{ holdUntil: null }, { holdUntil: { gt: now } }] },
        select: { instanceId: true },
      });
      // Без исключения: занятость человека проверяет замок первым (slot_taken важнее resource_unavailable, как в моке);
      // нет свободного экземпляра — occupy() под замком ответит resource_unavailable
      const taken = new Set(busy.map((b) => b.instanceId).filter(Boolean));
      picked.push(instances.find((id) => !taken.has(id)) ?? instances[0] ?? r.id);
    }
    return picked;
  }

  // ─────────── события записи (BookingEvent) ───────────

  private freedOf(prev: BookingRow, tz: string) {
    return { staffId: prev.staffId, locationId: prev.locationId, start: utcToLocal(prev.startAt, tz), durationMin: prev.durationMin };
  }

  async logEvents(tx: Tx, prev: BookingRow | null, next: BookingRow, by: string, extra: { reason?: string } = {}): Promise<void> {
    const tz = await this.tzOfLocation(tx, next.locationId);
    const base = {
      bookingId: next.id,
      businessId: next.businessId,
      staffId: next.staffId,
      clientId: next.clientId,
      appUserId: next.appUserId,
      byRef: by,
      startLocal: utcToLocal(next.startAt, tz),
    };
    const rows: Prisma.BookingEventCreateManyInput[] = [];
    if (!prev) rows.push({ id: newId('bookingEvent'), ...base, kind: 'created', toStatus: next.status });
    else {
      const wasBusy = occupiesTime(prev);
      if (next.deletedAt && !prev.deletedAt) {
        rows.push({ id: newId('bookingEvent'), ...base, kind: 'deleted', ...(wasBusy ? { freed: this.freedOf(prev, tz) } : {}) });
      } else {
        if (prev.status !== next.status) {
          rows.push({
            id: newId('bookingEvent'),
            ...base,
            kind: 'status',
            fromStatus: prev.status,
            toStatus: next.status,
            ...(next.cancelledLate && !prev.cancelledLate ? { late: true } : {}),
            ...(next.cancelReason && !prev.cancelReason ? { reason: next.cancelReason } : extra.reason ? { reason: extra.reason } : {}),
            ...(wasBusy && !occupiesTime(next) ? { freed: this.freedOf(prev, tz) } : {}),
          });
        }
        if (prev.startAt.getTime() !== next.startAt.getTime() || prev.staffId !== next.staffId) {
          rows.push({
            id: newId('bookingEvent'),
            ...base,
            kind: 'moved',
            prevStart: utcToLocal(prev.startAt, tz),
            ...(prev.staffId !== next.staffId ? { prevStaffId: prev.staffId } : {}),
            ...(wasBusy && occupiesTime(next) ? { freed: this.freedOf(prev, tz) } : {}),
          });
        }
      }
    }
    if (rows.length) await tx.bookingEvent.createMany({ data: rows });
    if (next.appUserId) await this.pushInbox(tx, next, rows, next.appUserId, by);
    await this.notifyStaff(tx, next, rows, by);
  }

  /**
   * Лента `/v1/me/inbox` (F-14-055, этап 9): те же переходы, что уже пишет `logEvents` в `booking_events`, но
   * персистентно и с собственным `readAt` на клиента — не переизобретаем правило перехода, только маппим kind.
   * Своё же действие клиента (`by === 'client'`, F-00-130-соседнее: не уведомлять человека о его собственном клике)
   * не заводит запись «создано»/«перенесено»; статусы, которые может выставить только бизнес/система, — заводят всегда.
   */
  private async pushInbox(tx: Tx, next: BookingRow, events: Prisma.BookingEventCreateManyInput[], appUserId: string, by: string): Promise<void> {
    const rows: Prisma.InboxItemCreateManyInput[] = [];
    const pushable: { eventId: string; kind: string; startLocal: string }[] = [];
    for (const e of events) {
      let kind: string | undefined;
      let bookingId: string | undefined = e.bookingId;
      if (e.kind === 'created' && by !== 'client') kind = 'booking_created';
      else if (e.kind === 'deleted') {
        kind = 'salon_deleted';
        bookingId = undefined; // запись уже удалена — ссылка на неё клиенту ничего не откроет (как мок)
      } else if (e.kind === 'moved' && by !== 'client') kind = 'salon_moved';
      else if (e.kind === 'status') {
        if (e.toStatus === 'scheduled' && e.fromStatus === 'awaiting_confirmation') kind = 'salon_confirmed';
        else if (e.toStatus === 'cancelled_by_master') kind = 'cancelled_by_master';
        else if (e.reason === 'prepayment_expired') kind = 'prepayment_expired';
      }
      if (!kind) continue;
      rows.push({ id: newId('inboxItem'), appUserId, kind, businessId: e.businessId, staffId: e.staffId, bookingId, params: { start: e.startLocal } as Prisma.InputJsonValue });
      pushable.push({ eventId: e.id as string, kind, startLocal: e.startLocal as string });
    }
    // Пишем в той же транзакции, что и booking_events (атомарно); живой пуш «есть новое» через SSE — сюда
    // не добавляем намеренно: сама transaction ещё не закоммичена, публикация раньше коммита рискует прийти на
    // несуществующие данные (тот же приём, что `booking.changed`/`staff:*` этого файла — публикуются ПОСЛЕ
    // `$transaction`, см. touched()/t.businessIds ниже). Колокольчик ленты обновится при следующем открытии
    // экрана; постоянный SSE-канал для inbox — доработка следующего среза, не блокирует этап 9.
    if (rows.length) await tx.inboxItem.createMany({ data: rows });
    // Этап 10 (05 §3.1): те же переходы шлют настоящий push, а не только тихую строку в ленте — closes
    // ровно тот разрыв, что зафиксировала PROGRESS.md этапа 9 («лента… не пуш»). Один и тот же dedupeKey
    // на bookingEvent.id — повторный вызов транзакции (не бывает, но дёшево подстраховаться) не задвоит.
    if (pushable.length) {
      const [business, user] = await Promise.all([
        tx.business.findUnique({ where: { id: next.businessId }, select: { name: true } }),
        tx.user.findUnique({ where: { id: appUserId }, select: { locale: true } }),
      ]);
      const locale: Locale = isLocale(user?.locale) ? user!.locale : 'ru';
      const serviceId = arr<ServiceLine>(next.services)[0]?.serviceId;
      const service = serviceId ? await tx.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : null;
      const serviceName = pickRu(service?.name) ?? '';
      const businessName = business?.name ?? 'BookTime';
      for (const p of pushable) {
        const def = notifyKindOf(p.kind);
        if (!def) continue;
        const time = p.startLocal.slice(11, 16);
        const custom = await customTemplateOf(this.prisma, next.businessId, p.kind, locale);
        const body = custom ? renderTemplate(custom, { service: serviceName, time, place: businessName }) : t(locale, def.messageKey, { service: serviceName, time, place: businessName });
        await enqueueClientNotification(tx, {
          businessId: next.businessId,
          kind: p.kind,
          appUserId,
          title: businessName,
          body,
          dedupeKey: `client:${p.kind}:${p.eventId}`,
        });
      }
    }
  }

  /**
   * Бизнесу (05 §3.2): новая онлайн-запись клиента + клиент сам отменил/перенёс — мастеру и админам салона.
   * Только события, где действующее лицо — клиент или сам онлайн-канал; правку персонала себе не шлём.
   */
  private async notifyStaff(tx: Tx, next: BookingRow, events: Prisma.BookingEventCreateManyInput[], by: string): Promise<void> {
    let eventKey: 'new_booking' | 'client_cancelled' | 'client_rescheduled' | undefined;
    let eventId: string | undefined;
    for (const e of events) {
      if (e.kind === 'created' && isOnlineSource(next.source)) {
        eventKey = 'new_booking';
        eventId = e.id as string;
      } else if (e.kind === 'status' && by === 'client' && e.toStatus && isCancelled(e.toStatus)) {
        eventKey = 'client_cancelled';
        eventId = e.id as string;
      } else if (e.kind === 'moved' && by === 'client') {
        eventKey = 'client_rescheduled';
        eventId = e.id as string;
      }
    }
    if (!eventKey || !eventId) return;
    const [staff, admins, client] = await Promise.all([
      tx.staff.findUnique({ where: { id: next.staffId }, select: { id: true, userId: true } }),
      tx.staff.findMany({ where: { businessId: next.businessId, role: { in: ['owner', 'admin'] }, status: 'active', userId: { not: null } }, select: { id: true, userId: true } }),
      next.clientId ? tx.client.findUnique({ where: { id: next.clientId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    const recipients = new Map<string, string>(); // userId -> staffId (для проверки StaffNotifyPref)
    if (staff?.userId) recipients.set(staff.userId, staff.id);
    for (const a of admins) if (a.userId) recipients.set(a.userId, a.id);
    if (recipients.size === 0) return;
    const def = notifyKindOf(`staff_${eventKey}`);
    if (!def) return;
    const tz = await this.tzOfLocation(tx, next.locationId);
    const time = utcToLocal(next.startAt, tz).slice(11, 16);
    const serviceId = arr<ServiceLine>(next.services)[0]?.serviceId;
    const [service, users] = await Promise.all([
      serviceId ? tx.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : Promise.resolve(null),
      tx.user.findMany({ where: { id: { in: [...recipients.keys()] } }, select: { id: true, locale: true } }),
    ]);
    const localeByUser = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : ('ru' as Locale)]));
    const params = { client: client?.name ?? 'Client', service: pickRu(service?.name) ?? '', time };
    for (const [userId, staffId] of recipients) {
      if (!(await isStaffEventEnabled(this.prisma, staffId, eventKey))) continue;
      const locale = localeByUser.get(userId) ?? 'ru';
      await enqueueOutbox(tx, {
        businessId: next.businessId,
        app: 'business',
        kind: def.kind,
        recipientUserId: userId,
        title: 'BookTime',
        body: t(locale, def.messageKey, params),
        dedupeKey: `staff:${def.kind}:${eventId}:${userId}`,
      });
    }
  }

  /** Освободилось время в будущем → раздача окна (В-18): сначала лист ожидания */
  async freeSlot(tx: Tx, prev: BookingRow): Promise<void> {
    if (prev.groupEventId || prev.startAt.getTime() <= Date.now()) return;
    const tz = await this.tzOfLocation(tx, prev.locationId);
    const date = utcToLocalDate(prev.startAt, tz);
    const startMin = toMinutes(utcToLocal(prev.startAt, tz).slice(11, 16));
    const serviceIds = arr<ServiceLine>(prev.services).map((l) => l.serviceId);
    const entries = await tx.waitlistEntry.findMany({ where: { businessId: prev.businessId, bookingId: null }, select: { id: true, staffIds: true, serviceIds: true, wishes: true, appUserId: true, notifiedTimes: true } });
    // Длительности услуг, которые ждут: окно короче услуги не предлагаем — записаться в него нельзя (сценарии 30.09:
    // окно 30 мин ушло ждавшей услугу на 45 мин). Как collectRecipients мока (journal-offers, freeMin).
    const wantedIds = [...new Set([...entries.flatMap((e) => arr<string>(e.serviceIds)), ...serviceIds])];
    const durations = new Map(
      (wantedIds.length ? await tx.service.findMany({ where: { id: { in: wantedIds } }, select: { id: true, durationMin: true } }) : []).map((s) => [s.id, s.durationMin]),
    );
    const window = { staffId: prev.staffId, serviceIds, durationMin: prev.durationMin, date, startMin };
    const offers = new Map(entries.map((e) => [e.id, waitlistOffer(e, window, durations)]));
    const offeredService = (e: { id: string }) => offers.get(e.id);
    const matches = entries.filter((e) => offers.get(e.id) !== null);
    const discount = (await this.settings.get(prev.businessId, tx)).hotDiscountPct[prev.staffId] ?? 0;
    await tx.freedSlot.create({
      data: {
        id: newId('freedSlot'),
        businessId: prev.businessId,
        staffId: prev.staffId,
        locationId: prev.locationId,
        startAt: prev.startAt,
        endAt: addMin(prev.startAt, prev.durationMin),
        durationMin: prev.durationMin,
        sourceBookingId: prev.id,
        stage: 'waitlist',
        waitlistIds: matches.map((m) => m.id),
        discountPct: discount,
      },
    });
    if (matches.length) {
      // Отметка «Уведомлён» — та же история, что у «Проверить лист» и «Предложить окно» (экран листа и панель журнала)
      const at = new Date();
      for (const m of matches) {
        await tx.waitlistEntry.update({ where: { id: m.id }, data: { notifiedAt: at, notifiedTimes: [...arr<string>(m.notifiedTimes), at.toISOString()] as Prisma.InputJsonValue } });
      }
      await this.notifyWaitlistMatches(tx, prev, matches.map((m) => ({ ...m, serviceId: offeredService(m) ?? undefined })), tz);
    }
  }

  /** Время окна для текста («04.10 13:30») и ленты клиента (дата, время, услуга — для кнопки «Записаться» на это окно) */
  private async slotOfferParts(db: Db, slot: { startAt: Date; serviceId?: string }, tz: string) {
    const local = utcToLocal(slot.startAt, tz);
    const service = slot.serviceId ? await db.service.findUnique({ where: { id: slot.serviceId }, select: { name: true } }) : null;
    const names = (service?.name as Record<string, string> | null) ?? {};
    return {
      when: `${local.slice(8, 10)}.${local.slice(5, 7)} ${local.slice(11, 16)}`,
      serviceName: (locale: Locale) => names[locale] || names.ru || '',
      params: { date: local.slice(0, 10), time: local.slice(11, 16), ...(slot.serviceId ? { serviceId: slot.serviceId } : {}) },
      /** Тап по пушу — сразу запись на это окно (тот же адрес, что кнопка «Записаться» в ленте приложения) */
      url: (staffId: string) => `/book?staff=${encodeURIComponent(staffId)}&slot=${encodeURIComponent(local)}${slot.serviceId ? `&service=${encodeURIComponent(slot.serviceId)}` : ''}`,
    };
  }

  /** Первая волна раздачи (В-18): у кого приложение — реальный пуш «освободилось окно», не только пометка */
  private async notifyWaitlistMatches(tx: Tx, prev: BookingRow, matches: { id: string; appUserId?: string | null; serviceId?: string }[], tz: string): Promise<void> {
    const withApp = matches.filter((m) => m.appUserId);
    if (!withApp.length) return;
    const def = notifyKindOf('waitlist_available')!;
    const [staff, users] = await Promise.all([
      tx.staff.findUnique({ where: { id: prev.staffId }, select: { name: true } }),
      tx.user.findMany({ where: { id: { in: withApp.map((m) => m.appUserId!) } }, select: { id: true, locale: true } }),
    ]);
    const localeByUser = new Map(users.map((u) => [u.id, isLocale(u.locale) ? u.locale : ('ru' as Locale)]));
    const staffName = staff?.name ?? 'BookTime';
    for (const m of withApp) {
      const locale = localeByUser.get(m.appUserId!) ?? 'ru';
      // Время и услуга — в тексте пуша и в ленте (без них клиент видел «Освободилось время» без времени и без кнопки)
      const slot = await this.slotOfferParts(tx, { startAt: prev.startAt, serviceId: m.serviceId }, tz);
      await enqueueClientNotification(tx, {
        businessId: prev.businessId,
        kind: def.kind,
        appUserId: m.appUserId!,
        title: staffName,
        body: t(locale, 'waitlist.slotAvailableAt', { staff: staffName, when: slot.when, service: slot.serviceName(locale) }),
        url: slot.url(prev.staffId),
        dedupeKey: `client:waitlist:${m.id}:${prev.id}`,
        inbox: { kind: 'waitlist_slot', businessId: prev.businessId, staffId: prev.staffId, params: slot.params },
      });
    }
  }

  // ─────────── после коммита: кеш окон и живые события ───────────

  private touch(t: Touched, row: BookingRow, tz: string, keys: string[] = []): void {
    t.businessIds.add(row.businessId);
    t.staffIds.add(row.staffId);
    for (const l of arr<ServiceLine>(row.services)) if (l.staffId) t.staffIds.add(l.staffId);
    for (const k of keys) t.personKeys.add(k);
    t.dates.add(utcToLocalDate(row.startAt, tz));
  }

  async publish(t: Touched, bookingIds: string[] = []): Promise<void> {
    await this.availability.invalidate({ businessIds: [...t.businessIds], staffIds: [...t.staffIds], personKeys: [...t.personKeys], dates: [...t.dates] });
    for (const b of t.businessIds) {
      for (const d of t.dates) await this.live.publish(`biz:${b}:day:${d}`, { type: 'booking.changed', data: { bookingIds, date: d } });
    }
    for (const s of t.staffIds) await this.live.publish(`staff:${s}`, { type: 'booking.changed', data: { bookingIds } });
  }

  // ─────────── клиент записи ───────────

  private async linkClient(
    tx: Tx,
    businessId: string,
    who: PlaceInput['client'],
    online: boolean,
  ): Promise<{ clientId?: string; appUserId?: string; createdClient?: Record<string, unknown>; client?: { id: string; name: string; blocked: boolean | null; gender: string; appUserId: string | null }; appUserGender?: string }> {
    if (who?.clientId) {
      const c = await tx.client.findFirst({ where: { id: who.clientId, businessId, deletedAt: null } });
      if (!c) throw new ApiError('not_found', 'Client not found');
      return { clientId: c.id, appUserId: c.appUserId ?? undefined, client: c };
    }
    if (who?.appUserId) {
      const user = await tx.user.findUnique({ where: { id: who.appUserId }, include: { appProfile: true } });
      if (!user) throw new ApiError('not_found', 'App user not found');
      const phone = user.phone ? (normalizePhone(user.phone) ?? user.phone) : null;
      const found =
        (await tx.client.findFirst({ where: { businessId, appUserId: user.id, deletedAt: null } })) ??
        (phone ? await tx.client.findFirst({ where: { businessId, phone, deletedAt: null } }) : null);
      const gender = user.appProfile?.gender ?? 'unknown';
      if (found) {
        if (!found.appUserId) await tx.client.update({ where: { id: found.id }, data: { appUserId: user.id } });
        return { clientId: found.id, appUserId: user.id, client: found, appUserGender: gender };
      }
      if (!phone) return { appUserId: user.id, appUserGender: gender };
      const id = newId('client');
      const created = await tx.client.create({
        data: { id, businessId, phone, name: user.name, gender, birthday: user.appProfile?.birthday ?? null, tags: [], appUserId: user.id, source: 'booking' },
      });
      return { clientId: id, appUserId: user.id, createdClient: coreClient(created), client: created, appUserGender: gender };
    }
    if (who?.phone) {
      const phone = normalizePhone(who.phone);
      if (!phone) throw new ApiError('invalid_phone', 'Invalid phone');
      const found = await tx.client.findFirst({ where: { businessId, phone, deletedAt: null } });
      if (found) return { clientId: found.id, appUserId: found.appUserId ?? undefined, client: found };
      const id = newId('client');
      const created = await tx.client.create({ data: { id, businessId, phone, name: who.name?.trim() || phone, gender: 'unknown', tags: [], source: 'booking' } });
      return { clientId: id, createdClient: coreClient(created), client: created };
    }
    if (online) throw new ApiError('client_required', 'Client required');
    return {};
  }

  /** «Свой» клиент мастера (F-00-065): уже был записан к нему */
  private async isOwnClient(tx: Tx, staffId: string, who: { clientId?: string; appUserId?: string }): Promise<boolean> {
    if (!who.clientId && !who.appUserId) return false;
    const n = await tx.booking.count({
      where: {
        deletedAt: null,
        status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] },
        staffId,
        OR: [...(who.clientId ? [{ clientId: who.clientId }] : []), ...(who.appUserId ? [{ appUserId: who.appUserId }] : [])],
      },
    });
    return n > 0;
  }

  /** Склейка записей клиента за день в визит (F-01-041): соседняя активная запись в пределах интервала */
  async resolveVisit(db: Db, input: { businessId: string; clientId?: string | null; startAt: Date; durationMin: number; excludeId?: string; tz: string }): Promise<string | undefined> {
    if (!input.clientId) return undefined;
    const interval = (await this.settings.get(input.businessId, db)).visitIntervalMin;
    if (interval <= 0) return undefined;
    const day = localDayRangeUtc(utcToLocalDate(input.startAt, input.tz), input.tz);
    const candidates = await db.booking.findMany({
      where: {
        clientId: input.clientId,
        deletedAt: null,
        status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] },
        startAt: { gte: day.from, lt: day.to },
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      orderBy: { startAt: 'asc' },
    });
    const from = input.startAt.getTime();
    const to = from + input.durationMin * 60_000;
    for (const b of candidates) {
      const bFrom = b.startAt.getTime();
      const bTo = bFrom + b.durationMin * 60_000;
      const gap = from >= bTo ? (from - bTo) / 60_000 : bFrom >= to ? (bFrom - to) / 60_000 : 0;
      if (interval >= 1440 || gap <= interval) {
        if (b.visitId) return b.visitId;
        const visitId = newId('visit');
        await db.booking.update({ where: { id: b.id }, data: { visitId } });
        return visitId;
      }
    }
    return undefined;
  }

  /**
   * ⭐ Сколько раз клиент не пришёл к ЭТОМУ мастеру за последние `months` месяцев (В-07: свой счётчик у каждого
   * мастера): статус «Не пришёл» или отмена позже срока (F-00-098). Клиент — карточка бизнеса или пользователь приложения.
   */
  async recentNoShows(db: Db, q: { staffId: string; clientId?: string | null; appUserId?: string | null; months: number }): Promise<number> {
    const who = [...(q.clientId ? [{ clientId: q.clientId }] : []), ...(q.appUserId ? [{ appUserId: q.appUserId }] : [])];
    if (!who.length) return 0;
    const now = new Date();
    return db.booking.count({
      where: {
        staffId: q.staffId,
        deletedAt: null,
        OR: who,
        startAt: { gte: noShowPeriodStart(now, q.months), lte: now },
        AND: [{ OR: [{ status: 'no_show' }, { status: 'cancelled_by_client', cancelledLate: true }] }],
      },
    });
  }

  // ─────────── создание ───────────

  /**
   * Единый поток записи (rules/booking-flow фронта): приложение, ссылка/виджет, журнал, внешняя система. Онлайн —
   * окно должно предлагаться клиенту (окна сервера, 04); журнал — только занятость (вне часов и в прошлом — можно,
   * экран предупреждает сам, F-01-215). Двойная запись невозможна — «замок на мастера».
   */
  async place(actor: BookingActor, input: PlaceInput, opts: { idempotent?: boolean } = {}): Promise<{ booking: BookingView; client?: Record<string, unknown> }> {
    void opts;
    const online = isOnlineSource(input.source);
    if (!online && actor.ctx?.member) assertJournal(actor.ctx, 'journal.create', input.staffId);
    const tz = await this.tzOfLocation(this.prisma, input.locationId ?? null);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.start)) throw new ApiError('validation', 'Invalid start', { start: 'YYYY-MM-DDTHH:mm' });

    // ⭐ Допродажа: у онлайн-записи пометку «сопутствующая» ставит только сервер (из addOns, по списку услуги)
    if (online) input = { ...input, services: input.services.map(({ upsellOf: _u, ...l }) => l) };
    const mainServiceIds = input.services.filter((l) => !l.upsellOf).map((l) => l.serviceId);
    if (input.addOns?.serviceIds?.length && !input.groupEventId) {
      const extra = await this.upsell.serviceLines(this.prisma, input.businessId, input.staffId, mainServiceIds, input.addOns.serviceIds);
      input = { ...input, services: [...input.services, ...extra] };
    }

    // Онлайн: начало должно предлагаться клиенту — окна считает сервер (docs/backend/04). Проверка до транзакции
    // (чтение), а двойную запись всё равно ловит замок ниже. Несколько услуг (в т. ч. сопутствующие) — окно под их
    // общую длительность («от» — сумма нижних, «до» — сумма верхних) и наибольший запас, как считает виджет.
    if (online && !input.groupEventId) {
      const svc = input.services[0] ? await this.prisma.service.findFirst({ where: { id: input.services[0].serviceId, businessId: input.businessId } }) : null;
      if (svc) {
        const ids = input.services.map((l) => l.serviceId);
        const all = ids.length > 1 ? await this.prisma.service.findMany({ where: { id: { in: ids }, businessId: input.businessId } }) : [svc];
        const list = ids.map((id) => all.find((x) => x.id === id)).filter((x): x is typeof svc => Boolean(x));
        const sumMin = list.reduce((a, x) => a + x.durationMin, 0);
        const sumMax = list.reduce((a, x) => a + (x.durationMax != null && x.durationMax > x.durationMin ? x.durationMax : x.durationMin), 0);
        const offered = await this.availability.freeSlots(input.businessId, {
          staffId: input.staffId,
          date: input.start.slice(0, 10),
          durationMin: list.length > 1 ? sumMin : svc.durationMin,
          durationMax: list.length > 1 ? (sumMax > sumMin ? sumMax : undefined) : (svc.durationMax ?? undefined),
          bufferAfterMin: list.length > 1 ? Math.max(0, ...list.map((x) => x.bufferAfterMin ?? 0)) : (svc.bufferAfterMin ?? 0),
          locationId: input.locationId,
          serviceId: svc.id,
        });
        if (!offered.some((s) => s.start === input.start)) throw new ApiError('slot_taken', 'Slot is not offered');
      }
    }

    const t = touched();
    const journal = await this.settings.get(input.businessId);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const staff = await tx.staff.findFirst({ where: { id: input.staffId, businessId: input.businessId, deletedAt: null }, select: STAFF_SELECT });
        const business = await tx.business.findUnique({ where: { id: input.businessId }, select: { id: true, status: true, bookingRules: true } });
        if (!staff || !business) throw new ApiError('not_found', 'Staff or business not found');
        if (!input.services.length && !input.groupEventId) throw new ApiError('service_unavailable', 'No services');

        const services = await tx.service.findMany({ where: { id: { in: input.services.map((l) => l.serviceId) }, businessId: input.businessId } });
        const pairs = input.services.map((line) => {
          const svc = services.find((s) => s.id === line.serviceId);
          if (!svc || !svc.active) throw new ApiError('service_unavailable', 'Service unavailable');
          if (online) {
            const lineStaff = line.staffId ?? staff.id;
            const assigned = arr(svc.staffIds).includes(lineStaff) || arr(staff.serviceIds).includes(svc.id);
            // ⭐ «Выдача заказа» — только по ссылке заказа (orderPickup), в общем онлайн-потоке её нет
            const pickup = svc.kind === PICKUP_KIND;
            if (pickup !== Boolean(input.orderPickup) || (!svc.onlineBookable && !pickup) || !assigned) throw new ApiError('service_unavailable', 'Service is not bookable online');
          }
          return { svc, line };
        });

        const who = await this.linkClient(tx, input.businessId, input.client, online);

        const event = input.groupEventId ? await tx.groupEvent.findFirst({ where: { id: input.groupEventId, businessId: input.businessId } }) : null;
        if (input.groupEventId && (!event || event.status !== 'scheduled')) throw new ApiError('not_found', 'Event not found');
        const eventTz = event ? await this.tzOfLocation(tx, event.locationId) : tz;
        const start = event ? utcToLocal(event.startAt, eventTz) : input.start;

        if (online) {
          if (business.status !== 'active') throw new ApiError('business_inactive', 'Business is not active');
          if (staff.status !== 'active') throw new ApiError('staff_unavailable', 'Staff unavailable');
          if (!staff.onlineBookingEnabled) throw new ApiError('online_disabled', 'Online booking disabled');
          if (who.client?.blocked) throw new ApiError('client_blocked', 'Client blocked');
          const gender = who.client?.gender && who.client.gender !== 'unknown' ? who.client.gender : who.appUserGender;
          if (staff.accepts === 'women' && gender === 'male') throw new ApiError('accepts_mismatch', 'Staff accepts women only');
          if (staff.accepts === 'men' && gender === 'female') throw new ApiError('accepts_mismatch', 'Staff accepts men only');
        }

        const lines = pairs.map(({ svc, line }) =>
          ({
            ...makeServiceLine({ id: svc.id, durationMin: svc.durationMin, durationMax: svc.durationMax, priceMin: Number(svc.priceMin) }, line.staffId ?? staff.id, {
              qty: line.qty,
              discountPct: line.discountPct,
              unitPrice: line.unitPrice,
            }),
            ...(line.upsellOf ? { upsellOf: line.upsellOf } : {}),
          }),
        );
        const buffer = Math.max(0, ...pairs.map(({ svc }) => svc.bufferAfterMin ?? 0));
        let durationMin = linesDuration(lines);
        let locationId = input.locationId;
        if (event) {
          const taken = (await tx.booking.findMany({ where: { groupEventId: event.id, deletedAt: null, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } }, select: { services: true } })).reduce(
            (n, b) => n + Math.max(1, arr<ServiceLine>(b.services)[0]?.qty ?? 1),
            0,
          );
          const seats = Math.max(1, input.services[0]?.qty ?? 1);
          if (taken + seats > event.capacity) throw new ApiError('group_full', 'Event is full');
          durationMin = event.durationMin;
          locationId = event.locationId;
        }
        if (locationId && !event && !(await tx.location.findFirst({ where: { id: locationId, businessId: input.businessId, deletedAt: null }, select: { id: true } })))
          throw new ApiError('not_found', 'Location not found');
        locationId = locationId ?? staff.locations[0]?.locationId ?? (await tx.location.findFirst({ where: { businessId: input.businessId, deletedAt: null }, select: { id: true } }))?.id;
        if (!locationId) throw new ApiError('not_found', 'Location not found');
        const locTz = await this.tzOfLocation(tx, locationId);
        const startAt = localToUtc(start, locTz);
        const workplace = input.workplace ?? 'salon';
        // ⭐ Допродажа: товары — строки «товары визита» склада этого филиала, к оплате на визите (обычная продажа)
        const addOnGoods =
          input.addOns?.productIds?.length && !event
            ? await this.upsell.goodsLines(tx, { businessId: input.businessId, locationId, staffId: staff.id, mainServiceIds, productIds: input.addOns.productIds })
            : [];

        let resourceIds: string[];
        if (event) resourceIds = input.resourceIds ?? arr(event.resourceIds);
        else if (input.resourceIds?.length) resourceIds = input.resourceIds;
        else resourceIds = await this.pickResources(tx, input.businessId, locationId, lines.map((l) => l.serviceId), startAt, addMin(startAt, durationMin + buffer));

        const own = staff.calendarVisibility === 'mine' ? await this.isOwnClient(tx, staff.id, { clientId: who.clientId, appUserId: who.appUserId }) : true;
        const statusStaff = { confirmMode: staff.confirmMode, prepayment: staff.prepayment as PrepaymentRule | null, calendarVisibility: staff.calendarVisibility };
        // ⭐ Предоплата только от тех, кто не приходил (владелец, 01.10.2026): счётчик у ЭТОГО мастера за период (В-07)
        const noShowRule = online && statusStaff.prepayment?.onlyAfterNoShows ? normalizeNoShowRule(statusStaff.prepayment.onlyAfterNoShows) : undefined;
        const clientNoShows = noShowRule
          ? await this.recentNoShows(tx, { staffId: staff.id, clientId: who.clientId, appUserId: who.appUserId, months: noShowRule.months })
          : 0;
        let status: BookingStatus = online || !input.status ? newBookingStatus({ source: input.source, staff: statusStaff, workplace, isOwnClient: own, clientNoShows }) : input.status;
        if (online && input.orderPickup) status = 'scheduled';
        // О28: окно, которое предложил сам мастер, — он уже согласен: без второго подтверждения (предоплату ждём как обычно)
        if (online && input.acceptsOffer && status === 'awaiting_confirmation') status = 'scheduled';
        // О6 (как мок, meta.confirmAfterPayment): без предоплаты запись ждала бы мастера — после «Деньги пришли» она
        // пойдёт к нему в «Заявки», а не сразу в «Записан»
        const confirmAfterPayment =
          online && !input.acceptsOffer && status === 'awaiting_prepayment' && newBookingStatus({ source: input.source, staff: statusStaff, workplace, isOwnClient: own, prepaymentPaid: true, clientNoShows }) === 'awaiting_confirmation';
        const total = linesTotal(lines);
        const now = new Date();
        const rule = staff.prepayment as PrepaymentRule | null;
        const holdPrepay =
          status === 'awaiting_prepayment' && requiresPrepayment(input.source, rule, false, clientNoShows) ? addMin(now, Math.max(1, rule?.timeoutMin ?? PREPAYMENT_HOLD_MIN)) : null;
        const need = holdPrepay ? prepaymentNeed(rule, clientNoShows) : undefined;
        const exactPrice = pairs.every(({ svc }) => svc.priceMax == null || Number(svc.priceMax) === Number(svc.priceMin));
        const payInFull = Boolean(input.payInFull) && canPayInFull(rule, total, exactPrice);
        const prepayment = holdPrepay
          ? { amount: prepaymentAmount(rule, total, payInFull), paid: false, holdUntil: utcToLocal(holdPrepay, locTz), ...(payInFull ? { full: true } : {}), ...(confirmAfterPayment ? { confirmAfterPayment: true } : {}), ...(need?.reason === 'no_shows' ? { reason: 'no_shows', noShows: need.noShows, months: need.months } : {}) }
          : undefined;
        const confirmDeadline = status === 'awaiting_confirmation' && online ? confirmDeadlineOf(now, startAt) : null;
        const holdUntil = holdPrepay ?? confirmDeadline;
        const visitorName =
          input.visitorName ?? (input.client?.phone && who.client && input.client.name?.trim() && input.client.name.trim() !== who.client.name ? input.client.name.trim() : undefined);

        const id = newId('booking');
        const visitId = input.visitId ?? (await this.resolveVisit(tx, { businessId: input.businessId, clientId: who.clientId, startAt, durationMin, tz: locTz }));
        const row = await tx.booking.create({
          data: {
            id,
            businessId: input.businessId,
            locationId,
            staffId: staff.id,
            clientId: who.clientId ?? null,
            appUserId: who.appUserId ?? null,
            startAt,
            endAt: addMin(startAt, durationMin),
            durationMin,
            status,
            services: lines as unknown as Prisma.InputJsonValue,
            total: BigInt(total),
            resourceIds,
            workplace,
            source: input.source,
            createdByRef: online ? 'client' : (input.createdBy ?? actor.ctx?.member?.staffId ?? 'client'),
            forWhom: input.forWhom ?? 'self',
            visitorName: visitorName ?? null,
            comment: input.comment ?? null,
            prepayment: J(prepayment),
            holdUntil,
            confirmDeadline,
            groupEventId: event?.id ?? null,
            seriesId: input.seriesId ?? null,
            visitId: visitId ?? null,
            staffAssignment: input.staffAssignment ?? null,
            extras: addOnGoods.length ? ({ goodsLines: addOnGoods } as Prisma.InputJsonValue) : {},
            createdBy: actor.ctx?.member?.staffId ?? actor.ctx?.session?.userId ?? null,
            updatedBy: actor.ctx?.member?.staffId ?? null,
          },
        });
        let keys: string[] = [];
        if (!event && occupiesTime(row)) {
          keys = await this.occupyBooking(tx, row, { ignoreNoShow: online ? true : journal.settings.allowOverlapOverNoShow });
        }
        await this.logEvents(tx, null, row, actor.ref);
        await this.audit.record(tx, actor.ctx, { action: 'create', entityType: 'booking', entityId: id, businessId: input.businessId, after: { start, staffId: staff.id, status, total } });
        // «Пригласи подругу»: новый клиент по личной ссылке — к пригласившему (правила внутри; отказ запись не ломает)
        if (online && input.referralCode && who.clientId) await attachReferralInTx(tx, { businessId: input.businessId, inviteeClientId: who.clientId, code: input.referralCode, bookingId: id });
        this.touch(t, row, locTz, keys);
        return { row, createdClient: who.createdClient };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.publish(t, [result.row.id]);
    return { booking: await this.view(this.prisma, result.row), ...(result.createdClient ? { client: result.createdClient } : {}) };
  }

  /**
   * createBooking «как есть» (журнал, импорт, пакет): строки уже посчитаны окном. Двойная запись всё равно
   * невозможна — кроме записей задним числом (импорт истории, «внести прошлый визит»): они не держат будущее время.
   */
  async createRaw(actor: BookingActor, input: RawInput): Promise<BookingView> {
    if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.create', input.staffId);
    const t = touched();
    const journal = await this.settings.get(input.businessId);
    const row = await this.prisma.$transaction(
      async (tx) => {
        const staff = await tx.staff.findFirst({ where: { id: input.staffId, businessId: input.businessId }, select: { id: true } });
        if (!staff) throw new ApiError('not_found', 'Staff not found');
        const loc = await tx.location.findFirst({ where: { id: input.locationId, businessId: input.businessId }, select: { id: true } });
        const locationId = loc?.id ?? (await tx.location.findFirst({ where: { businessId: input.businessId, deletedAt: null }, select: { id: true } }))?.id;
        if (!locationId) throw new ApiError('not_found', 'Location not found');
        const tz = await this.tzOfLocation(tx, locationId);
        let clientId = input.clientId ?? null;
        if (clientId) {
          const c = await tx.client.findFirst({ where: { id: clientId, businessId: input.businessId }, select: { id: true } });
          if (!c) throw new ApiError('not_found', 'Client not found');
        } else if (input.appUserId) {
          clientId = (await this.linkClient(tx, input.businessId, { appUserId: input.appUserId }, false)).clientId ?? null;
        }
        const lines = input.services.map((l) => ({ ...l, staffId: l.staffId || input.staffId, qty: Math.max(1, l.qty ?? 1) }));
        const durationMin = input.durationMin ?? linesDuration(lines);
        const startAt = localToUtc(input.start, tz);
        const id = newId('booking');
        const visitId = input.visitId ?? (await this.resolveVisit(tx, { businessId: input.businessId, clientId, startAt, durationMin, tz }));
        const created = await tx.booking.create({
          data: {
            id,
            businessId: input.businessId,
            locationId,
            staffId: input.staffId,
            clientId,
            appUserId: input.appUserId ?? null,
            startAt,
            endAt: addMin(startAt, durationMin),
            durationMin,
            status: input.status,
            services: lines as unknown as Prisma.InputJsonValue,
            total: BigInt(linesTotal(lines)),
            resourceIds: input.resourceIds ?? [],
            workplace: input.workplace ?? 'salon',
            source: input.source,
            createdByRef: input.createdBy ?? actor.ctx?.member?.staffId ?? 'client',
            forWhom: input.forWhom ?? 'self',
            visitorName: input.visitorName ?? null,
            comment: input.comment ?? null,
            prepayment: J(input.prepayment),
            groupEventId: input.groupEventId ?? null,
            seriesId: input.seriesId ?? null,
            visitId: visitId ?? null,
            staffAssignment: input.staffAssignment ?? null,
            extras: (input.extraSeat ? { extraSeat: input.extraSeat } : {}) as Prisma.InputJsonValue,
            createdBy: actor.ctx?.member?.staffId ?? null,
            updatedBy: actor.ctx?.member?.staffId ?? null,
          },
        });
        let keys: string[] = [];
        if (!input.groupEventId && occupiesTime(created)) {
          const past = addMin(startAt, durationMin).getTime() <= Date.now();
          keys = await this.occupyBooking(tx, created, { allowOverlap: past, ignoreNoShow: journal.settings.allowOverlapOverNoShow });
        }
        await this.logEvents(tx, null, created, actor.ref);
        await this.audit.record(tx, actor.ctx, { action: 'create', entityType: 'booking', entityId: id, businessId: input.businessId, after: { start: input.start, staffId: input.staffId, status: input.status } });
        this.touch(t, created, tz, keys);
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.publish(t, [row.id]);
    return this.view(this.prisma, row);
  }

  // ─────────── правка и перенос ───────────

  /**
   * Правка записи (F-01-109…117): время, мастер, услуги, клиент, ресурсы. Изменилось время/мастер/длительность/
   * ресурсы — занятость пересчитывается под замком (перенос на занятое — 409 slot_taken). expectedUpdatedAt
   * (F-01-033): окно передаёт updatedAt записи, которую загрузило, — кто-то сохранил раньше → 409 conflict.
   */
  async update(actor: BookingActor, businessIds: string[], id: string, patch: BookingPatch, opts: { expectedUpdatedAt?: string; version?: number } = {}): Promise<BookingView> {
    const t = touched();
    const row = await this.prisma.$transaction(
      async (tx) => {
        const prev = await this.find(tx, businessIds, id);
        if (actor.ctx?.member) {
          assertJournal(actor.ctx, 'journal.edit', prev.staffId);
          if (patch.staffId && patch.staffId !== prev.staffId) assertJournal(actor.ctx, 'journal.edit', patch.staffId);
        }
        const tz = await this.tzOfLocation(tx, prev.locationId);
        if (opts.expectedUpdatedAt !== undefined && utcToLocal(prev.updatedAt, tz) !== opts.expectedUpdatedAt) throw new ApiError('conflict', 'Changed by someone else');
        if (opts.version !== undefined && prev.version !== opts.version) throw new ApiError('conflict', 'Changed by someone else');
        const data: Prisma.BookingUncheckedUpdateInput = { version: { increment: 1 }, updatedBy: actor.ctx?.member?.staffId ?? null };
        const next = { ...prev };
        // Мастер и филиал — только этого бизнеса: чужой id занимал бы время чужого мастера / чужой филиал
        if (patch.staffId !== undefined && patch.staffId !== prev.staffId && !(await tx.staff.findFirst({ where: { id: patch.staffId, businessId: prev.businessId, deletedAt: null }, select: { id: true } })))
          throw new ApiError('not_found', 'Staff not found');
        if (patch.locationId !== undefined && patch.locationId !== prev.locationId && !(await tx.location.findFirst({ where: { id: patch.locationId, businessId: prev.businessId, deletedAt: null }, select: { id: true } })))
          throw new ApiError('not_found', 'Location not found');
        if (patch.locationId !== undefined) next.locationId = patch.locationId;
        const nextTz = await this.tzOfLocation(tx, next.locationId);
        if (patch.start !== undefined) next.startAt = localToUtc(patch.start, nextTz);
        if (patch.staffId !== undefined) next.staffId = patch.staffId;
        if (patch.services !== undefined) {
          const lines = patch.services.map((l) => ({ ...l, staffId: l.staffId || next.staffId, qty: Math.max(1, l.qty ?? 1) }));
          next.services = lines as unknown as Prisma.JsonValue;
          next.total = BigInt(linesTotal(lines));
        }
        if (patch.durationMin !== undefined) next.durationMin = patch.durationMin;
        else if (patch.services !== undefined) next.durationMin = linesDuration(arr<ServiceLine>(next.services));
        if (patch.resourceIds !== undefined) next.resourceIds = patch.resourceIds;
        if (patch.workplace !== undefined) next.workplace = patch.workplace;
        if (patch.clientId !== undefined) {
          if (patch.clientId) {
            const c = await tx.client.findFirst({ where: { id: patch.clientId, businessId: prev.businessId }, select: { id: true, appUserId: true } });
            if (!c) throw new ApiError('not_found', 'Client not found');
            next.clientId = c.id;
          } else next.clientId = null;
        }
        if (patch.comment !== undefined) next.comment = patch.comment || null;
        if (patch.visitorName !== undefined) next.visitorName = patch.visitorName || null;
        if (patch.forWhom !== undefined) next.forWhom = patch.forWhom;
        if (patch.visitId !== undefined) next.visitId = patch.visitId || null;
        if (patch.seriesId !== undefined) next.seriesId = patch.seriesId || null;
        if (patch.groupEventId !== undefined) next.groupEventId = patch.groupEventId || null;
        if (patch.staffAssignment !== undefined) next.staffAssignment = patch.staffAssignment || null;
        if (patch.prepayment !== undefined) next.prepayment = (patch.prepayment ?? null) as Prisma.JsonValue;
        next.endAt = addMin(next.startAt, next.durationMin);

        const timeChanged =
          next.startAt.getTime() !== prev.startAt.getTime() ||
          next.staffId !== prev.staffId ||
          next.durationMin !== prev.durationMin ||
          next.locationId !== prev.locationId ||
          next.workplace !== prev.workplace ||
          JSON.stringify(next.resourceIds) !== JSON.stringify(prev.resourceIds) ||
          JSON.stringify(arr<ServiceLine>(next.services).map((l) => l.staffId)) !== JSON.stringify(arr<ServiceLine>(prev.services).map((l) => l.staffId));

        Object.assign(data, {
          locationId: next.locationId,
          startAt: next.startAt,
          endAt: next.endAt,
          staffId: next.staffId,
          services: next.services as Prisma.InputJsonValue,
          total: next.total,
          durationMin: next.durationMin,
          resourceIds: next.resourceIds as Prisma.InputJsonValue,
          workplace: next.workplace,
          clientId: next.clientId,
          comment: next.comment,
          visitorName: next.visitorName,
          forWhom: next.forWhom,
          visitId: next.visitId,
          seriesId: next.seriesId,
          groupEventId: next.groupEventId,
          staffAssignment: next.staffAssignment,
          prepayment: J(next.prepayment),
        });
        let keys: string[] = [];
        const statusChanged = patch.status !== undefined && patch.status !== prev.status;
        const reoccupied = statusChanged && !occupiesTime(prev) && !isCancelled(patch.status!);
        if (statusChanged) {
          // Статус правкой «без проверок» (setBookingStatus фронта) — последствия те же, что у смены статуса
          const res = await this.applyStatus(tx, prev, next as BookingRow, patch.status!, data);
          keys = res.keys;
        }
        if (!reoccupied && timeChanged && occupiesTime(prev) && !isCancelled(patch.status ?? prev.status) && !prev.deletedAt && !next.groupEventId) {
          const journal = await this.settings.get(prev.businessId, tx);
          const past = next.endAt.getTime() <= Date.now();
          keys.push(...(await this.occupyBooking(tx, { ...next, holdUntil: prev.holdUntil }, { replace: true, allowOverlap: past, ignoreNoShow: journal.settings.allowOverlapOverNoShow })));
          for (const k of await this.personKeysOf(tx, [prev.staffId])) keys.push(k);
        }
        const saved = await tx.booking.update({ where: { id }, data });
        await this.logEvents(tx, prev, saved, actor.ref);
        if (timeChanged && occupiesTime(prev) && !prev.deletedAt && prev.startAt.getTime() !== saved.startAt.getTime()) await this.freeSlot(tx, prev);
        await this.audit.record(tx, actor.ctx, {
          action: 'update',
          entityType: 'booking',
          entityId: id,
          businessId: prev.businessId,
          before: { start: utcToLocal(prev.startAt, tz), staffId: prev.staffId, durationMin: prev.durationMin, total: Number(prev.total), clientId: prev.clientId, status: prev.status },
          after: { start: utcToLocal(saved.startAt, nextTz), staffId: saved.staffId, durationMin: saved.durationMin, total: Number(saved.total), clientId: saved.clientId, status: saved.status },
        });
        this.touch(t, prev, tz, keys);
        this.touch(t, saved, nextTz, keys);
        return saved;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.publish(t, [row.id]);
    return this.view(this.prisma, row);
  }

  private async personKeysOf(db: Db, staffIds: string[]): Promise<string[]> {
    const rows = await db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, userId: true } });
    return rows.map((r) => personKeyOf(r));
  }

  // ─────────── статусы ───────────

  /**
   * Последствия смены статуса (в той же транзакции): неявки клиента (F-00-071), занятость (отмена снимает время,
   * возврат из отмены занимает снова — под замком), «не пришёл» поверх неявок (F-02-066), подтверждение заявки
   * (удержание снимается, В-03), «Клиент пришёл» (F-01-081), возврат предоплаты при отмене мастером (F-00-100).
   * `data` — патч строки, дописывается сюда.
   */
  private async applyStatus(tx: Tx, prev: BookingRow, next: BookingRow, status: BookingStatus, data: Prisma.BookingUncheckedUpdateInput): Promise<{ keys: string[] }> {
    data.status = status;
    let keys: string[] = [];
    const delta = noShowDelta(prev.status, status);
    if (delta && prev.clientId) {
      const c = await tx.client.findUnique({ where: { id: prev.clientId }, select: { noShowCount: true } });
      if (c) await tx.client.update({ where: { id: prev.clientId }, data: { noShowCount: Math.max(0, c.noShowCount + delta) } });
    }
    const wasBusy = occupiesTime(prev);
    const willBusy = !isCancelled(status);
    if (!prev.deletedAt && !prev.groupEventId) {
      if (wasBusy && !willBusy) {
        keys = await this.occupy.release(tx, 'booking', prev.id);
      } else if (!wasBusy && willBusy) {
        const journal = await this.settings.get(prev.businessId, tx);
        const past = next.endAt.getTime() <= Date.now();
        keys = await this.occupyBooking(tx, { ...next, status, holdUntil: null }, { replace: true, allowOverlap: past, ignoreNoShow: journal.settings.allowOverlapOverNoShow });
      } else if (willBusy) {
        if (prev.status === 'no_show' || status === 'no_show') await this.occupy.setNoShow(tx, 'booking', prev.id, status === 'no_show');
        if (prev.holdUntil && status !== 'awaiting_prepayment' && status !== 'awaiting_confirmation') await this.occupy.setHold(tx, 'booking', prev.id, null);
      }
    }
    if (status !== 'awaiting_confirmation') data.confirmDeadline = null;
    if (status !== 'awaiting_prepayment' && status !== 'awaiting_confirmation') data.holdUntil = null;
    const extras = extrasOf(prev.extras);
    if (status === 'arrived' || prev.status === 'arrived') data.extras = { ...extras, consumablesDeducted: status === 'arrived' } as Prisma.InputJsonValue;
    if (status === 'cancelled_by_master') {
      const p = prev.prepayment as { amount: number; paid: boolean } | null;
      if (p?.paid) data.prepayment = { ...p, refundDue: p.amount } as Prisma.InputJsonValue;
      data.cancelledBy = 'staff';
    }
    if (status === 'cancelled_by_client' && !data.cancelledBy) data.cancelledBy = 'staff';
    if (!isCancelled(status)) {
      data.cancelledBy = null;
      data.cancelReason = null;
      data.cancelledLate = false;
    }
    return { keys };
  }

  /** Сменить статус по правилам (F-00-068, F-01-075…084): допустимый переход, последствия, событие */
  async changeStatus(actor: BookingActor, businessIds: string[], id: string, status: BookingStatus, who: StatusActor = 'business', extra: { reason?: string } = {}): Promise<BookingView> {
    const t = touched();
    let prevStatus: string | null = null;
    const row = await this.prisma.$transaction(
      async (tx) => {
        const prev = await this.find(tx, businessIds, id);
        prevStatus = prev.status;
        if (prev.status === status) return prev;
        if (!canTransition(prev.status as BookingStatus, status, who)) throw new ApiError('invalid_transition', `Cannot change ${prev.status} → ${status}`);
        if (who === 'business' && actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', prev.staffId);
        const data: Prisma.BookingUncheckedUpdateInput = { version: { increment: 1 }, updatedBy: actor.ctx?.member?.staffId ?? null };
        const { keys } = await this.applyStatus(tx, prev, prev, status, data);
        if (who === 'system') data.cancelledBy = 'system';
        if (extra.reason) data.cancelReason = extra.reason;
        const saved = await tx.booking.update({ where: { id }, data });
        await this.logEvents(tx, prev, saved, actor.ref, extra);
        if (occupiesTime(prev) && !occupiesTime(saved)) await this.freeSlot(tx, prev);
        await this.audit.record(tx, actor.ctx, { action: 'status', entityType: 'booking', entityId: id, businessId: prev.businessId, before: { status: prev.status }, after: { status } });
        const tz = await this.tzOfLocation(tx, prev.locationId);
        this.touch(t, saved, tz, keys);
        return saved;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.publish(t, [row.id]);
    // F-04-121: два из трёх автоматических моментов пересчёта программы лояльности локации (третий —
    // сохранение самой программы, LoyaltyProgramService.save). Best-effort — сам метод честно возвращает
    // null, если правила выключены (по умолчанию), поэтому обычный визит не платит лишним запросом впустую.
    if ((status === 'arrived' || status === 'no_show') && row.clientId) {
      await this.loyaltyProgram.recalcOne(actor.ctx ?? null, row.businessId, row.clientId, status === 'arrived' ? 'statusArrived' : 'statusNoShow').catch(() => undefined);
    }
    // F-08-041/042, ⭐ F-00-136: автосписание расходников по техкарте на «Пришёл», откат при уходе с «Пришёл».
    // Best-effort, тем же приёмом, что пересчёт лояльности строкой выше — сама смена статуса не должна падать
    // из-за отсутствующей техкарты или занятого склада.
    if (status === 'arrived' && prevStatus !== 'arrived') {
      const services = (row.services as { serviceId: string; staffId: string; qty: number }[]) ?? [];
      await this.techCards.deductForBooking(row.businessId, row.id, row.staffId, services);
    } else if (prevStatus === 'arrived' && status !== 'arrived') {
      await this.techCards.revertForBooking(row.businessId, row.id);
    }
    return this.view(this.prisma, row);
  }

  /** «Пришёл · сумма» (F-00-127, В-39): статус и оплата одной операцией */
  async markArrived(actor: BookingActor, businessIds: string[], id: string, amount?: number): Promise<BookingView> {
    const view = await this.changeStatus(actor, businessIds, id, 'arrived');
    if (amount !== undefined && amount > 0) {
      await this.patchExtras(actor, businessIds, id, (e) => {
        const line = { id: newId('payment'), method: 'cash', amount, label: 'cash', at: nowLocal() };
        e.payments = [...(e.payments ?? []), line];
        e.paidAmount = e.payments.reduce((s, l) => s + l.amount, 0);
      });
    }
    return view;
  }

  // ─────────── удаление и восстановление (F-01-118…121) ───────────

  async remove(actor: BookingActor, businessIds: string[], id: string, opts: { byName?: string; byClient?: boolean } = {}): Promise<BookingView> {
    const t = touched();
    const row = await this.prisma.$transaction(
      async (tx) => {
        const prev = await this.find(tx, businessIds, id);
        if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', prev.staffId);
        if (prev.deletedAt) return prev;
        const extras = extrasOf(prev.extras);
        const keys = await this.occupy.release(tx, 'booking', id);
        const saved = await tx.booking.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            deletedBy: actor.ctx?.member?.staffId ?? null,
            deletedByName: opts.byName ?? actor.name,
            deletedByClient: Boolean(opts.byClient),
            deletionRestore: { paidAmount: Number(prev.paidAmount), consumablesDeducted: extras.consumablesDeducted ?? false, ...(extras.autoWriteoff ? { autoWriteoff: extras.autoWriteoff } : {}) },
            extras: { ...extras, paidAmount: 0, consumablesDeducted: false } as Prisma.InputJsonValue,
            paidAmount: 0n,
            version: { increment: 1 },
          },
        });
        await this.logEvents(tx, prev, saved, actor.ref);
        if (occupiesTime(prev)) await this.freeSlot(tx, prev);
        await this.audit.record(tx, actor.ctx, { action: 'delete', entityType: 'booking', entityId: id, businessId: prev.businessId, before: { deletedAt: null }, after: { deletedAt: saved.deletedAt?.toISOString() } });
        this.touch(t, saved, await this.tzOfLocation(tx, prev.locationId), keys);
        return saved;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.publish(t, [row.id]);
    return this.view(this.prisma, row);
  }

  /**
   * Вернуть удалённую запись (F-01-121, решение владельца: 7 дней, срок — настройка журнала): целиком, с деньгами,
   * если её время ещё свободно (замок на мастера). Позже срока — 410 restore_expired; время занято — 409
   * restore_slot_taken (экран предлагает «Создать заново»). Тот же вызов — «Отменить» 5 секунд (F-00-061).
   */
  async restore(actor: BookingActor, businessIds: string[], id: string): Promise<BookingView> {
    const t = touched();
    const row = await this.prisma.$transaction(
      async (tx) => {
        const prev = await this.find(tx, businessIds, id);
        if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', prev.staffId);
        if (!prev.deletedAt) throw new ApiError('not_found', 'Booking is not deleted');
        const days = (await this.settings.get(prev.businessId, tx)).settings.deletionRestoreWindowDays;
        if (Date.now() - prev.deletedAt.getTime() > days * 86_400_000) throw new ApiError('restore_expired', 'Restore window is over');
        const restore = (prev.deletionRestore ?? {}) as { paidAmount?: number; consumablesDeducted?: boolean; autoWriteoff?: BookingExtras['autoWriteoff'] };
        let keys: string[] = [];
        if (occupiesTime({ status: prev.status }) && !prev.groupEventId) {
          const journal = await this.settings.get(prev.businessId, tx);
          const past = prev.endAt.getTime() <= Date.now();
          try {
            keys = await this.occupyBooking(tx, prev, { replace: true, allowOverlap: past, ignoreNoShow: journal.settings.allowOverlapOverNoShow });
          } catch (e) {
            if (e instanceof ApiError && (e.code === 'slot_taken' || e.code === 'resource_unavailable')) throw new ApiError('restore_slot_taken', 'Time is taken');
            throw e;
          }
        }
        const extras = extrasOf(prev.extras);
        const saved = await tx.booking.update({
          where: { id },
          data: {
            deletedAt: null,
            deletedBy: null,
            deletedByName: null,
            deletedByClient: false,
            deletionRestore: Prisma.DbNull,
            extras: {
              ...extras,
              paidAmount: restore.paidAmount ?? extras.paidAmount,
              consumablesDeducted: restore.consumablesDeducted ?? false,
              ...(restore.autoWriteoff ? { autoWriteoff: restore.autoWriteoff } : {}),
            } as Prisma.InputJsonValue,
            paidAmount: BigInt(restore.paidAmount ?? 0),
            version: { increment: 1 },
          },
        });
        await tx.freedSlot.updateMany({ where: { sourceBookingId: id, stage: { in: ['waitlist', 'subscribers', 'hot'] } }, data: { stage: 'taken' } });
        await this.audit.record(tx, actor.ctx, { action: 'restore', entityType: 'booking', entityId: id, businessId: prev.businessId, before: { deletedAt: prev.deletedAt.toISOString() }, after: { deletedAt: null } });
        this.touch(t, saved, await this.tzOfLocation(tx, prev.locationId), keys);
        return saved;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.publish(t, [row.id]);
    return this.view(this.prisma, row);
  }

  // ─────────── доп. данные визита (срез journal.extras) ───────────

  async patchExtras(actor: BookingActor, businessIds: string[], id: string, recipe: (e: BookingExtras) => void): Promise<ReturnType<typeof extrasView>> {
    const row = await this.prisma.$transaction(async (tx) => {
      const prev = await this.find(tx, businessIds, id);
      if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', prev.staffId);
      const e = extrasOf(prev.extras);
      e.paidAmount = Number(prev.paidAmount);
      recipe(e);
      return tx.booking.update({
        where: { id },
        data: { extras: e as unknown as Prisma.InputJsonValue, paidAmount: BigInt(Math.max(0, Math.round(e.paidAmount ?? 0))), version: { increment: 1 } },
      });
    });
    const tz = await this.tzOfLocation(this.prisma, row.locationId);
    const t = touched();
    this.touch(t, row, tz);
    for (const b of t.businessIds) for (const d of t.dates) await this.live.publish(`biz:${b}:day:${d}`, { type: 'booking.changed', data: { bookingIds: [id], date: d } });
    return extrasView(row, tz);
  }

  // ─────────── подтверждение заявки, предоплата (В-03, В-05, F-00-097, F-00-100) ───────────

  async confirm(actor: BookingActor, businessIds: string[], id: string): Promise<BookingView> {
    const b = await this.find(this.prisma, businessIds, id);
    if (b.status !== 'awaiting_confirmation') throw new ApiError('invalid_transition', 'Not awaiting confirmation');
    return this.changeStatus(actor, businessIds, id, 'scheduled');
  }

  async decline(actor: BookingActor, businessIds: string[], id: string): Promise<BookingView> {
    const b = await this.find(this.prisma, businessIds, id);
    if (!isActiveStatus(b.status)) throw new ApiError('invalid_transition', 'Not active');
    return this.changeStatus(actor, businessIds, id, 'cancelled_by_master');
  }

  /** Мастер получил ручную предоплату (F-00-097): запись становится «Записан», удержание снимается */
  async prepaymentReceived(actor: BookingActor, businessIds: string[], id: string): Promise<BookingView> {
    const t = touched();
    const row = await this.prisma.$transaction(async (tx) => {
      const prev = await this.find(tx, businessIds, id);
      if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', prev.staffId);
      const p = (prev.prepayment ?? null) as { amount: number; paid: boolean; confirmAfterPayment?: boolean } | null;
      if (!p) throw new ApiError('invalid_transition', 'No prepayment');
      const data: Prisma.BookingUncheckedUpdateInput = { prepayment: { ...p, paid: true, holdUntil: undefined } as Prisma.InputJsonValue, version: { increment: 1 } };
      let keys: string[] = [];
      // О6 + full-test-0930 online №6: запись, которая без предоплаты ждала бы мастера, после «Деньги пришли» идёт ему
      // на подтверждение, и срок ответа считается С ЭТОГО момента: min(сейчас + 2 ч, начало − 1 ч) — иначе срок от
      // создания уже прошёл, и воркер тут же снимал бы заявку как «мастер не ответил»
      let hold: Date | null = null;
      if (prev.status === 'awaiting_prepayment') {
        const next = p.confirmAfterPayment ? 'awaiting_confirmation' : 'scheduled';
        const res = await this.applyStatus(tx, prev, prev, next, data);
        keys = res.keys;
        if (next === 'awaiting_confirmation') {
          hold = confirmDeadlineOf(new Date(), prev.startAt);
          data.confirmDeadline = hold;
          data.holdUntil = hold;
        }
      }
      await this.occupy.setHold(tx, 'booking', id, hold);
      const e = extrasOf(prev.extras);
      // Повторное нажатие «Предоплата получена» не добавляет вторую строку оплаты (деньги не удваиваются)
      // Оплата участника группового события (строка 'participant', деньги уже в кассе) — тоже уже оплата
      const byParticipant = (e.payments ?? []).some((l) => l.label === 'participant');
      const logged = byParticipant || (e.payments ?? []).some((l) => l.label === 'prepayment');
      const payments = logged ? (e.payments ?? []) : [...(e.payments ?? []), { id: newId('payment'), method: 'cash', amount: p.amount, label: 'prepayment', at: nowLocal() }];
      data.extras = { ...e, payments, paidAmount: payments.reduce((s, l) => s + l.amount, 0) } as Prisma.InputJsonValue;
      data.paidAmount = BigInt(payments.reduce((s, l) => s + l.amount, 0));
      const saved = await tx.booking.update({ where: { id }, data });
      // ⭐ Решение владельца 01.10: предоплата на реквизиты мастера — своя операция в финансах (идемпотентно)
      if (!byParticipant) await recordPrepaymentReceivedTx(tx, saved, actor.ctx?.member?.staffId ?? actor.ref);
      await this.logEvents(tx, prev, saved, actor.ref);
      this.touch(t, saved, await this.tzOfLocation(tx, saved.locationId), keys);
      return saved;
    });
    await this.publish(t, [row.id]);
    return this.view(this.prisma, row);
  }

  /**
   * Предоплата возвращена клиенту (F-00-100): обратная операция в финансах (идемпотентно), и возвращённая предоплата
   * больше не оплата визита — строка 'prepayment' уходит из платежей и paidAmount (prepaidOf мока: refundedAt → 0).
   */
  async refundDone(actor: BookingActor, businessIds: string[], id: string): Promise<BookingView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const prev = await this.find(tx, businessIds, id);
      if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', prev.staffId);
      const p = (prev.prepayment ?? null) as Record<string, unknown> | null;
      if (!p) throw new ApiError('invalid_transition', 'No prepayment');
      const data: Prisma.BookingUncheckedUpdateInput = { prepayment: { ...p, refundDue: 0, refundedAt: p.refundedAt ?? nowLocal() } as Prisma.InputJsonValue, version: { increment: 1 } };
      const e = extrasOf(prev.extras);
      const prepaid = (e.payments ?? []).filter((l) => l.label === 'prepayment');
      if (prepaid.length) {
        const payments = (e.payments ?? []).filter((l) => l.label !== 'prepayment');
        const back = prepaid.reduce((s, l) => s + l.amount, 0);
        const nextPaid = Math.max(0, Number(prev.paidAmount) - back);
        data.extras = { ...e, payments, paidAmount: nextPaid } as Prisma.InputJsonValue;
        data.paidAmount = BigInt(nextPaid);
      }
      const saved = await tx.booking.update({ where: { id }, data });
      await recordPrepaymentRefundTx(tx, saved, actor.ctx?.member?.staffId ?? actor.ref);
      return saved;
    });
    return this.view(this.prisma, row);
  }

  // ─────────── «Закончил раньше», «Задерживаюсь» (F-00-058, F-00-059) ───────────

  async finishEarly(actor: BookingActor, businessIds: string[], id: string, actualDurationMin?: number): Promise<BookingView> {
    const b = await this.find(this.prisma, businessIds, id);
    if (!occupiesTime(b)) throw new ApiError('not_found', 'Booking not found');
    const tz = await this.tzOfLocation(this.prisma, b.locationId);
    // Только идущая сейчас запись (recheck-c2: у будущей длительность становилась 5 мин и её время открывалось)
    const now = Date.now();
    if (!(b.startAt.getTime() <= now && now < b.startAt.getTime() + b.durationMin * 60_000)) throw new ApiError('not_ongoing', 'Booking is not ongoing');
    const elapsed = Math.max(5, Math.round((now - b.startAt.getTime()) / 300_000) * 5);
    const duration = Math.min(b.durationMin, Math.max(5, actualDurationMin ?? elapsed, elapsed));
    if (duration >= b.durationMin) return bookingView(b, tz);
    const view = await this.update(actor, businessIds, id, { durationMin: duration });
    // Остаток до конца прежней записи становится окном (В-18: сначала лист ожидания)
    await this.prisma.$transaction(async (tx) => this.freeSlot(tx, { ...b, startAt: addMin(b.startAt, duration), durationMin: b.durationMin - duration }));
    return view;
  }

  async reportDelay(actor: BookingActor, businessIds: string[], id: string, delayMin: number) {
    const b = await this.find(this.prisma, businessIds, id);
    if (b.deletedAt) throw new ApiError('not_found', 'Booking not found');
    if (!occupiesTime(b)) throw new ApiError('invalid_transition', 'Booking does not hold time');
    if (actor.ctx?.member) assertJournal(actor.ctx, 'journal.edit', b.staffId);
    const tz = await this.tzOfLocation(this.prisma, b.locationId);
    const ev = await this.prisma.bookingEvent.create({
      data: {
        id: newId('bookingEvent'),
        bookingId: b.id,
        businessId: b.businessId,
        staffId: b.staffId,
        clientId: b.clientId,
        appUserId: b.appUserId,
        kind: 'delayed',
        delayMin: Math.max(1, Math.round(delayMin)),
        byRef: actor.ref,
        startLocal: utcToLocal(b.startAt, tz),
      },
    });
    if (b.appUserId) {
      await this.prisma.inboxItem.create({ data: { id: newId('inboxItem'), appUserId: b.appUserId, kind: 'master_delayed', businessId: b.businessId, staffId: b.staffId, bookingId: b.id, params: { delayMin: ev.delayMin, start: ev.startLocal } as Prisma.InputJsonValue } });
      await this.live.publish(`user:${b.appUserId}`, { type: 'inbox.new', data: { bookingId: b.id } });
    }
    return eventView(ev, tz);
  }

  // ─────────── клиент: отмена, перенос, подтверждение, «Я оплатил» (В-04, F-00-097…099) ───────────

  private async clientBooking(appUserId: string, id: string): Promise<BookingRow> {
    const b = await this.prisma.booking.findFirst({ where: { id, appUserId } });
    if (!b) throw new ApiError('not_found', 'Booking not found');
    return b;
  }

  private async rulesOf(db: Db, b: BookingRow) {
    const [biz, staff] = await Promise.all([
      db.business.findUnique({ where: { id: b.businessId }, select: { bookingRules: true } }),
      db.staff.findUnique({ where: { id: b.staffId }, select: { bookingRules: true, confirmMode: true, prepayment: true, calendarVisibility: true } }),
    ]);
    return { rules: effectiveBookingRules(biz?.bookingRules as BookingRules | null, staff?.bookingRules as BookingRules | null), staff };
  }

  /**
   * Что будет, если клиент отменит сейчас — те же действующие правила и тот же `clientCancelOutcome`, что у
   * `cancelByClient` ниже (Telegram-бот спрашивает «предоплата вернётся / не вернётся?» до самой отмены, 30.09).
   */
  async clientCancelPreview(b: BookingRow): Promise<{ outcome: ReturnType<typeof clientCancelOutcome>; keepPrepaymentOnLateCancel: boolean; prepaidAmount: number; rules: EffectiveBookingRules }> {
    const tz = await this.tzOfLocation(this.prisma, b.locationId);
    const { rules } = await this.rulesOf(this.prisma, b);
    const p = b.prepayment as { paid?: boolean; amount?: number } | null;
    const outcome = clientCancelOutcome({ start: utcToLocal(b.startAt, tz), status: b.status, deletedAt: b.deletedAt, prepayment: p }, rules, nowLocal(tz));
    return { outcome, keepPrepaymentOnLateCancel: rules.keepPrepaymentOnLateCancel, prepaidAmount: p?.paid ? Number(p.amount ?? 0) : 0, rules };
  }

  /**
   * Отмена клиентом (В-04, F-00-098): раньше срока — бесплатно; позже — «Отменил клиент» + пометка «поздно» +1 к неявкам
   * у ЭТОГО бизнеса (В-07); предоплата при поздней отмене остаётся мастеру (галочка мастера, по умолчанию да).
   */
  async cancelByClient(actor: BookingActor, id: string, by: { appUserId?: string; booking?: BookingRow }): Promise<{ booking: BookingView; late: boolean }> {
    const b = by.booking ?? (await this.clientBooking(by.appUserId ?? '', id));
    const tz = await this.tzOfLocation(this.prisma, b.locationId);
    const { rules } = await this.rulesOf(this.prisma, b);
    const out = clientCancelOutcome({ start: utcToLocal(b.startAt, tz), status: b.status, deletedAt: b.deletedAt, prepayment: b.prepayment as { paid?: boolean } | null }, rules, nowLocal(tz));
    if (!out.allowed) throw new ApiError(out.reason, `Cancel denied: ${out.reason}`);
    const t = touched();
    const row = await this.prisma.$transaction(async (tx) => {
      const prev = await tx.booking.findUniqueOrThrow({ where: { id } });
      const data: Prisma.BookingUncheckedUpdateInput = { version: { increment: 1 } };
      const { keys } = await this.applyStatus(tx, prev, prev, 'cancelled_by_client', data);
      data.cancelledBy = 'client';
      if (out.late) {
        data.cancelledLate = true;
        if (prev.clientId) await tx.client.update({ where: { id: prev.clientId }, data: { noShowCount: { increment: 1 } } });
        const p = prev.prepayment as { amount: number; paid: boolean } | null;
        if (p?.paid && !rules.keepPrepaymentOnLateCancel) data.prepayment = { ...p, refundDue: p.amount } as Prisma.InputJsonValue;
      } else {
        const p = prev.prepayment as { amount: number; paid: boolean } | null;
        if (p?.paid) data.prepayment = { ...p, refundDue: p.amount } as Prisma.InputJsonValue;
      }
      const saved = await tx.booking.update({ where: { id }, data });
      await this.logEvents(tx, prev, saved, 'client');
      await this.freeSlot(tx, prev);
      await this.audit.record(tx, actor.ctx, { action: 'status', entityType: 'booking', entityId: id, businessId: prev.businessId, before: { status: prev.status }, after: { status: 'cancelled_by_client', late: out.late } });
      this.touch(t, saved, tz, keys);
      return saved;
    });
    await this.publish(t, [row.id]);
    return { booking: bookingView(row, tz), late: out.late };
  }

  /** Перенос клиентом (F-00-099): до срока переноса, на окно того же мастера; статус — заново по правилам мастера */
  async rescheduleByClient(actor: BookingActor, id: string, newStart: string, by: { appUserId?: string; booking?: BookingRow }): Promise<BookingView> {
    const b = by.booking ?? (await this.clientBooking(by.appUserId ?? '', id));
    const tz = await this.tzOfLocation(this.prisma, b.locationId);
    const { rules, staff } = await this.rulesOf(this.prisma, b);
    const check = canReschedule({ start: utcToLocal(b.startAt, tz), status: b.status, deletedAt: b.deletedAt, prepayment: b.prepayment as { paid?: boolean } | null }, rules, nowLocal(tz));
    if (!check.allowed) throw new ApiError(check.reason, `Reschedule denied: ${check.reason}`);
    const lines = arr<ServiceLine>(b.services);
    const svc = lines[0] ? await this.prisma.service.findUnique({ where: { id: lines[0].serviceId } }) : null;
    const offered = await this.availability.freeSlots(b.businessId, {
      staffId: b.staffId,
      date: newStart.slice(0, 10),
      durationMin: b.durationMin,
      bufferAfterMin: svc?.bufferAfterMin ?? 0,
      locationId: b.locationId,
      serviceId: svc?.id,
    });
    if (!offered.some((s) => s.start === newStart)) throw new ApiError('slot_taken', 'Slot is not offered');
    const paid = Boolean((b.prepayment as { paid?: boolean } | null)?.paid);
    const status = newBookingStatus({
      source: isOnlineSource(b.source) ? b.source : 'app',
      staff: { confirmMode: staff?.confirmMode ?? 'manual', prepayment: (staff?.prepayment ?? null) as PrepaymentRule | null, calendarVisibility: staff?.calendarVisibility ?? 'all' },
      workplace: b.workplace,
      prepaymentPaid: paid,
      // ⭐ Предоплата «за то, что не приходил» переносом не снимается: порог считали при записи
      clientNoShows: (b.prepayment as { reason?: string } | null)?.reason === 'no_shows' ? Number.MAX_SAFE_INTEGER : 0,
    });
    await this.update(actor, [b.businessId], id, { start: newStart });
    if (status !== b.status) {
      const row = await this.prisma.$transaction(async (tx) => {
        const prev = await tx.booking.findUniqueOrThrow({ where: { id } });
        const data: Prisma.BookingUncheckedUpdateInput = { version: { increment: 1 } };
        await this.applyStatus(tx, prev, prev, status, data);
        if (status === 'awaiting_confirmation') {
          const deadline = confirmDeadlineOf(new Date(), prev.startAt);
          data.confirmDeadline = deadline;
          data.holdUntil = deadline;
          await this.occupy.setHold(tx, 'booking', id, deadline);
        }
        const saved = await tx.booking.update({ where: { id }, data });
        await this.logEvents(tx, prev, saved, 'client');
        return saved;
      });
      return bookingView(row, tz);
    }
    return this.view(this.prisma, await this.prisma.booking.findUniqueOrThrow({ where: { id } }));
  }

  /** «Подтверждаю, что приду» (F-14-057) */
  async confirmByClient(actor: BookingActor, id: string, appUserId: string): Promise<BookingView> {
    const b = await this.clientBooking(appUserId, id);
    return this.changeStatus(actor, [b.businessId], id, 'client_confirmed', 'client');
  }

  /** «Я оплатил» (F-00-097): таймер стоп — окно держится до решения мастера */
  async markPaidByClient(appUserId: string, id: string): Promise<BookingView> {
    const b = await this.clientBooking(appUserId, id);
    const p = (b.prepayment ?? {}) as Record<string, unknown>;
    if (b.status === 'awaiting_prepayment' && p.clientMarkedPaidAt) return this.view(this.prisma, b);
    const updated = await this.stopPrepaymentHold(b);
    // Событие «оплата на проверке», как «Я оплатил» по ссылке (OnlineService.markPrepaymentPaid) — история и лента журнала
    await this.prisma.bookingEvent.create({ data: { id: newId('bookingEvent'), bookingId: id, businessId: b.businessId, staffId: b.staffId, clientId: b.clientId, appUserId: b.appUserId, kind: 'status', toStatus: 'prepayment_reported', byRef: 'client', startLocal: utcToLocal(b.startAt) } });
    return this.view(this.prisma, updated);
  }

  /**
   * «Я оплатил» — общий шаг для приложения и ссылки без входа: срок снимается и с записи (`holdUntil` — по нему
   * воркер `releaseExpired` снимает заявку), и с занятости (иначе окно освободится для других), до решения мастера.
   */
  async stopPrepaymentHold(b: BookingRow): Promise<BookingRow> {
    if (b.status !== 'awaiting_prepayment') throw new ApiError('invalid_transition', 'Not awaiting prepayment');
    return this.prisma.$transaction(async (tx) => {
      const p = (b.prepayment ?? {}) as Record<string, unknown>;
      await this.occupy.setHold(tx, 'booking', b.id, null);
      return tx.booking.update({ where: { id: b.id }, data: { holdUntil: null, prepayment: { ...p, clientMarkedPaidAt: nowLocal(), holdUntil: undefined } as Prisma.InputJsonValue, version: { increment: 1 } } });
    });
  }

  // ─────────── фоновые задачи (воркер, каждую минуту) ───────────

  /**
   * Снять просроченные заявки (B13, В-03, В-05): «ждёт предоплату» без «Я оплатил» после срока — «Отменил клиент»
   * с причиной prepayment_expired; «ждёт подтверждения», мастер молчит до срока — снята (confirmation_expired).
   * Окно освобождается и уходит листу ожидания (В-18). Пуш клиенту с 3 ближайшими окнами — этап 10.
   */
  async releaseExpired(filter: { businessId?: string; appUserId?: string } = {}): Promise<{ prepayment: string[]; confirmation: string[] }> {
    const now = new Date();
    const scope = { ...(filter.businessId ? { businessId: filter.businessId } : {}), ...(filter.appUserId ? { appUserId: filter.appUserId } : {}) };
    const prepay = await this.prisma.booking.findMany({ where: { ...scope, deletedAt: null, status: 'awaiting_prepayment', holdUntil: { lte: now } }, select: { id: true, businessId: true } });
    const confirm = await this.prisma.booking.findMany({ where: { ...scope, deletedAt: null, status: 'awaiting_confirmation', confirmDeadline: { lte: now } }, select: { id: true, businessId: true } });
    const done = { prepayment: [] as string[], confirmation: [] as string[] };
    for (const b of prepay) {
      try {
        await this.changeStatus(SYSTEM_ACTOR, [b.businessId], b.id, 'cancelled_by_client', 'system', { reason: 'prepayment_expired' });
        done.prepayment.push(b.id);
      } catch {
        /* уже поменяли — пропускаем */
      }
    }
    for (const b of confirm) {
      try {
        await this.changeStatus(SYSTEM_ACTOR, [b.businessId], b.id, 'cancelled_by_master', 'system', { reason: 'confirmation_expired' });
        done.confirmation.push(b.id);
        // В-03: клиенту сразу 3 ближайших окна того же мастера — видит их на странице записи и в приложении
        await this.offerAlternatives(b.businessId, b.id).catch(() => undefined);
      } catch {
        /* уже поменяли — пропускаем */
      }
    }
    return done;
  }

  /** 3 ближайших свободных начала того же мастера (не больше 2 в день) → onlineMeta.offeredStarts, как «Другое время» */
  private async offerAlternatives(businessId: string, bookingId: string): Promise<void> {
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const services = arr<ServiceLine>(b.services);
    const startLocal = utcToLocal(b.startAt);
    const nowLocalIso = utcToLocal(new Date());
    let cursor = nowLocalIso.slice(0, 10) > startLocal.slice(0, 10) ? nowLocalIso.slice(0, 10) : startLocal.slice(0, 10);
    const out: string[] = [];
    for (let i = 0; i < 14 && out.length < 3; i++) {
      const slots = await this.availability.freeSlots(businessId, { staffId: b.staffId, date: cursor, durationMin: b.durationMin, locationId: b.locationId, serviceId: services[0]?.serviceId });
      let perDay = 0;
      for (const sl of slots) {
        if (perDay >= 2 || out.length >= 3) break;
        if (sl.start === startLocal || sl.start < nowLocalIso) continue;
        out.push(sl.start);
        perDay++;
      }
      cursor = dayjs(cursor).add(1, 'day').format('YYYY-MM-DD');
    }
    if (!out.length) return;
    const meta = { ...((b.onlineMeta as Record<string, unknown> | null) ?? {}), offeredStarts: out };
    await this.prisma.booking.update({ where: { id: bookingId }, data: { onlineMeta: meta as Prisma.InputJsonValue } });
  }

  /**
   * Раздача освободившегося окна по стадиям (В-18): лист ожидания — сразу (при освобождении); через 30 минут —
   * подписчики мастера; за 3 часа до начала — «горящее» со скидкой мастера (по умолчанию 0 %). Окно заняли —
   * раздача останавливается. Сами пуши — этап 10: здесь только стадии и время перехода.
   */
  async advanceFreedSlots(): Promise<{ subscribers: number; hot: number; taken: number; expired: number }> {
    const now = new Date();
    const res = { subscribers: 0, hot: 0, taken: 0, expired: 0 };
    const open = await this.prisma.freedSlot.findMany({ where: { stage: { in: ['waitlist', 'subscribers', 'hot'] } }, take: 500 });
    for (const f of open) {
      if (f.startAt <= now) {
        await this.prisma.freedSlot.update({ where: { id: f.id }, data: { stage: 'expired' } });
        res.expired++;
        continue;
      }
      const staff = await this.prisma.staff.findUnique({ where: { id: f.staffId }, select: { id: true, userId: true } });
      const busy = staff
        ? await this.prisma.busyBlock.count({
            where: { personKey: personKeyOf(staff), active: true, source: { not: 'mark_busy' }, startAt: { lt: f.endAt }, endAt: { gt: f.startAt }, OR: [{ holdUntil: null }, { holdUntil: { gt: now } }] },
          })
        : 1;
      if (busy > 0) {
        await this.prisma.freedSlot.update({ where: { id: f.id }, data: { stage: 'taken' } });
        res.taken++;
        continue;
      }
      if (f.stage !== 'hot' && f.startAt.getTime() - now.getTime() <= 3 * 3_600_000) {
        await this.prisma.freedSlot.update({ where: { id: f.id }, data: { stage: 'hot', hotAt: now } });
        res.hot++;
      } else if (f.stage === 'waitlist' && now.getTime() - f.createdAt.getTime() >= 30 * 60_000) {
        await this.prisma.freedSlot.update({ where: { id: f.id }, data: { stage: 'subscribers', subscribersAt: now } });
        await this.notifyFavoriteSubscribers(f);
        res.subscribers++;
      }
    }
    return res;
  }

  /** Вторая волна раздачи, через 30 мин (В-18): подписчики ❤ мастера, не приглушившие новости — тот же переключатель */
  private async notifyFavoriteSubscribers(f: { id: string; businessId: string; staffId: string; startAt: Date; locationId: string | null; sourceBookingId: string; durationMin: number }): Promise<void> {
    const favorites = await this.prisma.favorite.findMany({ where: { targetType: 'staff', targetId: f.staffId, newsMuted: false }, select: { appUserId: true } });
    if (!favorites.length) return;
    const [staff, users] = await Promise.all([
      this.prisma.staff.findUnique({ where: { id: f.staffId }, select: { name: true } }),
      this.prisma.user.findMany({ where: { id: { in: favorites.map((fv) => fv.appUserId) } }, select: { id: true, locale: true } }),
    ]);
    const def = notifyKindOf('waitlist_available')!;
    const staffName = staff?.name ?? 'BookTime';
    // Подписчикам — освободившаяся услуга (она в окно помещается по определению) и время окна
    const source = await this.prisma.booking.findUnique({ where: { id: f.sourceBookingId }, select: { services: true } });
    const serviceId = arr<ServiceLine>(source?.services)[0]?.serviceId;
    const slot = await this.slotOfferParts(this.prisma, { startAt: f.startAt, serviceId }, await this.tzOfLocation(this.prisma, f.locationId));
    for (const u of users) {
      const locale = isLocale(u.locale) ? u.locale : 'ru';
      await enqueueClientNotification(this.prisma, {
        businessId: f.businessId,
        kind: def.kind,
        appUserId: u.id,
        title: staffName,
        body: t(locale, 'waitlist.slotAvailableAt', { staff: staffName, when: slot.when, service: slot.serviceName(locale) }),
        url: slot.url(f.staffId),
        dedupeKey: `client:waitlist-sub:${f.id}:${u.id}`,
        inbox: { kind: 'waitlist_slot', businessId: f.businessId, staffId: f.staffId, params: slot.params },
      });
    }
  }

  // ─────────── события записей ───────────

  async listEvents(q: {
    businessIds?: string[];
    staffId?: string;
    bookingId?: string;
    clientId?: string;
    appUserId?: string;
    kinds?: string[];
    since?: string;
    freedOnly?: boolean;
    excludeBy?: string;
    limit?: number;
  }) {
    const tz = q.businessIds?.[0] ? await this.tzOfBusiness(this.prisma, q.businessIds[0]) : DEFAULT_TZ;
    const where: Prisma.BookingEventWhereInput = {};
    if (q.businessIds) where.businessId = { in: q.businessIds };
    if (q.staffId) where.OR = [{ staffId: q.staffId }, { prevStaffId: q.staffId }];
    if (q.bookingId) where.bookingId = q.bookingId;
    if (q.clientId) where.clientId = q.clientId;
    if (q.appUserId) where.appUserId = q.appUserId;
    if (q.kinds?.length) where.kind = { in: q.kinds };
    if (q.since) where.at = { gt: dayjs.tz(q.since, 'YYYY-MM-DDTHH:mm', tz).add(59, 'second').toDate() };
    if (q.freedOnly) where.freed = { not: Prisma.DbNull };
    if (q.excludeBy) where.byRef = { not: q.excludeBy };
    const rows = await this.prisma.bookingEvent.findMany({ where, orderBy: { at: 'asc' }, take: q.limit ?? 1000 });
    return rows.map((e) => eventView(e, tz));
  }
}

/** Карточка клиента в форме ядра фронта (Client) — для зеркала после записи с новым клиентом */
export function coreClient(c: { id: string; businessId: string; phone: string; name: string; gender: string; birthday: string | null; tags: unknown; appUserId: string | null; noShowCount: number; createdAt: Date }) {
  return {
    id: c.id,
    businessId: c.businessId,
    phone: c.phone,
    name: c.name,
    gender: c.gender,
    ...(c.birthday ? { birthday: c.birthday } : {}),
    tags: arr(c.tags),
    ...(c.appUserId ? { appUserId: c.appUserId } : {}),
    noShowCount: c.noShowCount,
    createdAt: utcToLocal(c.createdAt),
  };
}
