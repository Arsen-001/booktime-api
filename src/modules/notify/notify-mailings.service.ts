import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localToUtc, utcToLocal } from '../../common/time/time.js';
import { enqueueClientNotification, enqueueOutbox } from './outbox.js';
import { SMS_PART_PRICE_AMD, smsParts } from './notify-log-derive.js';
import type { LText } from './notify-log-derive.js';
import { NotifyLogService } from './notify-log.service.js';
import type { LogMessageOut } from './notify-log.service.js';

const J = (v: unknown) => v as Prisma.InputJsonValue;
const DAY = 86_400_000;
/** ⭐ F-00-114 / F-05-095: не больше 3 бесплатных пушей подписчикам в неделю на бизнес (тот же, что фронт) */
export const WEEKLY_PUSH_LIMIT = 3;
const MAILING_LABEL: LText = { ru: 'Рассылка', en: 'Mailing', hy: 'Առաքում' };
const NETWORK_MAILING_LABEL: LText = { ru: 'Сетевая рассылка', en: 'Network mailing', hy: 'Ցանցային առաքում' };
const TEST_LABEL: LText = { ru: 'Тестовая рассылка', en: 'Test mailing', hy: 'Փորձնական առաքում' };
const NETWORK_MAILING_TYPE = 22;

export type MailingChannel = 'sms' | 'pushOwnApp' | 'pushClientApp';

/** AudienceFilter фронта (src/api/notify.ts) — F-05-096, Ув13 */
export interface AudienceFilter {
  onlyWithApp?: boolean;
  onlyBirthdayMonth?: boolean;
  excludeBlocked?: boolean;
  receivedMailing?: { status: 'received' | 'notReceived'; days: number };
  lastVisitOlderThanDays?: number;
  serviceId?: string;
  staffId?: string;
  visitKind?: 'new' | 'returning';
}

export interface MailingOut {
  id: string;
  businessId: string;
  createdAt: string;
  channel: MailingChannel;
  text: string;
  audienceLabel: string;
  recipientsCount: number;
  status: 'sent' | 'sending' | 'failed' | 'scheduled';
  network?: boolean;
  scheduledAt?: string;
  costAmd?: number;
}

export interface CreateMailingInput {
  businessIds: string[];
  channel: MailingChannel;
  text: string;
  audienceLabel: string;
  filter: AudienceFilter;
  network?: boolean;
  /** местное 'YYYY-MM-DDTHH:mm' */
  scheduledAt?: string;
}

interface Recipient {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  appUserId: string | null;
}

type MailingRow = Awaited<ReturnType<PrismaService['notifyMailing']['findMany']>>[number];

function toOut(m: MailingRow): MailingOut {
  return {
    id: m.id,
    businessId: m.businessId,
    createdAt: utcToLocal(m.createdAt),
    channel: m.channel as MailingChannel,
    text: m.text,
    audienceLabel: m.audienceLabel,
    recipientsCount: m.recipientsCount,
    status: m.status as MailingOut['status'],
    network: m.network || undefined,
    scheduledAt: m.scheduledAt ? utcToLocal(m.scheduledAt) : undefined,
    costAmd: m.costAmd,
  };
}

export function fillMailingText(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key]! : match));
}

/**
 * Рассылки (F-05-095…099, Ув13) — этап 21, лейн notify-log+mailings. Аудитория считается на сервере (не доверяем
 * счётчику экрана): сегменты «давно не был», «по услуге», «по мастеру», «новые/повторные», «день рождения в этом
 * месяце», «с приложением», «получал / не получал рассылку за N дней»; клиент с отказом от рекламы (F-05-090/098)
 * не попадает никогда; клиент нескольких филиалов сети — одно сообщение (по номеру, F-05-097). По расписанию —
 * строка ждёт `scheduled_at`, воркер (`notify.mailings`) и любое чтение раздела её отправляют; аудитория —
 * на момент отправки. SMS — через провайдера бизнеса (В-08, адаптер-заглушка), 25 ֏ за часть; пуш — очередь
 * notify_outbox клиентам с приложением.
 */
@Injectable()
export class NotifyMailingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: NotifyLogService,
    @Inject(BUSINESS_MESSENGER) private readonly messenger: BusinessMessenger,
  ) {}

  async list(businessId: string): Promise<MailingOut[]> {
    await this.processDue(businessId);
    const rows = await this.prisma.notifyMailing.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map(toOut).sort((a, b) => ((a.scheduledAt ?? a.createdAt) < (b.scheduledAt ?? b.createdAt) ? 1 : -1));
  }

  /** Сколько пушей подписчикам ушло за 7 дней — рассылки раздела + пуш-рассылки CRM (общий лимит бизнеса) */
  async countRecentAppPushes(businessId: string): Promise<number> {
    const since = new Date(Date.now() - 7 * DAY);
    const [mailings, crm] = await Promise.all([
      this.prisma.notifyMailing.count({ where: { businessId, channel: 'pushClientApp', createdAt: { gte: since } } }),
      this.prisma.clientBroadcastMessage.count({ where: { businessId, channel: 'push', source: 'bulk', sentAt: { gte: since } } }),
    ]);
    return mailings + crm;
  }

  /** Филиалы-получатели: свой бизнес или филиалы той же сети (F-05-097) */
  private async checkTargets(businessId: string, businessIds: string[]): Promise<string[]> {
    const ids = [...new Set(businessIds.length ? businessIds : [businessId])];
    if (ids.length === 1 && ids[0] === businessId) return ids;
    const own = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
    const rows = await this.prisma.business.findMany({ where: { id: { in: ids } }, select: { id: true, networkId: true } });
    if (rows.length !== ids.length || rows.some((r) => r.id !== businessId && (!own?.networkId || r.networkId !== own.networkId))) {
      throw new ApiError('forbidden', 'Mailing targets must belong to your network');
    }
    return ids;
  }

  async countAudience(businessId: string, businessIds: string[], filter: AudienceFilter): Promise<number> {
    const ids = await this.checkTargets(businessId, businessIds);
    return (await this.audience(ids, filter)).length;
  }

  async audience(businessIds: string[], filter: AudienceFilter): Promise<Recipient[]> {
    const where: Prisma.ClientWhereInput = { businessId: { in: businessIds }, deletedAt: null, purgedAt: null };
    if (filter.excludeBlocked !== false) where.OR = [{ blocked: null }, { blocked: false }];
    if (filter.onlyWithApp) where.appUserId = { not: null };
    if (filter.onlyBirthdayMonth) where.birthday = { contains: `-${String(new Date().getMonth() + 1).padStart(2, '0')}-` };
    const clients = await this.prisma.client.findMany({ where, select: { id: true, businessId: true, name: true, phone: true, appUserId: true, adConsent: true }, orderBy: { createdAt: 'asc' } });
    if (!clients.length) return [];
    const ids = clients.map((c) => c.id);
    // F-05-090/098: отказ от рекламных рассылок (настройка уведомлений клиента или согласие CRM F-04-227)
    const optedOut = new Set((await this.prisma.clientNotifyPref.findMany({ where: { clientId: { in: ids }, marketingOptOut: true }, select: { clientId: true } })).map((p) => p.clientId));
    let received: Set<string> | null = null;
    if (filter.receivedMailing) {
      const since = new Date(Date.now() - filter.receivedMailing.days * DAY);
      received = new Set(
        (await this.prisma.notifyMailingRecipient.findMany({ where: { businessId: { in: businessIds }, createdAt: { gte: since } }, select: { clientId: true } })).map((r) => r.clientId),
      );
    }
    const needsVisits = filter.lastVisitOlderThanDays !== undefined || !!filter.serviceId || !!filter.staffId || !!filter.visitKind;
    const visits = new Map<string, { start: Date; serviceIds: string[]; staffId: string }[]>();
    if (needsVisits) {
      const rows = await this.prisma.booking.findMany({
        where: { businessId: { in: businessIds }, deletedAt: null, status: 'arrived', clientId: { not: null } },
        select: { clientId: true, startAt: true, services: true, staffId: true },
      });
      for (const b of rows) {
        const list = visits.get(b.clientId!) ?? [];
        list.push({ start: b.startAt, staffId: b.staffId, serviceIds: Array.isArray(b.services) ? (b.services as { serviceId?: string }[]).map((l) => l.serviceId ?? '') : [] });
        visits.set(b.clientId!, list);
      }
    }
    const staleBefore = filter.lastVisitOlderThanDays !== undefined ? new Date(Date.now() - filter.lastVisitOlderThanDays * DAY) : null;
    const seen = new Set<string>();
    const out: Recipient[] = [];
    for (const c of clients) {
      if (optedOut.has(c.id) || (c.adConsent as { given?: boolean } | null)?.given === false) continue;
      if (needsVisits) {
        const list = visits.get(c.id) ?? [];
        if (staleBefore && (list.length === 0 || list.some((v) => v.start > staleBefore))) continue;
        if (filter.serviceId && !list.some((v) => v.serviceIds.includes(filter.serviceId!))) continue;
        if (filter.staffId && !list.some((v) => v.staffId === filter.staffId)) continue;
        if (filter.visitKind === 'new' && list.length > 1) continue;
        if (filter.visitKind === 'returning' && list.length < 2) continue;
      }
      if (received) {
        const has = received.has(c.id);
        if (filter.receivedMailing!.status === 'received' && !has) continue;
        if (filter.receivedMailing!.status === 'notReceived' && has) continue;
      }
      // F-05-097: один человек в нескольких филиалах сети — одно сообщение
      if (seen.has(c.phone)) continue;
      seen.add(c.phone);
      out.push({ id: c.id, businessId: c.businessId, name: c.name, phone: c.phone, appUserId: c.appUserId });
    }
    return out;
  }

  private async businessVars(businessId: string): Promise<Record<string, string>> {
    const b = await this.prisma.business.findUnique({ where: { id: businessId }, select: { slug: true, name: true, brandName: true, phone: true } });
    return { companyName: b?.brandName || b?.name || '', bookingLink: b?.slug ? `booktime.am/b/${b.slug}/book` : '', companyPhone: b?.phone ?? '' };
  }

  private recipientText(text: string, base: Record<string, string>, r: { name: string }): string {
    const [first, ...rest] = r.name.trim().split(/\s+/);
    return fillMailingText(text, { ...base, clientName: first ?? '', clientLastName: rest.join(' ') });
  }

  private async smsConnected(businessId: string): Promise<{ connected: boolean; channel: 'sms' | 'whatsapp' }> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'notify-sms' } } });
    const d = row?.data as { connected?: boolean; channel?: 'sms' | 'whatsapp' } | undefined;
    return { connected: !!d?.connected, channel: d?.channel ?? 'sms' };
  }

  async create(businessId: string, staffId: string | undefined, input: CreateMailingInput): Promise<MailingOut> {
    const text = input.text.trim();
    if (!text) throw new ApiError('empty_text', 'Text is empty');
    const targets = await this.checkTargets(businessId, input.businessIds);
    // ⭐ F-00-114 / F-05-095: лимит проверяется здесь, а не только кнопкой экрана
    if (input.channel === 'pushClientApp' && (await this.countRecentAppPushes(businessId)) >= WEEKLY_PUSH_LIMIT) {
      throw new ApiError('weekly_push_limit', 'notify/weekly-push-limit');
    }
    if (input.channel === 'sms' && !(await this.smsConnected(businessId)).connected) throw new ApiError('sms_not_connected', 'SMS provider not connected');
    const now = new Date();
    const scheduledAt = input.scheduledAt ? localToUtc(input.scheduledAt) : null;
    const scheduled = !!scheduledAt && scheduledAt.getTime() > now.getTime();
    const id = newId('notifyMailing');
    const recipients = await this.audience(targets, input.filter);
    const base = await this.businessVars(businessId);
    const cost = this.cost(input.channel, text, base, recipients);
    await this.prisma.notifyMailing.create({
      data: {
        id,
        businessId,
        channel: input.channel,
        text,
        audienceLabel: input.audienceLabel.slice(0, 400),
        recipientsCount: recipients.length,
        status: scheduled ? 'scheduled' : 'sending',
        network: !!input.network,
        businessIds: J(targets),
        filter: J(input.filter ?? {}),
        scheduledAt: scheduled ? scheduledAt : null,
        costAmd: cost,
        createdBy: staffId ?? null,
      },
    });
    if (!scheduled) await this.deliver(id, recipients);
    const row = await this.prisma.notifyMailing.findUniqueOrThrow({ where: { id } });
    return toOut(row);
  }

  /** Цена SMS-рассылки (Ув13): части персонального текста × 25 ֏ по каждому получателю; пуш — бесплатно */
  private cost(channel: MailingChannel, text: string, base: Record<string, string>, recipients: Recipient[]): number {
    if (channel !== 'sms') return 0;
    return recipients.reduce((sum, r) => sum + Math.max(1, smsParts(this.recipientText(text, base, r))) * SMS_PART_PRICE_AMD, 0);
  }

  /** Отправка строки, уже поставленной в 'sending' (сразу или воркером по расписанию) */
  private async deliver(mailingId: string, recipientsIn?: Recipient[]): Promise<void> {
    const m = await this.prisma.notifyMailing.findUniqueOrThrow({ where: { id: mailingId } });
    const targets = (m.businessIds as string[] | null) ?? [m.businessId];
    const recipients = recipientsIn ?? (await this.audience(targets, (m.filter as AudienceFilter | null) ?? {}));
    const channel = m.channel as MailingChannel;
    const base = await this.businessVars(m.businessId);
    const sms = channel === 'sms' ? await this.smsConnected(m.businessId) : null;
    const sentTo: Recipient[] = [];
    for (const r of recipients) {
      const body = this.recipientText(m.text, base, r);
      if (channel === 'sms') {
        if (!sms?.connected) continue;
        const res = await this.messenger.send({ businessId: m.businessId, to: r.phone, text: body, channel: sms.channel });
        if (res.delivered) sentTo.push(r);
      } else {
        if (!r.appUserId) continue;
        await enqueueClientNotification(this.prisma, { appUserId: r.appUserId, businessId: r.businessId, kind: 'mailing', title: base.companyName || 'BookTime', body, dedupeKey: `mailing:${m.id}:${r.id}` });
        sentTo.push(r);
      }
    }
    const sentAt = m.scheduledAt ?? new Date();
    const cost = this.cost(channel, m.text, base, sentTo);
    await this.prisma.$transaction([
      this.prisma.notifyMailingRecipient.createMany({ skipDuplicates: true, data: sentTo.map((r) => ({ mailingId: m.id, clientId: r.id, businessId: r.businessId, createdAt: sentAt })) }),
      this.prisma.notifyMailing.update({ where: { id: m.id }, data: { status: sentTo.length ? 'sent' : 'failed', recipientsCount: sentTo.length, costAmd: cost, sentAt } }),
    ]);
    if (sentTo.length) {
      await this.log.write(m.businessId, {
        dedupeKey: `ml:${m.id}`,
        sentAt,
        typeCode: m.network ? NETWORK_MAILING_TYPE : undefined,
        typeLabel: m.network ? NETWORK_MAILING_LABEL : MAILING_LABEL,
        channel: channel === 'sms' ? 'sms' : 'push',
        status: 'sent',
        contact: String(sentTo.length),
        text: { ru: m.text },
        costAmd: cost,
        source: 'mailing',
      });
    }
  }

  /** Рассылки по расписанию, чьё время пришло (Ув13): строка забирается атомарно — два прохода не отправят дважды */
  async processDue(businessId?: string): Promise<number> {
    const due = await this.prisma.notifyMailing.findMany({
      where: { status: 'scheduled', scheduledAt: { lte: new Date() }, ...(businessId ? { businessId } : {}) },
      select: { id: true },
      take: 20,
    });
    let sent = 0;
    for (const { id } of due) {
      const claim = await this.prisma.notifyMailing.updateMany({ where: { id, status: 'scheduled' }, data: { status: 'sending' } });
      if (claim.count !== 1) continue;
      await this.deliver(id);
      sent++;
    }
    return sent;
  }

  /** Ув11 «Запланировано»: рассылки по расписанию строками журнала */
  async scheduledLogRows(businessId: string): Promise<LogMessageOut[]> {
    const rows = await this.prisma.notifyMailing.findMany({ where: { businessId, status: 'scheduled', scheduledAt: { gt: new Date() } }, orderBy: { scheduledAt: 'asc' } });
    return rows.map((m) => ({
      id: `lg_sched_${m.id}`,
      businessId,
      createdAt: utcToLocal(m.scheduledAt!),
      typeCode: m.network ? NETWORK_MAILING_TYPE : undefined,
      typeLabel: m.network ? NETWORK_MAILING_LABEL : MAILING_LABEL,
      channel: m.channel === 'sms' ? 'sms' : 'push',
      status: 'sending',
      contact: String(m.recipientsCount),
      text: { ru: m.text },
      costAmd: m.costAmd,
      scheduled: true,
    }));
  }

  /** «Отправить тест себе» (Ув13): на телефон владельца (или бизнеса), переменные — как у клиента */
  async sendTest(businessId: string, channel: MailingChannel, text: string): Promise<{ phone: string }> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { ownerStaffId: true, phone: true } });
    const owner = business?.ownerStaffId ? await this.prisma.staff.findUnique({ where: { id: business.ownerStaffId }, select: { id: true, name: true, phone: true, userId: true } }) : null;
    const phone = owner?.phone || business?.phone || '';
    if (!phone) throw new ApiError('notify/no-test-phone', 'No phone for a test message');
    const base = await this.businessVars(businessId);
    const body = this.recipientText(text, { ...base }, { name: (owner?.name ?? '').split(/\s+/)[0] ?? '' });
    let delivered = false;
    if (channel === 'sms') {
      const sms = await this.smsConnected(businessId);
      if (sms.connected) delivered = (await this.messenger.send({ businessId, to: phone, text: body, channel: sms.channel })).delivered;
    } else if (owner?.userId) {
      delivered = await enqueueOutbox(this.prisma, { businessId, app: 'business', kind: 'mailingTest', recipientUserId: owner.userId, title: base.companyName || 'BookTime', body, dedupeKey: `mailingTest:${newId('notifyLogEntry')}` });
    }
    const parts = channel === 'sms' ? Math.max(1, smsParts(body)) : undefined;
    await this.log.write(businessId, {
      sentAt: new Date(),
      typeLabel: TEST_LABEL,
      channel: channel === 'sms' ? 'sms' : 'push',
      status: delivered ? 'sent' : 'notDelivered',
      contact: phone,
      text: { ru: body },
      costAmd: parts && delivered ? parts * SMS_PART_PRICE_AMD : 0,
      smsParts: parts,
      staffId: owner?.id,
      source: 'test',
    });
    return { phone };
  }
}
