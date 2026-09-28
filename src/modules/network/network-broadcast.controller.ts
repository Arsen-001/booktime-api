import { Body, Controller, Get, Inject, Injectable, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import type { BusinessMessenger } from '../../adapters/business-sms/business-sms.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { utcToLocal } from '../../common/time/time.js';
import { NotifyChannelsService } from '../notify/notify-channels.service.js';
import { enqueueClientNotification } from '../notify/outbox.js';
import { NetworkAccessService } from './network-access.service.js';
import { NetworkClientsService } from './network-clients.controller.js';
import { broadcastBody } from './network.schemas.js';

/** F-11-057: тариф SMS сетевой рассылки, драм за получателя; push — 0 (бесплатно) */
export const NETWORK_SMS_UNIT_PRICE = 30;

const broadcastOut = z.object({
  id: z.string(),
  networkId: z.string(),
  channel: z.enum(['sms', 'push']),
  scope: z.enum(['selected', 'found']),
  text: z.string(),
  recipients: z.number(),
  optedOut: z.number(),
  cost: z.number(),
  status: z.enum(['sent', 'insufficientFunds']),
  createdAt: z.string(),
  /** Местное время «YYYY-MM-DDTHH:mm» — поле `at` журнала фронта (этап 21, сдача) */
  at: z.string(),
});

function out(b: { id: string; networkId: string; channel: string; scope: string; text: string; recipients: number; optedOut: number; cost: bigint; status: string; createdAt: Date }) {
  return { id: b.id, networkId: b.networkId, channel: b.channel as 'sms' | 'push', scope: b.scope as 'selected' | 'found', text: b.text, recipients: b.recipients, optedOut: b.optedOut, cost: Number(b.cost), status: b.status as 'sent' | 'insufficientFunds', createdAt: b.createdAt.toISOString(), at: utcToLocal(b.createdAt) };
}

/**
 * Рассылки по сети (F-11-054…061, docs/backend/02 §15): push — реальная очередь notify-outbox (kind='news',
 * та же тихая ночь 21:00–10:00, что и обычные новости), только клиентам с аккаунтом (телефон = users.phone).
 * SMS — через BusinessMessenger ГЛАВНОЙ локации (F-11-056), реального провайдера нет (Р14) — фиксируем факт и
 * списываем NETWORK_SMS_UNIT_PRICE с Network.smsBalance (F-11-057); не хватает — статус insufficientFunds, ничего
 * не уходит и не списывается. Согласие клиента (F-11-058): пропускает получателя, у которого adConsent.given=false
 * хоть в одном филиале сети.
 */
@Injectable()
export class NetworkBroadcastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NetworkAccessService,
    private readonly clients: NetworkClientsService,
    private readonly channels: NotifyChannelsService,
    @Inject(BUSINESS_MESSENGER) private readonly messenger: BusinessMessenger,
  ) {}

  async smsStatus(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    const mainBusinessId = network.mainBusinessId ?? network.businessIds[0];
    if (!mainBusinessId) return { connected: false, mainBusinessName: '', balance: Number(network.smsBalance) };
    const [settings, business] = await Promise.all([this.channels.get(mainBusinessId), this.prisma.business.findUnique({ where: { id: mainBusinessId }, select: { name: true } })]);
    return { connected: settings.connected, mainBusinessName: business?.name ?? '', balance: Number(network.smsBalance) };
  }

  async log(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'clients');
    const rows = await this.prisma.networkBroadcast.findMany({ where: { networkId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(out);
  }

  async send(ctx: RequestContext, networkId: string, input: z.infer<typeof broadcastBody>) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    const scopeBusinessIds = input.businessIds?.length ? network.businessIds.filter((id) => input.businessIds!.includes(id)) : network.businessIds;
    let groups = await this.clientsGroupsFor(scopeBusinessIds);
    if (input.phones?.length) {
      // Экран сети шлёт уже склеенные телефоны (F-11-041: один человек = один телефон) — этап 21, сдача
      const wanted = new Set(input.phones);
      groups = groups.filter((g) => wanted.has(g.phone));
    } else if (input.scope === 'selected' && input.clientKeys?.length) {
      const wanted = new Set(input.clientKeys.map((k) => k.clientId));
      groups = groups.filter((g) => g.clientIds.some((id) => wanted.has(id)));
    } else if (input.search?.trim()) {
      const q = input.search.trim().toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      groups = groups.filter((g) => g.name.toLowerCase().includes(q) || (qDigits && g.phone.replace(/\D/g, '').includes(qDigits)));
    }
    const allClientIds = groups.flatMap((g) => g.clientIds);
    const consentRows = allClientIds.length ? await this.prisma.client.findMany({ where: { id: { in: allClientIds } }, select: { id: true, adConsent: true } }) : [];
    const optedOutIds = new Set(consentRows.filter((c) => (c.adConsent as { given?: boolean } | null)?.given === false).map((c) => c.id));
    const eligible = groups.filter((g) => !g.clientIds.some((id) => optedOutIds.has(id)));
    const optedOut = groups.length - eligible.length;
    const id = newId('networkBroadcast');
    const recipients = eligible.length;

    if (input.channel === 'sms') {
      // F-11-056: без подключённого SMS-провайдера главной локации рассылка не уходит (как мок)
      const mainForCheck = network.mainBusinessId ?? network.businessIds[0];
      if (!mainForCheck || !(await this.channels.get(mainForCheck)).connected) throw new ApiError('validation', 'sms_not_connected');
      const cost = BigInt(recipients) * BigInt(NETWORK_SMS_UNIT_PRICE);
      if (network.smsBalance < cost) {
        const row = await this.prisma.networkBroadcast.create({ data: { id, networkId, channel: 'sms', scope: input.scope, text: input.text, recipients, optedOut, cost, status: 'insufficientFunds', createdBy: ctx.session!.userId } });
        return out(row);
      }
      const mainBusinessId = network.mainBusinessId ?? network.businessIds[0]!;
      const settings = await this.channels.get(mainBusinessId);
      await Promise.all(eligible.map((g) => this.messenger.send({ businessId: mainBusinessId, to: g.phone, text: input.text, channel: settings.channel === 'whatsapp' ? 'whatsapp' : 'sms' })));
      const [row] = await this.prisma.$transaction([
        this.prisma.networkBroadcast.create({ data: { id, networkId, channel: 'sms', scope: input.scope, text: input.text, recipients, optedOut, cost, status: 'sent', createdBy: ctx.session!.userId } }),
        this.prisma.network.update({ where: { id: networkId }, data: { smsBalance: { decrement: cost } } }),
      ]);
      return out(row);
    }

    // push: только клиентам с аккаунтом приложения (телефон = users.phone), реальная очередь notify-outbox
    const phones = eligible.map((g) => g.phone);
    const users = phones.length ? await this.prisma.user.findMany({ where: { phone: { in: phones }, deletedAt: null, blockedAt: null }, select: { id: true, phone: true, locale: true } }) : [];
    const byPhone = new Map(users.map((u) => [u.phone, u]));
    await Promise.all(
      eligible.flatMap((g) => {
        const user = g.phone ? byPhone.get(g.phone) : undefined;
        if (!user) return [];
        return [enqueueClientNotification(this.prisma, { businessId: g.memberLocationIds[0]!, kind: 'news', appUserId: user.id, title: 'BookTime', body: input.text, dedupeKey: `netbc:${id}:${user.id}` })];
      }),
    );
    const row = await this.prisma.networkBroadcast.create({ data: { id, networkId, channel: 'push', scope: input.scope, text: input.text, recipients, optedOut, cost: 0n, status: 'sent', createdBy: ctx.session!.userId } });
    return out(row);
  }

  /**
   * F-11-058 (этап 21, лейн network): «Не отправлять» — список телефонов, у которых `adConsent.given === false`
   * хоть в одном филиале сети. Мок держал свой глобальный по номеру массив (`marketingOptOut`, «сеть не
   * разделяет его») — сервер уже несёт то же самое полем `Client.adConsent`, используемым `send()` выше; вторую
   * копию не завожу, читаю то же поле.
   */
  async listMarketingOptOut(ctx: RequestContext, networkId: string): Promise<string[]> {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    if (!network.businessIds.length) return [];
    const rows = await this.prisma.client.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null }, select: { phone: true, adConsent: true } });
    const optOut = new Set(rows.filter((c) => (c.adConsent as { given?: boolean } | null)?.given === false).map((c) => c.phone));
    return [...optOut];
  }

  private async clientsGroupsFor(businessIds: string[]) {
    // легче полного NetworkClientRow (без spend/visits — рассылке нужны только телефон/имя/участие)
    if (!businessIds.length) return [];
    const clients = await this.prisma.client.findMany({ where: { businessId: { in: businessIds }, deletedAt: null }, select: { id: true, businessId: true, phone: true, name: true } });
    const byPhone = new Map<string, { phone: string; name: string; memberLocationIds: string[]; clientIds: string[] }>();
    for (const c of clients) {
      const g = byPhone.get(c.phone);
      if (!g) byPhone.set(c.phone, { phone: c.phone, name: c.name, memberLocationIds: [c.businessId], clientIds: [c.id] });
      else {
        g.memberLocationIds.push(c.businessId);
        g.clientIds.push(c.id);
      }
    }
    return [...byPhone.values()];
  }
}

@ApiTags('network')
@Controller('v1/net/:networkId')
@Authed()
export class NetworkBroadcastController {
  constructor(private readonly svc: NetworkBroadcastService) {}

  @Get('sms-status')
  smsStatus(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.smsStatus(ctx, n);
  }

  @Get('marketing-opt-out')
  @ApiOperation({ summary: 'Телефоны клиентов сети, отказавшихся от рекламы (F-11-058)' })
  marketingOptOut(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.listMarketingOptOut(ctx, n);
  }

  @Get('broadcasts')
  @ZodOk(z.array(broadcastOut))
  log(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.log(ctx, n);
  }

  @Post('broadcasts')
  @ApiOperation({ summary: 'SMS/Push рассылка по базе сети (F-11-054…061)' })
  @ZodBody(broadcastBody)
  @ZodOk(broadcastOut)
  send(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(broadcastBody)) body: z.infer<typeof broadcastBody>) {
    return this.svc.send(ctx, n, body);
  }
}
