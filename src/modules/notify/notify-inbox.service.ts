import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { isOnlineSource } from '../journal/rules.js';
import { dayCloseInboxEvents } from './day-close-notice.js';

/** Тот же словарь, что InboxEventKind фронта (src/api/notify.ts) — колокольчик кабинета читает те же переходы */
export type InboxEventKind = 'created' | 'onlineCreated' | 'cancelled' | 'moved' | 'deleted' | 'delayed' | 'dayClosed';

export interface InboxEvent {
  id: string;
  /** Нет у 'dayClosed' — строка ведёт в «Итоги дня» */
  bookingId?: string;
  createdAt: string;
  date: string;
  kind: InboxEventKind;
  /** ⭐ 'dayClosed' (01.10.2026): итог кассы дня владельцу — day-close-notice.ts */
  dayClose?: { closedByName: string; revenue: number; cash: number; discrepancy: number };
}

/** Кто смотрит ленту: «День закрыт» — личные строки владельцев */
export interface InboxViewer {
  staffId: string;
  userId: string;
}
export interface InboxPreviewItem extends InboxEvent {
  unread: boolean;
}

const CANCELLED = new Set(['cancelled_by_client', 'cancelled_by_master']);
const AREA_WEB_POPUP = 'notify-web-popup';

/**
 * Колокольчик кабинета (F-05-061): та же лента, что фронт раньше строил сам из booking_events —
 * не переизобретаем правило перехода, только читаем его с сервера (тот же `BookingEvent`, что пишет
 * `BookingsService.logEvents`, docs/backend/02-api.md §10). «Прочитано» — общее на бизнес, не персональное
 * (как в моке `s.inboxRead[businessId]`, не на сотрудника — F-05-061 не просит персонального счётчика).
 */
@Injectable()
export class NotifyInboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * F-05-058: галочки «Уведомления в Web-версии» гасят свои строки — «Операции с записями» (bookingOps) события записей,
   * ⭐ «Закрытие дня» (dayClose, нет поля — включено) строки «День закрыт». Как inboxEvents мока.
   */
  private async events(businessId: string, viewer: InboxViewer | null): Promise<InboxEvent[]> {
    const popupRow = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_WEB_POPUP } } });
    const popup = (popupRow?.data as { bookingOps?: boolean; dayClose?: boolean } | null) ?? {};
    const dayClosed: InboxEvent[] = viewer && popup.dayClose !== false ? await dayCloseInboxEvents(this.prisma, businessId, viewer) : [];
    const bookingEvents = popup.bookingOps === false ? [] : await this.bookingEvents(businessId);
    return [...dayClosed, ...bookingEvents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30);
  }

  private async bookingEvents(businessId: string): Promise<InboxEvent[]> {
    const rows = await this.prisma.bookingEvent.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: 200 });
    const bookingIds = [...new Set(rows.filter((r) => r.kind === 'created').map((r) => r.bookingId))];
    const bookings = bookingIds.length ? await this.prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, source: true } }) : [];
    const sourceById = new Map(bookings.map((b) => [b.id, b.source]));
    const out: InboxEvent[] = [];
    for (const e of rows) {
      let kind: InboxEventKind | undefined;
      if (e.kind === 'created') kind = isOnlineSource(sourceById.get(e.bookingId) ?? '') ? 'onlineCreated' : 'created';
      else if (e.kind === 'status' && e.toStatus && CANCELLED.has(e.toStatus)) kind = 'cancelled';
      else if (e.kind === 'moved') kind = 'moved';
      else if (e.kind === 'deleted') kind = 'deleted';
      else if (e.kind === 'delayed') kind = 'delayed';
      if (!kind) continue;
      out.push({ id: e.id, bookingId: e.bookingId, createdAt: e.at.toISOString(), date: (e.startLocal || e.at.toISOString()).slice(0, 10), kind });
    }
    return out.slice(0, 30);
  }

  async countUnread(businessId: string, viewer: InboxViewer | null): Promise<number> {
    const [events, read] = await Promise.all([this.events(businessId, viewer), this.readIds(businessId)]);
    return events.filter((e) => !read.has(e.id)).length;
  }

  async preview(businessId: string, viewer: InboxViewer | null, limit = 5): Promise<InboxPreviewItem[]> {
    const [events, read] = await Promise.all([this.events(businessId, viewer), this.readIds(businessId)]);
    return events.slice(0, limit).map((e) => ({ ...e, unread: !read.has(e.id) }));
  }

  async list(businessId: string, viewer: InboxViewer | null): Promise<InboxPreviewItem[]> {
    const [events, read] = await Promise.all([this.events(businessId, viewer), this.readIds(businessId)]);
    return events.map((e) => ({ ...e, unread: !read.has(e.id) }));
  }

  async markRead(businessId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.prisma.bizInboxRead.createMany({ data: ids.map((eventId) => ({ businessId, eventId })), skipDuplicates: true });
  }

  async markAllRead(businessId: string, viewer: InboxViewer | null): Promise<void> {
    const events = await this.events(businessId, viewer);
    await this.markRead(businessId, events.map((e) => e.id));
  }

  private async readIds(businessId: string): Promise<Set<string>> {
    const rows = await this.prisma.bizInboxRead.findMany({ where: { businessId }, select: { eventId: true } });
    return new Set(rows.map((r) => r.eventId));
  }
}
