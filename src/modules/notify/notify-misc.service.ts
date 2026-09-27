import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NotifyChannelsService } from './notify-channels.service.js';

const J = (v: unknown) => v as Prisma.InputJsonValue;

const AREA_WEB_POPUP = 'notify-web-popup';
const AREA_EMAIL = 'notify-email';
const AREA_BANNERS = 'notify-service-banners';
const AREA_CHANNEL_FLAGS = 'notify-channel-flags';

export interface WebPopupSettingsOut {
  bookingOps: boolean;
  incomingCalls: boolean;
}
const DEFAULT_WEB_POPUP: WebPopupSettingsOut = { bookingOps: true, incomingCalls: false };

export interface EmailChannelSettingsOut {
  replyEmail: string;
}
const DEFAULT_EMAIL: EmailChannelSettingsOut = { replyEmail: '' };

export interface ServiceBannerOut {
  id: string;
  tone: 'promo' | 'warning' | 'danger';
  title: { ru: string; en?: string };
  text: { ru: string; en?: string };
  actionLabel?: { ru: string; en?: string };
  actionHref?: string;
  dismissible: boolean;
  deadline?: string;
}

export type ChannelKind = 'push' | 'adminApp' | 'email' | 'sms' | 'brandedApp' | 'whatsapp' | 'telegram';
export interface ChannelConnectionOut {
  channel: ChannelKind;
  connected: boolean;
}

/**
 * Этап 21 «notify+integrations»: мелкие, реально «свои» настройки раздела notify, которых не было на сервере —
 * попапы в веб-версии (F-05-058), Email «для ответов» (F-05-066), служебные баннеры (F-05-135) и общий обзор
 * каналов (F-05-065), собранный из уже существующих кусочков (свой SMS/WhatsApp — NotifyChannelsService, push
 * и adminApp — всегда включены, это наша собственная инфраструктура, а не «розетка» стороннего провайдера).
 * Каждая настройка — своя область BusinessSetting (тот же приём, что notify-types/notify-sms), без общей схемы.
 */
@Injectable()
export class NotifyMiscService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NotifyChannelsService) private readonly messenger: NotifyChannelsService,
  ) {}

  async getWebPopup(businessId: string): Promise<WebPopupSettingsOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_WEB_POPUP } } });
    return { ...DEFAULT_WEB_POPUP, ...((row?.data as Partial<WebPopupSettingsOut>) ?? {}) };
  }

  async setWebPopup(businessId: string, settings: WebPopupSettingsOut): Promise<WebPopupSettingsOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_WEB_POPUP } },
      create: { businessId, area: AREA_WEB_POPUP, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  async getEmailSettings(businessId: string): Promise<EmailChannelSettingsOut> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_EMAIL } } });
    return { ...DEFAULT_EMAIL, ...((row?.data as Partial<EmailChannelSettingsOut>) ?? {}) };
  }

  async setEmailSettings(businessId: string, settings: EmailChannelSettingsOut): Promise<EmailChannelSettingsOut> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_EMAIL } },
      create: { businessId, area: AREA_EMAIL, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return settings;
  }

  /** F-05-135: одно правило, посчитанное на лету (7 дней со дня регистрации — HELLO30), «закрыт» — по списку в BusinessSetting */
  async listBanners(businessId: string): Promise<ServiceBannerOut[]> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { createdAt: true } });
    const out: ServiceBannerOut[] = [];
    if (business) {
      const deadline = new Date(business.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (Date.now() < deadline.getTime()) {
        out.push({
          id: 'promo_hello30',
          tone: 'promo',
          title: { ru: 'Скидка 30% для новых клиентов', en: '30% off for new businesses' },
          text: { ru: 'Промокод HELLO30 — оплатите подписку в течение 7 дней с регистрации.', en: 'Promo code HELLO30 — pay for your subscription within 7 days of signing up.' },
          actionLabel: { ru: 'Оплатить сейчас', en: 'Pay now' },
          actionHref: '/biz/billing',
          dismissible: true,
          deadline: deadline.toISOString(),
        });
      }
    }
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_BANNERS } } });
    const dismissed = new Set<string>(((row?.data as { dismissed?: string[] } | undefined)?.dismissed as string[] | undefined) ?? []);
    return out.filter((b) => !b.dismissible || !dismissed.has(b.id));
  }

  async dismissBanner(businessId: string, bannerId: string): Promise<void> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_BANNERS } } });
    const dismissed = new Set<string>(((row?.data as { dismissed?: string[] } | undefined)?.dismissed as string[] | undefined) ?? []);
    dismissed.add(bannerId);
    const data = { dismissed: Array.from(dismissed) };
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_BANNERS } },
      create: { businessId, area: AREA_BANNERS, data: J(data) },
      update: { data: J(data), version: { increment: 1 } },
    });
  }

  private async brandedFlag(businessId: string): Promise<boolean> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_CHANNEL_FLAGS } } });
    return Boolean((row?.data as { brandedApp?: boolean } | undefined)?.brandedApp);
  }

  /**
   * F-05-065: обзор каналов. push/adminApp/email — наша собственная инфраструктура, всегда «подключены»
   * (Web Push/FCM и наша админ-панель работают без стороннего провайдера, docs/backend/05); sms — своё
   * подключение бизнеса (В-08, NotifyChannelsService); brandedApp — только заявка «хочу» (В-29), без
   * реальной услуги. whatsapp/telegram сюда не попадают (F-00-032 — телеграм тут служебный, не бизнес-канал).
   */
  async listChannels(businessId: string): Promise<ChannelConnectionOut[]> {
    const [sms, branded] = await Promise.all([this.messenger.get(businessId), this.brandedFlag(businessId)]);
    return [
      { channel: 'push', connected: true },
      { channel: 'adminApp', connected: true },
      { channel: 'email', connected: true },
      { channel: 'sms', connected: sms.connected && sms.channel === 'sms' },
      { channel: 'brandedApp', connected: branded },
    ];
  }

  /** Единственный настоящий переключатель здесь — brandedApp (заявка В-29); остальные каналы имеют свой поток */
  async setChannelFlag(businessId: string, channel: ChannelKind, connected: boolean): Promise<{ channel: ChannelKind; connected: boolean }> {
    if (channel !== 'brandedApp') return { channel, connected: (await this.listChannels(businessId)).find((c) => c.channel === channel)?.connected ?? false };
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA_CHANNEL_FLAGS } } });
    const data = { ...((row?.data as Record<string, boolean> | undefined) ?? {}), brandedApp: connected };
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA_CHANNEL_FLAGS } },
      create: { businessId, area: AREA_CHANNEL_FLAGS, data: J(data) },
      update: { data: J(data), version: { increment: 1 } },
    });
    return { channel, connected };
  }
}
