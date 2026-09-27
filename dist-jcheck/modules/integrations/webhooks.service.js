var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
/**
 * Своё — настоящее (F-13-062…070, docs/backend/02 §17): включатель, 16 сущностей, секрет подписи. Адреса —
 * только чтение (F-13-065 «новый здесь не добавить» — WEBHOOK_NEW_ADDRESS_BLOCKED фронта, экран не предлагает
 * форму, поэтому сервер тоже не даёт API создания адреса, только сеет демо-легаси при `npx prisma db seed`).
 * Доставка — `jobs/webhooks-dispatch.ts`, попадает в очередь из `common/audit/webhook-fanout.ts`.
 */
let WebhooksService = class WebhooksService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async ensure(businessId) {
        const existing = await this.prisma.webhook.findUnique({ where: { businessId } });
        if (existing)
            return existing;
        return this.prisma.webhook.create({ data: { businessId, enabled: false, entities: [], secret: crypto.randomBytes(32).toString('hex') } });
    }
    async getConfig(businessId) {
        const cfg = await this.ensure(businessId);
        const addresses = await this.prisma.webhookAddress.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
        return {
            businessId,
            enabled: cfg.enabled,
            entities: cfg.entities ?? [],
            addresses: addresses.map((a) => ({ id: a.id, url: a.url, createdAt: a.createdAt.toISOString(), legacy: a.legacy })),
        };
    }
    async setEnabled(businessId, updatedBy, enabled) {
        await this.ensure(businessId);
        await this.prisma.webhook.update({ where: { businessId }, data: { enabled, updatedBy } });
        return this.getConfig(businessId);
    }
    async setEntities(businessId, updatedBy, entities) {
        await this.ensure(businessId);
        await this.prisma.webhook.update({ where: { businessId }, data: { entities, updatedBy } });
        return this.getConfig(businessId);
    }
    /** Только `delivered`/`failed` (F-13-062 журнал) — `pending` не отдаём: у экрана только два состояния значка */
    async listDeliveries(businessId) {
        const rows = await this.prisma.webhookDelivery.findMany({
            where: { businessId, status: { in: ['delivered', 'failed'] } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        return rows.map((d) => ({
            id: d.id,
            businessId: d.businessId,
            entity: d.entity,
            action: d.action,
            objectLabel: d.objectLabel,
            address: new URL(d.url).host,
            status: d.status,
            createdAt: d.createdAt.toISOString(),
        }));
    }
};
WebhooksService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], WebhooksService);
export { WebhooksService };
//# sourceMappingURL=webhooks.service.js.map