import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import { maskPhone, normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { notifyOrderReady } from './order-notify.js';
import {
  ACTIVE_ORDER_STATUSES,
  canTransition,
  FIRST_ORDER_NUMBER,
  newOrderCode,
  ORDER_CODE_RE,
  orderMatches,
  orderView,
  publicOrderView,
  type OrderHistoryEntry,
  type OrderRow,
  type OrderStatus,
  type OrderView,
  type PublicOrderView,
} from './order-rules.js';
import type { CreateOrderBody, ListOrdersQuery, PatchOrderBody } from './orders.schemas.js';

type Tx = Prisma.TransactionClient;
const J = (v: unknown) => v as Prisma.InputJsonValue;
const errCode = (err: unknown) => (err as { code?: string }).code;
/** Поиск по тексту фильтрует в памяти (items — JSON) — не больше стольких последних заказов бизнеса */
const SEARCH_SCAN_CAP = 5000;

/**
 * Следующий номер заказа бизнеса (1001, 1002, …). Атомарно: UPDATE … last_number + 1 держит блокировку строки до
 * конца транзакции создания, параллельный запрос ждёт и получает следующий номер. Первого заказа ещё нет — вставка
 * 1001; гонка двух первых заказов — вторая вставка падает P2002 и берёт UPDATE.
 */
export async function nextOrderNumber(tx: Pick<Tx, 'orderCounter'>, businessId: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await tx.orderCounter.update({ where: { businessId }, data: { lastNumber: { increment: 1 } } });
      return row.lastNumber;
    } catch (err) {
      if (errCode(err) !== 'P2025') throw err;
    }
    try {
      await tx.orderCounter.create({ data: { businessId, lastNumber: FIRST_ORDER_NUMBER } });
      return FIRST_ORDER_NUMBER;
    } catch (err) {
      if (errCode(err) !== 'P2002') throw err;
    }
  }
  throw new ApiError('conflict', 'order number allocation failed');
}

/** Создать строку заказа с уникальным code: совпадение кода (P2002 по code) — новый код, до 5 попыток */
export async function insertOrderWithCode(tx: Pick<Tx, 'order'>, data: Omit<Prisma.OrderUncheckedCreateInput, 'code'>): Promise<OrderRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return (await tx.order.create({ data: { ...data, code: newOrderCode() } })) as OrderRow;
    } catch (err) {
      const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
      if (errCode(err) !== 'P2002' || (target && !target.includes('code'))) throw err;
    }
  }
  throw new ApiError('conflict', 'order code collision');
}

/** Раздел «Заказы» (03.10.2026): ателье, ремонт, химчистка, детейлинг */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(BUSINESS_MESSENGER) private readonly messenger: BusinessMessenger,
  ) {}

  private out(ctx: RequestContext, row: OrderRow): OrderView {
    const v = orderView(row);
    return ctx.member?.permissions.has('clients.phones') ? v : { ...v, clientPhone: maskPhone(v.clientPhone) };
  }

  private async find(businessId: string, orderId: string): Promise<OrderRow> {
    const row = await this.prisma.order.findFirst({ where: { id: orderId, businessId } });
    if (!row) throw new ApiError('not_found', 'Order not found');
    return row as OrderRow;
  }

  // ─────────── список ───────────

  async list(ctx: RequestContext, businessId: string, q: ListOrdersQuery): Promise<{ items: OrderView[]; total: number }> {
    const where: Prisma.OrderWhereInput = { businessId };
    if (q.status === 'active') where.status = { in: [...ACTIVE_ORDER_STATUSES] };
    else if (q.status !== 'all') where.status = q.status;
    const orderBy: Prisma.OrderOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { number: 'desc' }];
    const skip = (q.page - 1) * q.pageSize;
    const text = q.q?.trim();
    if (!text) {
      const [total, rows] = await Promise.all([this.prisma.order.count({ where }), this.prisma.order.findMany({ where, orderBy, skip, take: q.pageSize })]);
      return { items: rows.map((r) => this.out(ctx, r as OrderRow)), total };
    }
    const canPhones = ctx.member?.permissions.has('clients.phones') ?? false;
    const light = await this.prisma.order.findMany({ where, orderBy, take: SEARCH_SCAN_CAP, select: { id: true, number: true, clientName: true, clientPhone: true, items: true } });
    // Без права clients.phones номер скрыт — искать по нему тоже нельзя
    const hits = light.filter((r) => orderMatches(canPhones ? r : { ...r, clientPhone: '' }, text));
    const pageIds = hits.slice(skip, skip + q.pageSize).map((r) => r.id);
    const rows = pageIds.length ? await this.prisma.order.findMany({ where: { id: { in: pageIds } } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r as OrderRow]));
    return { items: pageIds.map((id) => byId.get(id)).filter((r): r is OrderRow => Boolean(r)).map((r) => this.out(ctx, r)), total: hits.length };
  }

  async get(ctx: RequestContext, businessId: string, orderId: string): Promise<OrderView> {
    return this.out(ctx, await this.find(businessId, orderId));
  }

  // ─────────── проверки ссылок ───────────

  private async checkStaff(businessId: string, staffId: string | null | undefined): Promise<void> {
    if (!staffId) return;
    const s = await this.prisma.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null }, select: { id: true } });
    if (!s) throw new ApiError('staff_not_found', 'Staff not found');
  }

  private async checkLocation(businessId: string, locationId: string | null | undefined): Promise<void> {
    if (!locationId) return;
    const l = await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null }, select: { id: true } });
    if (!l) throw new ApiError('not_found', 'Location not found');
  }

  /** Явный clientId — должен быть клиентом этого бизнеса; иначе — клиент бизнеса с тем же номером, если есть */
  private async resolveClientId(businessId: string, clientId: string | null | undefined, phone: string): Promise<string | null> {
    if (clientId) {
      const c = await this.prisma.client.findFirst({ where: { id: clientId, businessId, deletedAt: null }, select: { id: true } });
      if (!c) throw new ApiError('not_found', 'Client not found');
      return c.id;
    }
    const byPhone = await this.prisma.client.findFirst({ where: { businessId, phone, deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return byPhone?.id ?? null;
  }

  private phoneOf(input: string): string {
    const phone = normalizePhone(input);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374');
    return phone;
  }

  private checkMoney(price: number, prepaid: number): void {
    if (prepaid > price) throw new ApiError('validation', 'Prepaid exceeds price', { prepaid: 'Prepaid must not exceed price' });
  }

  // ─────────── создание и правка ───────────

  async create(ctx: RequestContext, businessId: string, body: CreateOrderBody): Promise<OrderView> {
    const phone = this.phoneOf(body.clientPhone);
    const prepaid = body.prepaid ?? 0;
    this.checkMoney(body.price, prepaid);
    await this.checkStaff(businessId, body.staffId);
    await this.checkLocation(businessId, body.locationId);
    const clientId = await this.resolveClientId(businessId, body.clientId, phone);
    const by = ctx.member?.staffId ?? null;
    const now = new Date();
    const history: OrderHistoryEntry[] = [{ at: now.toISOString(), status: 'received', by }];
    const row = await this.prisma.$transaction(async (tx) => {
      const number = await nextOrderNumber(tx, businessId);
      const created = await insertOrderWithCode(tx, {
        id: newId('order'),
        businessId,
        locationId: body.locationId ?? null,
        number,
        clientId,
        clientName: body.clientName.trim(),
        clientPhone: phone,
        items: J(body.items),
        photos: J(body.photos ?? []),
        staffId: body.staffId ?? null,
        status: 'received',
        dueDate: body.dueDate ?? null,
        price: body.price,
        prepaid,
        comment: body.comment?.trim() || null,
        history: J(history),
        createdAt: now,
      });
      await this.audit.record(tx, ctx, { action: 'created', entityType: 'order', entityId: created.id, businessId, after: auditOf(created) });
      return created;
    });
    return this.out(ctx, row);
  }

  async patch(ctx: RequestContext, businessId: string, orderId: string, body: PatchOrderBody): Promise<OrderView> {
    const before = await this.find(businessId, orderId);
    const data: Prisma.OrderUncheckedUpdateInput = {};
    let phone = before.clientPhone;
    if (body.clientPhone !== undefined) {
      phone = this.phoneOf(body.clientPhone);
      if (phone !== before.clientPhone && !ctx.member?.permissions.has('clients.phones')) throw new ApiError('forbidden', 'Missing permission: clients.phones');
      data.clientPhone = phone;
    }
    if (body.clientId !== undefined) data.clientId = body.clientId === null ? null : await this.resolveClientId(businessId, body.clientId, phone);
    else if (phone !== before.clientPhone) data.clientId = await this.resolveClientId(businessId, null, phone);
    if (body.clientName !== undefined) data.clientName = body.clientName.trim();
    if (body.items !== undefined) data.items = J(body.items);
    if (body.photos !== undefined) data.photos = J(body.photos);
    if (body.staffId !== undefined) {
      await this.checkStaff(businessId, body.staffId);
      data.staffId = body.staffId;
    }
    if (body.locationId !== undefined) {
      await this.checkLocation(businessId, body.locationId);
      data.locationId = body.locationId;
    }
    if (body.dueDate !== undefined) data.dueDate = body.dueDate;
    if (body.price !== undefined) data.price = body.price;
    if (body.prepaid !== undefined) data.prepaid = body.prepaid;
    if (body.comment !== undefined) data.comment = body.comment?.trim() || null;
    this.checkMoney(body.price ?? before.price, body.prepaid ?? before.prepaid);
    const row = await this.prisma.$transaction(async (tx) => {
      const after = (await tx.order.update({ where: { id: before.id }, data })) as OrderRow;
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'order', entityId: before.id, businessId, before: auditOf(before), after: auditOf(after) });
      return after;
    });
    return this.out(ctx, row);
  }

  // ─────────── статус и «готов» ───────────

  async setStatus(ctx: RequestContext, businessId: string, orderId: string, to: OrderStatus): Promise<OrderView> {
    const before = await this.find(businessId, orderId);
    if (!canTransition(before.status, to)) throw new ApiError('invalid_order_transition', `Cannot move order from ${before.status} to ${to}`);
    const now = new Date();
    const history = [...((before.history as OrderHistoryEntry[] | null) ?? []), { at: now.toISOString(), status: to, by: ctx.member?.staffId ?? null }];
    const data: Prisma.OrderUncheckedUpdateManyInput = { status: to, history: J(history) };
    if (to === 'ready') {
      data.readyNotifiedAt = now;
      // Новый «Готов» — новый отсчёт напоминаний «заказ ждёт вас» (3 и 7 дней с этого момента)
      data.pickupReminderCount = 0;
      data.pickupRemindedAt = null;
    }
    if (to === 'issued') data.issuedAt = now;
    const row = await this.prisma.$transaction(async (tx) => {
      // Статус мог смениться параллельно — переход только из того статуса, который проверили
      const res = await tx.order.updateMany({ where: { id: before.id, businessId, status: before.status }, data });
      if (res.count !== 1) throw new ApiError('invalid_order_transition', 'Order status changed concurrently');
      const after = (await tx.order.findUniqueOrThrow({ where: { id: before.id } })) as OrderRow;
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'order', entityId: before.id, businessId, before: { status: before.status }, after: { status: to } });
      return after;
    });
    if (to === 'ready') await this.notifyReady(row, now);
    return this.out(ctx, row);
  }

  /** «Напомнить, что готов» — только у готового заказа */
  async resendReady(ctx: RequestContext, businessId: string, orderId: string): Promise<OrderView> {
    const order = await this.find(businessId, orderId);
    if (order.status !== 'ready') throw new ApiError('order_not_ready', 'Order is not ready');
    const now = new Date();
    const row = (await this.prisma.order.update({ where: { id: order.id }, data: { readyNotifiedAt: now } })) as OrderRow;
    await this.notifyReady(row, now);
    return this.out(ctx, row);
  }

  /** Уведомление — по возможности: сбой отправки не отменяет смену статуса */
  private async notifyReady(order: OrderRow, now: Date): Promise<void> {
    try {
      const biz = await this.prisma.business.findUnique({ where: { id: order.businessId }, select: { name: true, brandName: true } });
      await notifyOrderReady(this.prisma, this.messenger, { order, businessName: biz?.brandName || biz?.name || 'BookTime', siteUrl: env.PUBLIC_SITE_URL, now });
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'orders: уведомление «заказ готов» упало');
    }
  }

  // ─────────── публичная страница /o/<code> ───────────

  async publicByCode(code: string): Promise<PublicOrderView> {
    const row = ORDER_CODE_RE.test(code) ? ((await this.prisma.order.findUnique({ where: { code } })) as OrderRow | null) : null;
    if (!row) throw new ApiError('not_found', 'Order not found');
    const biz = await this.prisma.business.findUnique({ where: { id: row.businessId }, select: { name: true, phone: true, slug: true } });
    if (!biz) throw new ApiError('not_found', 'Order not found');
    const loc = row.locationId
      ? await this.prisma.location.findFirst({ where: { id: row.locationId, businessId: row.businessId }, select: { address: true, phone: true } })
      : await this.prisma.location.findFirst({ where: { businessId: row.businessId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { address: true, phone: true } });
    const address = (loc?.address as { ru?: string; hy?: string; en?: string } | null) ?? null;
    return publicOrderView(row, { name: biz.name, phone: loc?.phone || biz.phone, address: address?.ru || address?.hy || address?.en || '', slug: biz.slug });
  }
}

/** Журнал изменений: без фото (data URI) и без истории — только то, что человек меняет */
function auditOf(r: OrderRow): Record<string, unknown> {
  return {
    number: r.number,
    status: r.status,
    clientName: r.clientName,
    clientPhone: r.clientPhone,
    clientId: r.clientId,
    items: r.items,
    staffId: r.staffId,
    locationId: r.locationId,
    dueDate: r.dueDate,
    price: r.price,
    prepaid: r.prepaid,
    comment: r.comment,
  };
}
