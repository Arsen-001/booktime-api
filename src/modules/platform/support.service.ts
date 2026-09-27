import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

type SupportStatus = 'open' | 'waiting' | 'closed';
type SupportMessage = { id: string; author: 'them' | 'us'; text: string; at: string };

const STATUS_RANK: Record<SupportStatus, number> = { open: 0, waiting: 1, closed: 2 };

/** BizRequest.status (open|answered|closed) → очередь панели (open|waiting|closed) — тот же приём, что
 * NOTIFY_STATUS_TO_SCREEN у отчётов этапа 16, разные словари сведены явной картой, а не совпадением строк */
const BIZ_TO_QUEUE: Record<string, SupportStatus> = { open: 'open', answered: 'waiting', closed: 'closed' };
const QUEUE_TO_BIZ: Record<SupportStatus, string> = { open: 'open', waiting: 'answered', closed: 'closed' };

interface TicketView {
  id: string;
  number: number;
  from: 'business' | 'client';
  businessId?: string;
  businessName?: string;
  appUserId?: string;
  name: string;
  phone?: string;
  channel: string;
  section?: string;
  topic: string;
  status: SupportStatus;
  messages: SupportMessage[];
  lastMessage: string;
  createdAt: string;
  updatedAt: string;
}

function fromSupportTicket(t: Prisma.SupportTicketGetPayload<object>, businessName?: string): TicketView {
  const messages = (t.messages as SupportMessage[] | null) ?? [{ id: t.id, author: 'them', text: t.message, at: utcToLocal(t.createdAt) }];
  return {
    id: t.id,
    number: t.number ?? 0,
    from: 'client',
    appUserId: t.appUserId ?? undefined,
    name: t.name ?? 'Клиент',
    phone: t.phone ?? undefined,
    channel: t.channel,
    section: t.section ?? undefined,
    topic: t.topic,
    status: t.status as SupportStatus,
    messages,
    lastMessage: messages[messages.length - 1]?.text ?? t.message,
    createdAt: utcToLocal(t.createdAt),
    updatedAt: utcToLocal(t.updatedAt),
    businessName,
  };
}

function fromBizRequest(r: Prisma.BizRequestGetPayload<object>, businessName?: string): TicketView {
  const messages: SupportMessage[] = [{ id: r.id, author: 'them', text: r.message ?? '', at: utcToLocal(r.createdAt) }];
  if (r.reply) messages.push({ id: `${r.id}_reply`, author: 'us', text: r.reply, at: r.repliedAt ? utcToLocal(r.repliedAt) : utcToLocal(r.updatedAt) });
  return {
    id: r.id,
    number: r.number ?? 0,
    from: 'business',
    businessId: r.businessId,
    businessName,
    name: businessName ?? r.businessId,
    channel: 'cabinet',
    topic: 'help',
    status: BIZ_TO_QUEUE[r.status] ?? 'open',
    messages,
    lastMessage: messages[messages.length - 1]?.text ?? '',
    createdAt: utcToLocal(r.createdAt),
    updatedAt: utcToLocal(r.updatedAt),
  };
}

/**
 * Поддержка (F-00-182) — одна очередь из двух источников: SupportTicket (клиент, этап 9) и
 * BizRequest(kind=help) (кабинет, этап 18). Нить упрощена против SupportMessage[] мока: одно входящее +
 * один наш ответ на сторону бизнеса (BizRequest не хранит многоходовую переписку) — честно, записано в PROGRESS.
 */
@Injectable()
export class PlatformSupportService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: { status?: SupportStatus | 'active'; channel?: string }): Promise<TicketView[]> {
    const [tickets, requests] = await Promise.all([
      this.prisma.supportTicket.findMany({ take: 500, orderBy: { updatedAt: 'desc' } }),
      this.prisma.bizRequest.findMany({ where: { kind: 'help' }, take: 500, orderBy: { updatedAt: 'desc' } }),
    ]);
    const bizIds = [...new Set(requests.map((r) => r.businessId))];
    const names = new Map((await this.prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    let rows = [...tickets.map((t) => fromSupportTicket(t)), ...requests.map((r) => fromBizRequest(r, names.get(r.businessId)))];
    if (filter.status === 'active') rows = rows.filter((r) => r.status !== 'closed');
    else if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.channel) rows = rows.filter((r) => r.channel === filter.channel);
    return rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt.localeCompare(a.updatedAt));
  }

  private async find(id: string): Promise<{ kind: 'ticket' | 'request' }> {
    if (await this.prisma.supportTicket.findUnique({ where: { id }, select: { id: true } })) return { kind: 'ticket' };
    if (await this.prisma.bizRequest.findUnique({ where: { id }, select: { id: true } })) return { kind: 'request' };
    throw new ApiError('not_found', 'Support ticket not found');
  }

  async reply(id: string, text: string): Promise<TicketView> {
    const { kind } = await this.find(id);
    const now = new Date();
    if (kind === 'ticket') {
      const t = await this.prisma.supportTicket.findUniqueOrThrow({ where: { id } });
      const messages = [...((t.messages as SupportMessage[] | null) ?? []), { id: newId('supportTicket'), author: 'us' as const, text, at: utcToLocal(now) }];
      const updated = await this.prisma.supportTicket.update({ where: { id }, data: { status: 'waiting', messages: messages as unknown as Prisma.InputJsonValue } });
      return fromSupportTicket(updated);
    }
    const r = await this.prisma.bizRequest.update({ where: { id }, data: { reply: text, repliedAt: now, status: 'answered' } });
    const biz = await this.prisma.business.findUnique({ where: { id: r.businessId }, select: { name: true } });
    return fromBizRequest(r, biz?.name);
  }

  async setStatus(id: string, status: SupportStatus): Promise<TicketView> {
    const { kind } = await this.find(id);
    if (kind === 'ticket') {
      const updated = await this.prisma.supportTicket.update({ where: { id }, data: { status } });
      return fromSupportTicket(updated);
    }
    const r = await this.prisma.bizRequest.update({ where: { id }, data: { status: QUEUE_TO_BIZ[status] } });
    const biz = await this.prisma.business.findUnique({ where: { id: r.businessId }, select: { name: true } });
    return fromBizRequest(r, biz?.name);
  }
}
