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
import { Inject, Injectable } from '@nestjs/common';
import { BUSINESS_MESSENGER } from '../../adapters/adapters.js';
import { PrismaService } from '../../common/prisma.service.js';
const AREA = 'notify-sms';
const J = (v) => v;
const DEFAULT_SETTINGS = { connected: false, channel: 'sms' };
/**
 * Своё подключение SMS/WhatsApp бизнеса (В-08: «бизнес подключает СВОЕГО провайдера за свой счёт»). Настоящего
 * провайдера ещё не выбрали (PLAN.md §10 «открыто») — розетка есть (`BusinessMessenger`, этап 1), тут только
 * настройки на бизнес + тестовая отправка через неё; сама отправка остаётся заглушкой, пока провайдер не выбран.
 */
let NotifyChannelsService = class NotifyChannelsService {
    constructor(prisma, messenger) {
        this.prisma = prisma;
        this.messenger = messenger;
    }
    async get(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
        const data = row?.data;
        if (!data)
            return DEFAULT_SETTINGS;
        return { ...data, apiKey: data.apiKey ? '••••••••' : undefined };
    }
    async connect(businessId, input) {
        const settings = { connected: true, channel: input.channel, senderName: input.senderName, apiKey: input.apiKey };
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: AREA } },
            create: { businessId, area: AREA, data: J(settings) },
            update: { data: J(settings), version: { increment: 1 } },
        });
        return this.get(businessId);
    }
    async disconnect(businessId) {
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: AREA } },
            create: { businessId, area: AREA, data: J(DEFAULT_SETTINGS) },
            update: { data: J(DEFAULT_SETTINGS), version: { increment: 1 } },
        });
    }
    async sendTest(businessId, to) {
        const settings = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
        const data = settings?.data;
        if (!data?.connected)
            return { delivered: false };
        return this.messenger.send({ businessId, to, text: 'BookTime: test message from your salon.', channel: data.channel });
    }
};
NotifyChannelsService = __decorate([
    Injectable(),
    __param(1, Inject(BUSINESS_MESSENGER)),
    __metadata("design:paramtypes", [PrismaService, Object])
], NotifyChannelsService);
export { NotifyChannelsService };
//# sourceMappingURL=notify-channels.service.js.map