import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { BookingsService, staffActor } from '../journal/bookings.service.js';

const J = (v: unknown) => v as Prisma.InputJsonValue;
const CHAT_LEAD_TAG = 'Лид из чата';

type Localized = { ru: string; en: string };

/**
 * Этап 21 (сдача, попытка 6): чат с клиентом через бота-партнёра (F-05-087/088) и три демо-кнопки раздела
 * «Уведомления» (F-05-071 тест WhatsApp, F-05-076 партнёр подтверждает запись, F-05-121 запись внешним агентом).
 * Р19: настоящего обмена с чужими сервисами нет — демо-кнопки меняют только наши данные (журнал отправок,
 * статус записи тем же путём, что сотрудник в кабинете, переписка), как в моке src/api/notify.ts.
 */
@Injectable()
export class NotifyChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  private messageView(m: { id: string; businessId: string; phone: string; clientId: string | null; direction: string; text: string; attachmentName: string | null; createdAt: Date }) {
    return {
      id: m.id,
      businessId: m.businessId,
      phone: m.phone,
      ...(m.clientId ? { clientId: m.clientId } : {}),
      direction: m.direction as 'in' | 'out',
      text: m.text,
      ...(m.attachmentName ? { attachmentName: m.attachmentName } : {}),
      createdAt: utcToLocal(m.createdAt),
    };
  }

  async unread(businessId: string): Promise<number> {
    return this.prisma.notifyChatMessage.count({ where: { businessId, direction: 'in', readAt: null } });
  }

  async clearUnread(businessId: string): Promise<void> {
    await this.prisma.notifyChatMessage.updateMany({ where: { businessId, direction: 'in', readAt: null }, data: { readAt: new Date() } });
  }

  async list(businessId: string, phone: string) {
    const rows = await this.prisma.notifyChatMessage.findMany({ where: { businessId, phone }, orderBy: { createdAt: 'asc' }, take: 500 });
    return rows.map((r) => this.messageView(r));
  }

  async send(businessId: string, input: { phone: string; clientId?: string; text: string; attachmentName?: string }) {
    const text = input.text.trim();
    if (!text && !input.attachmentName) throw new ApiError('validation', 'Message is empty', { text: 'required' });
    const row = await this.prisma.notifyChatMessage.create({
      data: { id: newId('notifyChatMessage'), businessId, phone: input.phone, clientId: input.clientId ?? null, direction: 'out', text, attachmentName: input.attachmentName ?? null },
    });
    return this.messageView(row);
  }

  /** «Клиент написал» — место будущего вебхука партнёра; новый собеседник сам попадает в базу «Лид из чата» (F-05-088) */
  async simulateIncoming(ctx: RequestContext, businessId: string, input: { phone: string; clientId?: string; text: string }) {
    let clientId = input.clientId;
    if (!clientId) {
      const phone = normalizePhone(input.phone) ?? input.phone;
      const existing = await this.prisma.client.findFirst({ where: { businessId, phone, deletedAt: null }, select: { id: true } });
      clientId =
        existing?.id ??
        (
          await this.prisma.client.create({
            data: { id: newId('client'), businessId, phone, name: 'Без имени', gender: 'unknown', tags: [CHAT_LEAD_TAG], source: 'chat', createdBy: ctx.member?.staffId ?? 'system', updatedBy: ctx.member?.staffId ?? 'system' },
            select: { id: true },
          })
        ).id;
    }
    const row = await this.prisma.notifyChatMessage.create({
      data: { id: newId('notifyChatMessage'), businessId, phone: input.phone, clientId, direction: 'in', text: input.text.trim() || 'Здравствуйте!' },
    });
    return this.messageView(row);
  }

  private async logRow(businessId: string, input: { typeCode?: number; typeLabel: Localized; channel: string; status: string; contact: string; text: Localized; bookingId?: string }) {
    const id = newId('notifyLogEntry');
    await this.prisma.notifyLogEntry.create({
      data: {
        id,
        businessId,
        dedupeKey: `svc:${id}`,
        sentAt: new Date(),
        typeCode: input.typeCode ?? null,
        typeLabel: J(input.typeLabel),
        channel: input.channel,
        status: input.status,
        contact: input.contact,
        text: J(input.text),
        bookingId: input.bookingId ?? null,
        source: 'service',
      },
    });
  }

  /** F-05-076: бот-партнёр подтверждает ближайшую запись «ожидает подтверждения» тем же путём, что сотрудник */
  async simulatePartnerConfirm(ctx: RequestContext, businessId: string): Promise<{ confirmed: boolean }> {
    const target = await this.prisma.booking.findFirst({ where: { businessId, deletedAt: null, status: 'awaiting_confirmation' }, orderBy: { startAt: 'asc' }, select: { id: true } });
    if (!target) return { confirmed: false };
    await this.bookings.changeStatus(staffActor(ctx), [businessId], target.id, 'client_confirmed', 'business');
    await this.logRow(businessId, {
      typeCode: 73,
      typeLabel: { ru: 'Подтверждение через бота-партнёра', en: 'Confirmed via a partner bot' },
      channel: 'whatsapp',
      status: 'sent',
      contact: '—',
      text: { ru: 'Запись подтверждена ботом-партнёром через API.', en: 'The booking was confirmed by a partner bot via the API.' },
      bookingId: target.id,
    });
    return { confirmed: true };
  }

  private async setting<T>(businessId: string, area: string, fallback: T): Promise<T> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area } } });
    return { ...fallback, ...((row?.data as Partial<T> | undefined) ?? {}) };
  }

  /** F-05-071: тест уходит, только если канал подключён и шаблоны одобрены */
  async sendTestWhatsApp(ctx: RequestContext, businessId: string): Promise<{ sent: boolean }> {
    const wa = await this.setting(businessId, 'notify-altegio-whatsapp', { mode: 'none', templatesApproved: false });
    const sent = wa.mode !== 'none' && wa.templatesApproved;
    const staff = ctx.member?.staffId ? await this.prisma.staff.findUnique({ where: { id: ctx.member.staffId }, select: { phone: true } }) : null;
    await this.logRow(businessId, {
      typeLabel: { ru: 'Тест WhatsApp', en: 'WhatsApp test' },
      channel: 'whatsapp',
      status: sent ? 'sent' : 'rejected',
      contact: staff?.phone || '—',
      text: { ru: 'Тестовое сообщение WhatsApp.', en: 'WhatsApp test message.' },
    });
    return { sent };
  }

  /** F-05-121: внешний агент создал запись — клиенту уходит уведомление, только если агент передал флаг и он включён */
  async simulateAgentBooking(businessId: string, input: { clientPhone: string; sendToClient: boolean }): Promise<{ sent: boolean }> {
    const flags = await this.setting(businessId, 'notify-agent-flags', { sendToClient: true, sendToAdmin: true });
    const sent = input.sendToClient && flags.sendToClient;
    await this.logRow(businessId, {
      typeCode: 2,
      typeLabel: { ru: 'Запись через внешнего агента', en: 'Booking created by an external agent' },
      channel: 'push',
      status: sent ? 'sent' : 'rejected',
      contact: input.clientPhone.slice(0, 160),
      text: {
        ru: sent ? 'Вы записаны через внешнего помощника.' : 'Не отправлено: флаг уведомления не передан агентом.',
        en: sent ? 'You are booked via an external assistant.' : 'Not sent: the agent did not pass the notify flag.',
      },
    });
    return { sent };
  }
}
