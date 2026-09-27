import { newId } from '../ids/ids.js';
/**
 * Этап 17 (docs/backend/02 §17, PLAN §6 №17): «вебхуки — подпись, повторы» настоящие, но заполняются НЕ
 * отдельной кнопкой экрана (её там нет — WebhooksTab.tsx только читает/переключает), а fan-out'ом прямо
 * из AuditService.record — единственное место, куда уже стекаются события booking/client/staff/… со всех
 * модулей (доказано: `grep entityType:` по src/modules — 47 типов). Один файл вместо правки каждого модуля.
 *
 * Разметка честно частичная: маппятся только сущности, для которых есть 1:1 соответствие в 16 значениях
 * WebhookEntity фронта (WEBHOOK_ENTITIES) — остальные entityType молча не порождают доставку (не «дыра»,
 * а решение: у остальных нет клиента, которому это событие нужно было бы по документу 02 §17).
 */
const ENTITY_MAP = {
    booking: 'records',
    groupEvent: 'records',
    client: 'clients',
    staff: 'staff',
    location: 'location',
    service: 'services',
    serviceCategory: 'serviceCategories',
    product: 'goods',
    finOp: 'transactions',
    certificate: 'certificates',
    membershipSale: 'subscriptions',
    loyaltyCard: 'loyaltyCards',
};
/** action произвольного вида (created/fired/restoredFromDeleted/…) → 3 значения WebhookEventAction фронта */
function mapAction(action) {
    if (/delete|remove|purge|cancel/i.test(action))
        return 'delete';
    if (/^create/i.test(action))
        return 'create';
    return 'update';
}
function labelOf(entityId, after, before) {
    const name = (after?.['name'] ?? before?.['name']);
    if (typeof name === 'string' && name.trim())
        return name;
    if (name && typeof name === 'object') {
        const loc = name;
        if (loc.ru)
            return loc.ru;
    }
    return entityId;
}
/** Вызывается из AuditService.record, в ТОЙ ЖЕ транзакции — доставка коммитится, только если коммитится правка */
export async function fanOutWebhooks(tx, businessId, input) {
    if (!businessId)
        return;
    const entity = ENTITY_MAP[input.entityType];
    if (!entity)
        return;
    const cfg = await tx.webhook.findUnique({ where: { businessId } });
    if (!cfg || !cfg.enabled)
        return;
    const entities = cfg.entities ?? [];
    if (!entities.includes(entity))
        return;
    const addresses = await tx.webhookAddress.findMany({ where: { businessId } });
    if (!addresses.length)
        return;
    const action = mapAction(input.action);
    const objectLabel = labelOf(input.entityId, input.after, input.before);
    const payload = { entity, action, id: input.entityId, businessId, at: new Date().toISOString() };
    for (const address of addresses) {
        await tx.webhookDelivery.create({
            data: {
                id: newId('webhookDelivery'),
                businessId,
                addressId: address.id,
                url: address.url,
                entity,
                action,
                objectLabel: objectLabel.slice(0, 200),
                payload,
                status: 'pending',
                nextAttemptAt: new Date(),
            },
        });
    }
}
//# sourceMappingURL=webhook-fanout.js.map