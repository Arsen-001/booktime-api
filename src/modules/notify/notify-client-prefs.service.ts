import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';

export interface ClientNotifyChannels {
  push: boolean;
  sms: boolean;
  email: boolean;
}
export interface ClientNotifyPrefsOut {
  marketingOptOut: boolean;
  channels: ClientNotifyChannels;
  /// F-05-090 (этап 21 «notify+integrations»): типы, отключённые клиентом самим (коды экрана, opaque для сервера)
  disabledTypeCodes: number[];
}
export interface ClientNotifyPrefsPatch {
  marketingOptOut?: boolean;
  channels?: Partial<ClientNotifyChannels>;
  disabledTypeCodes?: number[];
}
const J = (v: unknown) => v as Prisma.InputJsonValue;
const DEFAULT_CHANNELS: ClientNotifyChannels = { push: true, sms: true, email: true };
const DEFAULT_PREFS: ClientNotifyPrefsOut = { marketingOptOut: false, channels: DEFAULT_CHANNELS, disabledTypeCodes: [] };

/** Настройки уведомлений на клиента (F-04-087…090) — отказ от маркетинга, каналы, из карточки клиента */
@Injectable()
export class NotifyClientPrefsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(businessId: string, clientId: string): Promise<ClientNotifyPrefsOut> {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId }, select: { id: true } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const row = await this.prisma.clientNotifyPref.findUnique({ where: { clientId } });
    if (!row) return DEFAULT_PREFS;
    return {
      marketingOptOut: row.marketingOptOut,
      channels: { ...DEFAULT_CHANNELS, ...((row.channels as Partial<ClientNotifyChannels>) ?? {}) },
      disabledTypeCodes: Array.isArray(row.disabledTypeCodes) ? (row.disabledTypeCodes as number[]) : [],
    };
  }

  async update(businessId: string, clientId: string, patch: ClientNotifyPrefsPatch): Promise<ClientNotifyPrefsOut> {
    const current = await this.get(businessId, clientId);
    const next: ClientNotifyPrefsOut = {
      marketingOptOut: patch.marketingOptOut ?? current.marketingOptOut,
      channels: { ...current.channels, ...(patch.channels ?? {}) },
      disabledTypeCodes: patch.disabledTypeCodes ?? current.disabledTypeCodes,
    };
    await this.prisma.clientNotifyPref.upsert({
      where: { clientId },
      create: { clientId, marketingOptOut: next.marketingOptOut, channels: J(next.channels), disabledTypeCodes: J(next.disabledTypeCodes) },
      update: { marketingOptOut: next.marketingOptOut, channels: J(next.channels), disabledTypeCodes: J(next.disabledTypeCodes) },
    });
    return next;
  }
}
