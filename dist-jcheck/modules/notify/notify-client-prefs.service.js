var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
const J = (v) => v;
const DEFAULT_CHANNELS = { push: true, sms: true, email: true };
const DEFAULT_PREFS = { marketingOptOut: false, channels: DEFAULT_CHANNELS };
/** Настройки уведомлений на клиента (F-04-087…090) — отказ от маркетинга, каналы, из карточки клиента */
let NotifyClientPrefsService = class NotifyClientPrefsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async get(businessId, clientId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId }, select: { id: true } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        const row = await this.prisma.clientNotifyPref.findUnique({ where: { clientId } });
        if (!row)
            return DEFAULT_PREFS;
        return { marketingOptOut: row.marketingOptOut, channels: { ...DEFAULT_CHANNELS, ...(row.channels ?? {}) } };
    }
    async update(businessId, clientId, patch) {
        const current = await this.get(businessId, clientId);
        const next = {
            marketingOptOut: patch.marketingOptOut ?? current.marketingOptOut,
            channels: { ...current.channels, ...(patch.channels ?? {}) },
        };
        await this.prisma.clientNotifyPref.upsert({
            where: { clientId },
            create: { clientId, marketingOptOut: next.marketingOptOut, channels: J(next.channels) },
            update: { marketingOptOut: next.marketingOptOut, channels: J(next.channels) },
        });
        return next;
    }
};
NotifyClientPrefsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], NotifyClientPrefsService);
export { NotifyClientPrefsService };
//# sourceMappingURL=notify-client-prefs.service.js.map