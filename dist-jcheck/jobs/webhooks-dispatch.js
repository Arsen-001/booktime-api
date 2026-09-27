import crypto from 'node:crypto';
import { logger } from '../common/logging/logger.js';
/**
 * Этап 17 (docs/backend/02 §17): настоящая доставка — HMAC-SHA256 подпись + до 5 попыток с растущим
 * отступом. Строки в очередь кладёт `common/audit/webhook-fanout.ts` (fan-out из AuditService.record).
 * Демо-адрес легаси-бизнеса (сид) ничего не слушает — доставки честно уходят в `failed` по таймауту,
 * это ожидаемо (нет внешней системы, которая бы их приняла), а не баг конвейера.
 */
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const TIMEOUT_MS = 5_000;
function sign(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
export async function webhooksDispatch(prisma) {
    const due = await prisma.webhookDelivery.findMany({
        where: { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
        orderBy: { createdAt: 'asc' },
        take: 20,
    });
    let delivered = 0;
    let failed = 0;
    let retried = 0;
    const secretByBusiness = new Map();
    for (const d of due) {
        let secret = secretByBusiness.get(d.businessId);
        if (!secret) {
            const cfg = await prisma.webhook.findUnique({ where: { businessId: d.businessId } });
            secret = cfg?.secret ?? '';
            secretByBusiness.set(d.businessId, secret);
        }
        const body = JSON.stringify(d.payload);
        const attempts = d.attempts + 1;
        let ok = false;
        let errorText;
        try {
            const res = await fetch(d.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-BookTime-Signature': `sha256=${sign(secret, body)}`, 'X-BookTime-Event': d.entity },
                body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            ok = res.ok;
            if (!ok)
                errorText = `HTTP ${res.status}`;
        }
        catch (e) {
            errorText = String(e.message ?? e).slice(0, 300);
        }
        if (ok) {
            await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'delivered', attempts, deliveredAt: new Date(), lastError: null } });
            delivered += 1;
        }
        else if (attempts >= MAX_ATTEMPTS) {
            await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'failed', attempts, lastError: errorText } });
            failed += 1;
        }
        else {
            const wait = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
            await prisma.webhookDelivery.update({ where: { id: d.id }, data: { attempts, nextAttemptAt: new Date(Date.now() + wait), lastError: errorText } });
            retried += 1;
        }
    }
    if (delivered || failed)
        logger.info({ delivered, failed, retried }, 'webhooks.dispatch');
    return { delivered, failed, retried };
}
//# sourceMappingURL=webhooks-dispatch.js.map