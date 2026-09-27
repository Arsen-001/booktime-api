import { Inject, Injectable } from '@nestjs/common';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';

const AREA = 'notify-sms';
const J = (v: unknown) => v as Prisma.InputJsonValue;

export interface BusinessMessengerSettings {
  connected: boolean;
  channel: 'sms' | 'whatsapp';
  senderName?: string;
  /** Ключ провайдера бизнеса — маскируется в GET (В-08: провайдер и счёт — бизнеса, не наш) */
  apiKey?: string;
}

const DEFAULT_SETTINGS: BusinessMessengerSettings = { connected: false, channel: 'sms' };

/**
 * Своё подключение SMS/WhatsApp бизнеса (В-08: «бизнес подключает СВОЕГО провайдера за свой счёт»). Настоящего
 * провайдера ещё не выбрали (PLAN.md §10 «открыто») — розетка есть (`BusinessMessenger`, этап 1), тут только
 * настройки на бизнес + тестовая отправка через неё; сама отправка остаётся заглушкой, пока провайдер не выбран.
 */
@Injectable()
export class NotifyChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BUSINESS_MESSENGER) private readonly messenger: BusinessMessenger,
  ) {}

  async get(businessId: string): Promise<BusinessMessengerSettings> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
    const data = row?.data as BusinessMessengerSettings | undefined;
    if (!data) return DEFAULT_SETTINGS;
    return { ...data, apiKey: data.apiKey ? '••••••••' : undefined };
  }

  async connect(businessId: string, input: { channel: 'sms' | 'whatsapp'; senderName: string; apiKey: string }): Promise<BusinessMessengerSettings> {
    const settings: BusinessMessengerSettings = { connected: true, channel: input.channel, senderName: input.senderName, apiKey: input.apiKey };
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA } },
      create: { businessId, area: AREA, data: J(settings) },
      update: { data: J(settings), version: { increment: 1 } },
    });
    return this.get(businessId);
  }

  async disconnect(businessId: string): Promise<void> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA } },
      create: { businessId, area: AREA, data: J(DEFAULT_SETTINGS) },
      update: { data: J(DEFAULT_SETTINGS), version: { increment: 1 } },
    });
  }

  async sendTest(businessId: string, to: string): Promise<{ delivered: boolean }> {
    const settings = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
    const data = settings?.data as BusinessMessengerSettings | undefined;
    if (!data?.connected) return { delivered: false };
    return this.messenger.send({ businessId, to, text: 'BookTime: test message from your salon.', channel: data.channel });
  }
}
