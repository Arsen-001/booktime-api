var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, Inject, Injectable, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
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
});
function out(b) {
    return { id: b.id, networkId: b.networkId, channel: b.channel, scope: b.scope, text: b.text, recipients: b.recipients, optedOut: b.optedOut, cost: Number(b.cost), status: b.status, createdAt: b.createdAt.toISOString() };
}
/**
 * Рассылки по сети (F-11-054…061, docs/backend/02 §15): push — реальная очередь notify-outbox (kind='news',
 * та же тихая ночь 21:00–10:00, что и обычные новости), только клиентам с аккаунтом (телефон = users.phone).
 * SMS — через BusinessMessenger ГЛАВНОЙ локации (F-11-056), реального провайдера нет (Р14) — фиксируем факт и
 * списываем NETWORK_SMS_UNIT_PRICE с Network.smsBalance (F-11-057); не хватает — статус insufficientFunds, ничего
 * не уходит и не списывается. Согласие клиента (F-11-058): пропускает получателя, у которого adConsent.given=false
 * хоть в одном филиале сети.
 */
let NetworkBroadcastService = class NetworkBroadcastService {
    constructor(prisma, access, clients, channels, messenger) {
        this.prisma = prisma;
        this.access = access;
        this.clients = clients;
        this.channels = channels;
        this.messenger = messenger;
    }
    async smsStatus(ctx, networkId) {
        const { network } = await this.access.require(ctx, networkId, 'clients');
        const mainBusinessId = network.mainBusinessId ?? network.businessIds[0];
        if (!mainBusinessId)
            return { connected: false, mainBusinessName: '', balance: Number(network.smsBalance) };
        const [settings, business] = await Promise.all([this.channels.get(mainBusinessId), this.prisma.business.findUnique({ where: { id: mainBusinessId }, select: { name: true } })]);
        return { connected: settings.connected, mainBusinessName: business?.name ?? '', balance: Number(network.smsBalance) };
    }
    async log(ctx, networkId) {
        await this.access.require(ctx, networkId, 'clients');
        const rows = await this.prisma.networkBroadcast.findMany({ where: { networkId }, orderBy: { createdAt: 'desc' }, take: 100 });
        return rows.map(out);
    }
    async send(ctx, networkId, input) {
        const { network } = await this.access.require(ctx, networkId, 'clients');
        const scopeBusinessIds = input.businessIds?.length ? network.businessIds.filter((id) => input.businessIds.includes(id)) : network.businessIds;
        let groups = await this.clientsGroupsFor(scopeBusinessIds);
        if (input.scope === 'selected' && input.clientKeys?.length) {
            const wanted = new Set(input.clientKeys.map((k) => k.clientId));
            groups = groups.filter((g) => g.clientIds.some((id) => wanted.has(id)));
        }
        else if (input.search?.trim()) {
            const q = input.search.trim().toLowerCase();
            const qDigits = q.replace(/\D/g, '');
            groups = groups.filter((g) => g.name.toLowerCase().includes(q) || (qDigits && g.phone.replace(/\D/g, '').includes(qDigits)));
        }
        const allClientIds = groups.flatMap((g) => g.clientIds);
        const consentRows = allClientIds.length ? await this.prisma.client.findMany({ where: { id: { in: allClientIds } }, select: { id: true, adConsent: true } }) : [];
        const optedOutIds = new Set(consentRows.filter((c) => c.adConsent?.given === false).map((c) => c.id));
        const eligible = groups.filter((g) => !g.clientIds.some((id) => optedOutIds.has(id)));
        const optedOut = groups.length - eligible.length;
        const id = newId('networkBroadcast');
        const recipients = eligible.length;
        if (input.channel === 'sms') {
            const cost = BigInt(recipients) * BigInt(NETWORK_SMS_UNIT_PRICE);
            if (network.smsBalance < cost) {
                const row = await this.prisma.networkBroadcast.create({ data: { id, networkId, channel: 'sms', scope: input.scope, text: input.text, recipients, optedOut, cost, status: 'insufficientFunds', createdBy: ctx.session.userId } });
                return out(row);
            }
            const mainBusinessId = network.mainBusinessId ?? network.businessIds[0];
            const settings = await this.channels.get(mainBusinessId);
            await Promise.all(eligible.map((g) => this.messenger.send({ businessId: mainBusinessId, to: g.phone, text: input.text, channel: settings.channel === 'whatsapp' ? 'whatsapp' : 'sms' })));
            const [row] = await this.prisma.$transaction([
                this.prisma.networkBroadcast.create({ data: { id, networkId, channel: 'sms', scope: input.scope, text: input.text, recipients, optedOut, cost, status: 'sent', createdBy: ctx.session.userId } }),
                this.prisma.network.update({ where: { id: networkId }, data: { smsBalance: { decrement: cost } } }),
            ]);
            return out(row);
        }
        // push: только клиентам с аккаунтом приложения (телефон = users.phone), реальная очередь notify-outbox
        const phones = eligible.map((g) => g.phone);
        const users = phones.length ? await this.prisma.user.findMany({ where: { phone: { in: phones }, deletedAt: null, blockedAt: null }, select: { id: true, phone: true, locale: true } }) : [];
        const byPhone = new Map(users.map((u) => [u.phone, u]));
        await Promise.all(eligible.flatMap((g) => {
            const user = g.phone ? byPhone.get(g.phone) : undefined;
            if (!user)
                return [];
            return [enqueueClientNotification(this.prisma, { businessId: g.memberLocationIds[0], kind: 'news', appUserId: user.id, title: 'BookTime', body: input.text, dedupeKey: `netbc:${id}:${user.id}` })];
        }));
        const row = await this.prisma.networkBroadcast.create({ data: { id, networkId, channel: 'push', scope: input.scope, text: input.text, recipients, optedOut, cost: 0n, status: 'sent', createdBy: ctx.session.userId } });
        return out(row);
    }
    async clientsGroupsFor(businessIds) {
        // легче полного NetworkClientRow (без spend/visits — рассылке нужны только телефон/имя/участие)
        if (!businessIds.length)
            return [];
        const clients = await this.prisma.client.findMany({ where: { businessId: { in: businessIds }, deletedAt: null }, select: { id: true, businessId: true, phone: true, name: true } });
        const byPhone = new Map();
        for (const c of clients) {
            const g = byPhone.get(c.phone);
            if (!g)
                byPhone.set(c.phone, { phone: c.phone, name: c.name, memberLocationIds: [c.businessId], clientIds: [c.id] });
            else {
                g.memberLocationIds.push(c.businessId);
                g.clientIds.push(c.id);
            }
        }
        return [...byPhone.values()];
    }
};
NetworkBroadcastService = __decorate([
    Injectable(),
    __param(4, Inject(BUSINESS_MESSENGER)),
    __metadata("design:paramtypes", [PrismaService,
        NetworkAccessService,
        NetworkClientsService,
        NotifyChannelsService, Object])
], NetworkBroadcastService);
export { NetworkBroadcastService };
let NetworkBroadcastController = class NetworkBroadcastController {
    constructor(svc) {
        this.svc = svc;
    }
    smsStatus(ctx, n) {
        return this.svc.smsStatus(ctx, n);
    }
    log(ctx, n) {
        return this.svc.log(ctx, n);
    }
    send(ctx, n, body) {
        return this.svc.send(ctx, n, body);
    }
};
__decorate([
    Get('sms-status'),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkBroadcastController.prototype, "smsStatus", null);
__decorate([
    Get('broadcasts'),
    ZodOk(z.array(broadcastOut)),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], NetworkBroadcastController.prototype, "log", null);
__decorate([
    Post('broadcasts'),
    ApiOperation({ summary: 'SMS/Push рассылка по базе сети (F-11-054…061)' }),
    ZodBody(broadcastBody),
    ZodOk(broadcastOut),
    __param(0, Ctx()),
    __param(1, Param('networkId')),
    __param(2, Body(new Zod(broadcastBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], NetworkBroadcastController.prototype, "send", null);
NetworkBroadcastController = __decorate([
    ApiTags('network'),
    Controller('v1/net/:networkId'),
    Authed(),
    __metadata("design:paramtypes", [NetworkBroadcastService])
], NetworkBroadcastController);
export { NetworkBroadcastController };
//# sourceMappingURL=network-broadcast.controller.js.map