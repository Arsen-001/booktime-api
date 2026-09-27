import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import type { WebhookConfigOut, WebhookDeliveryOut, WebhookEntity } from './integrations.schemas.js';

/**
 * Своё — настоящее (F-13-062…070, docs/backend/02 §17): включатель, 16 сущностей, секрет подписи. Адреса —
 * только чтение (F-13-065 «новый здесь не добавить» — WEBHOOK_NEW_ADDRESS_BLOCKED фронта, экран не предлагает
 * форму, поэтому сервер тоже не даёт API создания адреса, только сеет демо-легаси при `npx prisma db seed`).
 * Доставка — `jobs/webhooks-dispatch.ts`, попадает в очередь из `common/audit/webhook-fanout.ts`.
 */
@Injectable()
export class WebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensure(businessId: string) {
    const existing = await this.prisma.webhook.findUnique({ where: { businessId } });
    if (existing) return existing;
    return this.prisma.webhook.create({ data: { businessId, enabled: false, entities: [], secret: crypto.randomBytes(32).toString('hex') } });
  }

  async getConfig(businessId: string): Promise<WebhookConfigOut> {
    const cfg = await this.ensure(businessId);
    const addresses = await this.prisma.webhookAddress.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    return {
      businessId,
      enabled: cfg.enabled,
      entities: (cfg.entities as WebhookEntity[] | null) ?? [],
      addresses: addresses.map((a) => ({ id: a.id, url: a.url, createdAt: a.createdAt.toISOString(), legacy: a.legacy })),
    };
  }

  async setEnabled(businessId: string, updatedBy: string, enabled: boolean): Promise<WebhookConfigOut> {
    await this.ensure(businessId);
    await this.prisma.webhook.update({ where: { businessId }, data: { enabled, updatedBy } });
    return this.getConfig(businessId);
  }

  async setEntities(businessId: string, updatedBy: string, entities: WebhookEntity[]): Promise<WebhookConfigOut> {
    await this.ensure(businessId);
    await this.prisma.webhook.update({ where: { businessId }, data: { entities, updatedBy } });
    return this.getConfig(businessId);
  }

  /** Только `delivered`/`failed` (F-13-062 журнал) — `pending` не отдаём: у экрана только два состояния значка */
  async listDeliveries(businessId: string): Promise<WebhookDeliveryOut[]> {
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { businessId, status: { in: ['delivered', 'failed'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((d) => ({
      id: d.id,
      businessId: d.businessId,
      entity: d.entity as WebhookEntity,
      action: d.action as WebhookDeliveryOut['action'],
      objectLabel: d.objectLabel,
      address: new URL(d.url).host,
      status: d.status as WebhookDeliveryOut['status'],
      createdAt: d.createdAt.toISOString(),
    }));
  }
}
