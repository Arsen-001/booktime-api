import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import { maskPhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { RateLimitService } from '../../common/rate-limit/rate-limit.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { BookingsService, clientActor } from '../journal/bookings.service.js';
import { findIntakeService } from './order-intake.service.js';
import { publicOrderByCode } from './order-public.js';
import {
  canBookPickup,
  INTAKE_CLOSED_STATUSES,
  intakeSlotOf,
  isPickupBooking,
  ordersEnabledOf,
  PICKUP_DAYS,
  PICKUP_KIND,
  PICKUP_SERVICE_NAME,
  pickupBookingComment,
  type OrderItem,
  type OrderRow,
  type OrderStatus,
  type PublicPickupView,
} from './order-rules.js';

type SvcDb = Pick<Prisma.TransactionClient, 'service'>;
type InfoDb = Pick<Prisma.TransactionClient, 'service' | 'business' | 'booking'>;
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const LOCAL_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/**
 * Сколько раз за час можно выбрать/поменять/снять время выдачи по ОДНОЙ ссылке заказа (сверх лимита по IP в контроллере):
 * каждая смена — новая запись в журнале и пуш мастерской «новая запись» / «клиент отменил»; со сменой адресов лимит по IP
 * этого не сдерживает. Человеку хватает с запасом.
 */
export const PICKUP_CHANGES_PER_CODE = { limit: 12, windowSec: 3600 } as const;

/** «Забирают сегодня» в «Заказах»: запись на выдачу и её заказ */
export interface PickupBookingView {
  bookingId: string;
  start: string;
  durationMin: number;
  status: string;
  staffId: string;
  clientId: string | null;
  clientName: string;
  clientPhone: string;
  orderId: string | null;
  orderNumber: number | null;
  orderStatus: OrderStatus | null;
  /** Что забирают: «iPhone 14 — замена экрана · Защитное стекло» */
  items: string | null;
}

/** Окна для выбора на /o/<code>: по дням, только дни, где есть свободное время */
export interface PickupSlotsView {
  slotMin: number;
  days: { date: string; slots: string[] }[];
}

/** Услуга «Выдача заказа» бизнеса (одна; старейшая, если вдруг две) */
export function findPickupService(db: SvcDb, businessId: string) {
  return db.service.findFirst({ where: { businessId, kind: PICKUP_KIND }, orderBy: { createdAt: 'asc' } });
}

/**
 * «Выдача заказа» вслед за «Приёмом заказа»: то же окно, те же люди, включена вместе с ним. onlineBookable всегда false —
 * в общем потоке онлайн-записи, каталоге, поиске и на странице мастерской её нет; записывает только ссылка заказа.
 */
export async function syncPickupService(
  db: SvcDb,
  p: { businessId: string; sphereId: string; durationMin: number; staffIds: string[]; enabled: boolean; by: string | null },
): Promise<string> {
  const existing = await findPickupService(db, p.businessId);
  const fields = { durationMin: p.durationMin, staffIds: p.staffIds, active: p.enabled, onlineBookable: false };
  if (existing) {
    await db.service.update({ where: { id: existing.id }, data: { ...fields, updatedBy: p.by, version: { increment: 1 } } });
    return existing.id;
  }
  const id = newId('service');
  await db.service.create({
    data: {
      id,
      businessId: p.businessId,
      categoryId: null,
      sphereId: p.sphereId,
      name: { ...PICKUP_SERVICE_NAME },
      kind: PICKUP_KIND,
      priceMin: 0n,
      bufferAfterMin: 0,
      photos: [],
      materials: [],
      workplaces: ['salon'],
      order: 0,
      createdBy: p.by,
      updatedBy: p.by,
      ...fields,
    },
  });
  return id;
}

interface PickupSetup {
  enabled: boolean;
  slotMin: number;
  staffIds: string[];
  /** null — мастерская включила приём до 06.10.2026, «Выдачу заказа» заведём при первой записи */
  serviceId: string | null;
  sphereId: string;
}

/**
 * Выдача по времени у бизнеса: включена, когда включены «Заказы» и «Запись на сдачу» (и сама «Выдача заказа», если уже
 * заведена). null — запись на сдачу ни разу не включали.
 */
export async function pickupSetupOf(db: InfoDb, businessId: string): Promise<PickupSetup | null> {
  const [business, intake, pickup] = await Promise.all([
    db.business.findUnique({ where: { id: businessId }, select: { ordersEnabled: true, sphereIds: true } }),
    findIntakeService(db, businessId),
    findPickupService(db, businessId),
  ]);
  if (!business || !intake) return null;
  const staffIds = arr((pickup ?? intake).staffIds);
  const enabled = Boolean(
    ordersEnabledOf(business.ordersEnabled, business.sphereIds) && intake.active && intake.onlineBookable && (!pickup || pickup.active) && staffIds.length,
  );
  return { enabled, slotMin: intakeSlotOf((pickup ?? intake).durationMin), staffIds, serviceId: pickup?.id ?? null, sphereId: arr(business.sphereIds)[0] ?? 'general' };
}

/** Действующая запись на выдачу заказа: не удалена и не отменена (иначе — записи нет) */
export async function activePickupBooking(db: Pick<Prisma.TransactionClient, 'booking'>, order: Pick<OrderRow, 'businessId' | 'pickupBookingId'>) {
  if (!order.pickupBookingId) return null;
  const b = await db.booking.findFirst({ where: { id: order.pickupBookingId, businessId: order.businessId, deletedAt: null } });
  return b && !INTAKE_CLOSED_STATUSES.includes(b.status) ? b : null;
}

/** Что показать клиенту на /o/<code> (только у готового заказа): можно ли выбрать время и на когда он уже записан */
export async function pickupPublicInfo(db: InfoDb, order: OrderRow): Promise<PublicPickupView | null> {
  if (!canBookPickup(order.status)) return null;
  const [setup, booking] = await Promise.all([pickupSetupOf(db, order.businessId), activePickupBooking(db, order)]);
  if (!setup?.enabled && !booking) return null;
  return {
    enabled: Boolean(setup?.enabled),
    slotMin: setup?.slotMin ?? intakeSlotOf(booking?.durationMin),
    booking: booking ? { start: utcToLocal(booking.startAt, DEFAULT_TZ), status: booking.status } : null,
  };
}

/** 'YYYY-MM-DD' + n дней (календарная дата, без пояса) */
function addDaysLocal(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ⭐ Выдача по времени (06.10.2026). Публичная часть — по коду ссылки заказа (10 знаков base62, не угадать перебором) и с
 * ограничением частоты в контроллере: окна на неделю, выбрать/поменять время, отменить. Только у готового заказа и только
 * когда мастерская принимает по времени. Одна активная запись на заказ (Order.pickupBookingId, уникальный): тот же выбор
 * повторно — без изменений; другое время — новая запись, прежняя снимается («Отменил клиент», без штрафа за позднюю
 * отмену). Кабинет — «Забирают сегодня» в «Заказах».
 */
@Injectable()
export class OrderPickupService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly availability?: AvailabilityService,
    @Optional() private readonly bookings?: BookingsService,
    @Optional() private readonly limits?: RateLimitService,
  ) {}

  /** Лимит изменений по коду заказа (только для существующего заказа — случайные коды ключей в Redis не плодят) */
  private async hitCodeLimit(code: string): Promise<void> {
    if (!this.limits) return;
    const res = await this.limits.hit(`public-order-pickup-code:${code}`, PICKUP_CHANGES_PER_CODE.limit, PICKUP_CHANGES_PER_CODE.windowSec);
    if (!res.allowed) throw new ApiError('rate_limited', `Too many requests, retry in ${res.retryAfter}s`);
  }

  private async orderByCode(code: string): Promise<OrderRow> {
    return publicOrderByCode(this.prisma, code);
  }

  private async readySetup(order: OrderRow): Promise<PickupSetup> {
    if (!canBookPickup(order.status)) throw new ApiError('order_not_ready', 'Order is not ready');
    const setup = await pickupSetupOf(this.prisma, order.businessId);
    if (!setup?.enabled) throw new ApiError('pickup_disabled', 'Pickup by time is off');
    return setup;
  }

  /** Кто может выдать: из настройки, только активные и с онлайн-записью; мастер заказа — первым */
  private async staffFor(order: OrderRow, setup: PickupSetup): Promise<string[]> {
    const rows = await this.prisma.staff.findMany({ where: { id: { in: setup.staffIds }, businessId: order.businessId, deletedAt: null }, select: { id: true, status: true, onlineBookingEnabled: true } });
    const ok = setup.staffIds.filter((id) => rows.some((s) => s.id === id && s.status === 'active' && s.onlineBookingEnabled !== false));
    return order.staffId && ok.includes(order.staffId) ? [order.staffId, ...ok.filter((id) => id !== order.staffId)] : ok;
  }

  private async freeStarts(order: OrderRow, setup: PickupSetup, staffId: string, date: string): Promise<string[]> {
    if (!this.availability) return [];
    const slots = await this.availability.freeSlots(order.businessId, {
      staffId,
      date,
      durationMin: setup.slotMin,
      locationId: order.locationId ?? undefined,
      serviceId: setup.serviceId ?? undefined,
    });
    return slots.map((s) => s.start);
  }

  /** Окна на PICKUP_DAYS дней вперёд (с сегодня): начало подходит, если свободен хоть один из тех, кто выдаёт */
  async slots(code: string): Promise<PickupSlotsView> {
    const order = await this.orderByCode(code);
    const setup = await this.readySetup(order);
    const staff = await this.staffFor(order, setup);
    const today = nowLocal(DEFAULT_TZ).slice(0, 10);
    const days: PickupSlotsView['days'] = [];
    for (let i = 0; i < PICKUP_DAYS; i++) {
      const date = addDaysLocal(today, i);
      const starts = new Set<string>();
      for (const staffId of staff) for (const s of await this.freeStarts(order, setup, staffId, date)) starts.add(s);
      if (starts.size) days.push({ date, slots: [...starts].sort() });
    }
    return { slotMin: setup.slotMin, days };
  }

  /**
   * Выбрать или поменять время. Тот же выбор повторно — без изменений (двойное нажатие, повтор запроса). Другое время —
   * новая запись, ссылка заказа переходит на неё условным UPDATE (если с другого устройства успели поменять раньше —
   * новая запись снимается, 409 pickup_changed), прежняя снимается как «Отменил клиент».
   */
  async book(code: string, start: string): Promise<void> {
    if (!LOCAL_START_RE.test(start)) throw new ApiError('validation', 'Invalid start', { start: 'YYYY-MM-DDTHH:mm' });
    const order = await this.orderByCode(code);
    const setup = await this.readySetup(order);
    const current = await activePickupBooking(this.prisma, order);
    if (current && utcToLocal(current.startAt, DEFAULT_TZ) === start) return;
    await this.hitCodeLimit(code);
    const today = nowLocal(DEFAULT_TZ).slice(0, 10);
    const date = start.slice(0, 10);
    if (date < today || date > addDaysLocal(today, PICKUP_DAYS - 1)) throw new ApiError('slot_taken', 'Start is outside the pickup window');
    let staffId: string | undefined;
    for (const id of await this.staffFor(order, setup)) {
      if ((await this.freeStarts(order, setup, id, date)).includes(start)) {
        staffId = id;
        break;
      }
    }
    if (!staffId || !this.bookings) throw new ApiError('slot_taken', 'Slot is not offered');
    // Мастерская включила приём до 06.10.2026 — «Выдачу заказа» заводим сейчас, с теми же окном и людьми
    const serviceId =
      setup.serviceId ?? (await syncPickupService(this.prisma, { businessId: order.businessId, sphereId: setup.sphereId, durationMin: setup.slotMin, staffIds: setup.staffIds, enabled: true, by: null }));
    const placed = await this.bookings.place(clientActor(null, 'link_holder'), {
      source: 'link',
      businessId: order.businessId,
      staffId,
      start,
      services: [{ serviceId }],
      locationId: order.locationId ?? undefined,
      client: { phone: order.clientPhone, name: order.clientName },
      comment: pickupBookingComment(order.number, order.items),
      staffAssignment: 'any',
      orderPickup: true,
    });
    const linked = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'ready', pickupBookingId: order.pickupBookingId ?? null },
      data: { pickupBookingId: placed.booking.id },
    });
    if (linked.count !== 1) {
      await this.cancelBooking(order.businessId, placed.booking.id);
      throw new ApiError('pickup_changed', 'Pickup time changed concurrently');
    }
    if (current) await this.cancelBooking(order.businessId, current.id);
  }

  /** «Не смогу в это время»: снять запись на выдачу (её нет — успех без изменений) */
  async cancel(code: string): Promise<void> {
    const order = await this.orderByCode(code);
    // Только у готового заказа: выданный (запись «Пришёл») или отменённый — ссылку на запись не трогаем, это история
    if (!canBookPickup(order.status)) return;
    const current = await activePickupBooking(this.prisma, order);
    if (!current) return;
    await this.hitCodeLimit(code);
    // Снять не вышло (запись уже «Пришёл» / «Не пришёл») — ошибка клиенту, связь заказа с записью остаётся
    await this.cancelBooking(order.businessId, current.id, { strict: true });
    await this.prisma.order.updateMany({ where: { id: order.id, pickupBookingId: current.id }, data: { pickupBookingId: null } });
  }

  /** Снять запись на выдачу от имени клиента — без правил «поздней отмены» (это не визит, неявку не ставим) */
  private async cancelBooking(businessId: string, bookingId: string, opts: { strict?: boolean } = {}): Promise<void> {
    if (!this.bookings) return;
    try {
      await this.bookings.changeStatus(clientActor(null, 'link_holder'), [businessId], bookingId, 'cancelled_by_client', 'client');
    } catch (err) {
      if (opts.strict) throw err;
      logger.warn({ err, bookingId }, 'orders: запись на выдачу не снята');
    }
  }

  /** «Забирают сегодня»: записи на выдачу за день (время Еревана) — кто придёт, за каким заказом и выдан ли он уже */
  async bookingsOn(ctx: RequestContext, businessId: string, date: string): Promise<PickupBookingView[]> {
    const svc = await findPickupService(this.prisma, businessId);
    if (!svc) return [];
    const { from, to } = localDayRangeUtc(date, DEFAULT_TZ);
    const rows = (
      await this.prisma.booking.findMany({
        where: { businessId, deletedAt: null, startAt: { gte: from, lt: to }, status: { notIn: [...INTAKE_CLOSED_STATUSES] } },
        orderBy: { startAt: 'asc' },
        take: 500,
      })
    )
      .filter((b) => isPickupBooking(b.services, svc.id))
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    if (!rows.length) return [];
    const clientIds = [...new Set(rows.map((b) => b.clientId).filter((x): x is string => Boolean(x)))];
    const [clients, orders] = await Promise.all([
      clientIds.length ? this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, phone: true } }) : Promise.resolve([]),
      this.prisma.order.findMany({ where: { businessId, pickupBookingId: { in: rows.map((b) => b.id) } }, select: { id: true, number: true, status: true, items: true, pickupBookingId: true } }),
    ]);
    const canPhones = ctx.member?.permissions.has('clients.phones') ?? false;
    return rows.map((b) => {
      const client = clients.find((c) => c.id === b.clientId);
      const order = orders.find((o) => o.pickupBookingId === b.id);
      const phone = client?.phone ?? '';
      const items = order ? (order.items as OrderItem[] | null) ?? [] : [];
      return {
        bookingId: b.id,
        start: utcToLocal(b.startAt, DEFAULT_TZ),
        durationMin: b.durationMin,
        status: b.status,
        staffId: b.staffId,
        clientId: b.clientId,
        clientName: b.visitorName ?? client?.name ?? '',
        clientPhone: canPhones ? phone : maskPhone(phone),
        orderId: order?.id ?? null,
        orderNumber: order?.number ?? null,
        orderStatus: (order?.status as OrderStatus | undefined) ?? null,
        items: order ? items.map((i) => (i.qty > 1 ? `${i.title} ×${i.qty}` : i.title)).join(' · ') || null : (b.comment ?? null),
      };
    });
  }
}
