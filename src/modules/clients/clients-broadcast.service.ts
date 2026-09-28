import { Inject, Injectable } from '@nestjs/common';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { localDayRangeUtc, utcToLocal } from '../../common/time/time.js';
import { enqueueClientNotification } from '../notify/outbox.js';

const SMS_AREA = 'notify-sms';
/** ⭐ F-00-114 / F-05-095: тот же лимит, что src/api/notify.ts::WEEKLY_PUSH_LIMIT — здесь считается только
 * по своим строкам (clientBroadcastMessage), не по Mailing (тот раздел ещё на моке, этап 21 «notify+integrations»
 * его не закрыл) — см. docs/PROGRESS.md, этап 21, лейн rest, попытка 2. */
const WEEKLY_PUSH_LIMIT = 3;

export interface BroadcastMessageOut {
  id: string;
  businessId: string;
  channel: 'sms' | 'push' | 'whatsapp';
  text: string;
  audienceCount: number;
  sentAt: string;
  clientId?: string;
  source?: 'bulk' | 'bookingWindow';
}

/**
 * Массовые рассылки CRM (F-04-038…040) и разовое сообщение из окна записи (F-04-100) — этап 21, лейн rest,
 * попытка 2. Раньше (этап 5, см. docstring `clients.server.ts`) осознанно оставлены на моке «ждут bookings/
 * лояльность/очередь уведомлений» — все три уже готовы (этапы 7/11/10), решение устарело, закрываю здесь.
 * SMS — через уже готовый `BusinessMessenger` (В-08, тот же адаптер, что `NotifyChannelsService`, не завишу
 * от модуля notify — избегаю пересечения с лейном notify+integrations, который правит его параллельно).
 * Пуш — через уже готовую очередь `notify_outbox` (`enqueueClientNotification`, этап 10).
 */
@Injectable()
export class ClientsBroadcastService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BUSINESS_MESSENGER) private readonly messenger: BusinessMessenger,
  ) {}

  /** F-04-227: кому реально уйдёт рассылка — без явного отказа от рекламы (adConsent.given !== false) */
  async audience(businessId: string, clientIds: string[]): Promise<{ sms: string[]; push: string[] }> {
    if (clientIds.length === 0) return { sms: [], push: [] };
    const clients = await this.prisma.client.findMany({
      where: { id: { in: clientIds }, businessId, deletedAt: null },
      select: { id: true, appUserId: true, adConsent: true },
    });
    const opted = clients.filter((c) => (c.adConsent as { given?: boolean } | null)?.given !== false);
    return { sms: opted.map((c) => c.id), push: opted.filter((c) => c.appUserId).map((c) => c.id) };
  }

  /** F-04-038, В-08 б: без подключённого SMS-провайдера рассылка не уходит молча — явная ошибка на экран */
  async sendMessage(businessId: string, clientIds: string[], text: string): Promise<number> {
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError('empty_text', 'Text is empty');
    const setting = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: SMS_AREA } } });
    const data = setting?.data as { connected?: boolean; channel?: 'sms' | 'whatsapp' } | undefined;
    if (!data?.connected) throw new ApiError('sms_not_connected', 'SMS provider not connected');
    const { sms: targets } = await this.audience(businessId, clientIds);
    const rows = await this.prisma.client.findMany({ where: { id: { in: targets } }, select: { id: true, phone: true } });
    for (const c of rows) {
      await this.messenger.send({ businessId, to: c.phone, text: trimmed, channel: data.channel ?? 'sms' });
    }
    await this.log(businessId, 'sms', trimmed, targets.length);
    return targets.length;
  }

  /** F-04-039/040, «Снято» №3: пуш только клиентам с приложением; общий недельный лимит на бизнес */
  async sendPush(businessId: string, clientIds: string[], text: string): Promise<number> {
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError('empty_text', 'Text is empty');
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sentThisWeek = await this.prisma.clientBroadcastMessage.count({ where: { businessId, channel: 'push', sentAt: { gte: weekAgo } } });
    if (sentThisWeek >= WEEKLY_PUSH_LIMIT) throw new ApiError('weekly_push_limit', 'Weekly push limit reached');
    const { push: targets } = await this.audience(businessId, clientIds);
    const rows = await this.prisma.client.findMany({ where: { id: { in: targets } }, select: { id: true, appUserId: true } });
    for (const c of rows) {
      if (!c.appUserId) continue;
      await enqueueClientNotification(this.prisma, {
        appUserId: c.appUserId,
        businessId,
        kind: 'clientBroadcast',
        title: 'BookTime',
        body: trimmed,
        dedupeKey: `clientBroadcast:${businessId}:${c.id}:${Date.now()}`,
      });
    }
    await this.log(businessId, 'push', trimmed, targets.length);
    return targets.length;
  }

  /**
   * F-04-100: разовое сообщение клиенту из окна записи. По решению (F-00-120/121) платных SMS клиенту нет —
   * пуш, если есть приложение, иначе WhatsApp самого мастера (deep-link открывает браузер клиента, от сервера
   * ничего не уходит — здесь только запись в журнал сообщений).
   */
  async sendBookingWindowMessage(businessId: string, clientId: string, text: string, channel: 'push' | 'whatsapp'): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError('empty_text', 'Text is empty');
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    if (channel === 'push') {
      if (!client.appUserId) throw new ApiError('no_app_user', 'Client has no app');
      await enqueueClientNotification(this.prisma, {
        appUserId: client.appUserId,
        businessId,
        kind: 'clientBroadcast',
        title: 'BookTime',
        body: trimmed,
        dedupeKey: `bookingWindowMsg:${newId('clientBroadcastMessage')}`,
      });
    }
    await this.log(businessId, channel, trimmed, 1, clientId, 'bookingWindow');
  }

  /** F-04-038 «Готово, когда»: отправленное видно в отчёте сообщений бизнеса */
  async listLog(businessId: string, from: string, to: string): Promise<BroadcastMessageOut[]> {
    const rows = await this.prisma.clientBroadcastMessage.findMany({
      where: { businessId, sentAt: { gte: localDayRangeUtc(from).from, lt: localDayRangeUtc(to).to } },
      orderBy: { sentAt: 'desc' },
    });
    return rows.map(toOut);
  }

  /** F-04-100: сообщение из окна записи видно в истории сообщений клиента */
  async listClientLog(clientId: string): Promise<BroadcastMessageOut[]> {
    const rows = await this.prisma.clientBroadcastMessage.findMany({ where: { clientId }, orderBy: { sentAt: 'desc' } });
    return rows.map(toOut);
  }

  /** То же, но клиент обязан принадлежать бизнесу из пути (маршрут кабинета) */
  async listClientLogFor(businessId: string, clientId: string): Promise<BroadcastMessageOut[]> {
    const rows = await this.prisma.clientBroadcastMessage.findMany({ where: { clientId, businessId }, orderBy: { sentAt: 'desc' } });
    return rows.map(toOut);
  }

  private async log(businessId: string, channel: string, text: string, audienceCount: number, clientId?: string, source: 'bulk' | 'bookingWindow' = 'bulk'): Promise<void> {
    await this.prisma.clientBroadcastMessage.create({
      data: { id: newId('clientBroadcastMessage'), businessId, channel, text, audienceCount, clientId, source },
    });
  }
}

function toOut(r: { id: string; businessId: string; channel: string; text: string; audienceCount: number; clientId: string | null; source: string; sentAt: Date }): BroadcastMessageOut {
  return {
    id: r.id,
    businessId: r.businessId,
    channel: r.channel as BroadcastMessageOut['channel'],
    text: r.text,
    audienceCount: r.audienceCount,
    // Местное время бизнеса «YYYY-MM-DDTHH:mm», как ISODateTime фронта (экран режет [0,10] под день)
    sentAt: utcToLocal(r.sentAt),
    clientId: r.clientId ?? undefined,
    source: r.source as BroadcastMessageOut['source'],
  };
}
