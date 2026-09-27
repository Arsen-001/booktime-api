import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { WebhookConfigOut, WebhookDeliveryOut, WebhookEntity } from './integrations.schemas.js';

const VERIFY_TIMEOUT_MS = 3_000;
const RETRY_TIMEOUT_MS = 5_000;

function maskSecret(secret: string): string {
  return `${'•'.repeat(8)}${secret.slice(-4)}`;
}

function newSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

/** И13: причина показа в журнале (`api.webhooks.failReason.*`) — из текста ошибки `lastError` */
function classifyFailReason(lastError: string | null): WebhookDeliveryOut['failReason'] {
  if (!lastError) return undefined;
  if (/timeout|abort/i.test(lastError)) return 'timeout';
  if (/certificate|tls|ssl/i.test(lastError)) return 'tls';
  if (/HTTP 4/.test(lastError)) return 'http4xx';
  return 'http5xx';
}

/**
 * Своё — настоящее (F-13-062…070, docs/backend/02 §17): включатель, 16 сущностей, секрет подписи журнала.
 * Адреса (И13, ревью 27.09 — этап 21): добавление шлёт настоящий проверочный запрос на `url` — 2xx подтверждает
 * адрес и выдаёт секрет подписи (иначе `webhook_unreachable`); секрет целиком отдаётся только на создание/
 * поворот, `getConfig` отдаёт его как есть, маскирует фронт (`maskWebhookConfig`, симметрично `ApiKeysService`).
 * Доставка — `jobs/webhooks-dispatch.ts` на очереди BullMQ, попадает туда из `common/audit/webhook-fanout.ts`;
 * «Повторить» из журнала (retryDelivery) шлёт тот же подписанный POST синхронно, чтобы экран увидел исход сразу.
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
      addresses: addresses.map((a) => ({
        id: a.id,
        url: a.url,
        createdAt: a.createdAt.toISOString(),
        legacy: a.legacy,
        signingSecret: a.signingSecret ?? undefined,
        verifiedAt: a.verifiedAt?.toISOString(),
      })),
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
      failReason: classifyFailReason(d.lastError),
      attempts: d.attempts || undefined,
    }));
  }

  /** И13: адрес не https или без хоста уже отсеян zod (`z.string().url()` живёт во фронте), здесь — сама проверка */
  private async verify(url: string, secret: string): Promise<void> {
    let ok = false;
    try {
      const body = JSON.stringify({ ping: true, at: new Date().toISOString() });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BookTime-Signature': `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`, 'X-BookTime-Event': 'ping' },
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) throw new ApiError('webhook_unreachable', 'Адрес не ответил на проверочный запрос');
  }

  /** И13: добавление шлёт настоящий проверочный POST (см. `verify`) — 2xx подтверждает адрес, иначе 409 */
  async addAddress(businessId: string, url: string): Promise<{ address: WebhookConfigOut['addresses'][number]; secret: string }> {
    await this.ensure(businessId);
    const clean = url.trim();
    if (await this.prisma.webhookAddress.findFirst({ where: { businessId, url: clean } })) {
      throw new ApiError('duplicate', 'Такой адрес уже добавлен');
    }
    const secret = newSecret();
    await this.verify(clean, secret);
    const now = new Date();
    const row = await this.prisma.webhookAddress.create({
      data: { id: newId('webhookAddress'), businessId, url: clean, legacy: false, signingSecret: secret, verifiedAt: now },
    });
    return {
      address: { id: row.id, url: row.url, createdAt: row.createdAt.toISOString(), legacy: row.legacy, signingSecret: maskSecret(secret), verifiedAt: now.toISOString() },
      secret,
    };
  }

  async removeAddress(businessId: string, addressId: string): Promise<void> {
    const row = await this.prisma.webhookAddress.findFirst({ where: { id: addressId, businessId } });
    if (!row) throw new ApiError('not_found', 'Address not found');
    await this.prisma.webhookAddress.delete({ where: { id: addressId } });
  }

  /** Новый секрет подписи: старый перестаёт подходить сразу — следующая доставка подписывает уже новым */
  async rotateSecret(businessId: string, addressId: string): Promise<string> {
    const row = await this.prisma.webhookAddress.findFirst({ where: { id: addressId, businessId } });
    if (!row) throw new ApiError('not_found', 'Address not found');
    const secret = newSecret();
    await this.prisma.webhookAddress.update({ where: { id: addressId }, data: { signingSecret: secret } });
    return secret;
  }

  /**
   * «Повторить» из журнала — тот же подписанный POST, что `jobs/webhooks-dispatch.ts`, но синхронно (одна
   * доставка, не 20 из очереди) чтобы экран увидел исход сразу вместо ожидания следующего тика воркера.
   */
  async retryDelivery(businessId: string, deliveryId: string): Promise<WebhookDeliveryOut> {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, businessId } });
    if (!d) throw new ApiError('not_found', 'Delivery not found');
    const cfg = await this.prisma.webhook.findUnique({ where: { businessId } });
    const secret = cfg?.secret ?? '';
    const body = JSON.stringify(d.payload);
    let ok = false;
    let lastError: string | undefined;
    try {
      const res = await fetch(d.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BookTime-Signature': `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`, 'X-BookTime-Event': d.entity },
        body,
        signal: AbortSignal.timeout(RETRY_TIMEOUT_MS),
      });
      ok = res.ok;
      if (!ok) lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = String((e as Error).message ?? e).slice(0, 300);
    }
    const attempts = d.attempts + 1;
    const updated = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: ok
        ? { status: 'delivered', attempts, deliveredAt: new Date(), lastError: null, nextAttemptAt: null }
        : { status: 'failed', attempts, lastError },
    });
    return {
      id: updated.id,
      businessId: updated.businessId,
      entity: updated.entity as WebhookEntity,
      action: updated.action as WebhookDeliveryOut['action'],
      objectLabel: updated.objectLabel,
      address: new URL(updated.url).host,
      status: updated.status as WebhookDeliveryOut['status'],
      createdAt: updated.createdAt.toISOString(),
      failReason: classifyFailReason(updated.lastError),
      attempts: updated.attempts || undefined,
    };
  }
}
