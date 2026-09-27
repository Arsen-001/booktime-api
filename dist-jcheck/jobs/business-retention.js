import { AuditService } from '../common/audit/audit.service.js';
import { ClientsService } from '../modules/clients/clients.service.js';
const DAY = 86_400_000;
/** B6 (docs/backend/08 §B): заморожен — бессрочно; ушёл — 90 дней после выгрузки, потом обезличивание клиентов */
const LEFT_RETENTION_DAYS = 90;
/**
 * Хранение и обезличивание при уходе бизнеса (B6, F-00-183, этап 20). `Business.leftAt` и
 * `BizMeta.dataHandedAt` заводит наша панель (этап 19, `modules/platform/businesses.service.ts::markLeft`) —
 * здесь только срок: 90 дней после выдачи данных истекли → обезличиваем клиентов той же логикой, что и
 * ручной запрос клиента (F-04-211, `ClientsService.purgeClientData`), только без действия сотрудника.
 * Замороженный бизнес (`leftAt IS NULL`) сюда не попадает — хранится бессрочно, как решено.
 */
export async function businessRetentionTick(prisma) {
    const left = await prisma.business.findMany({ where: { leftAt: { not: null } }, select: { id: true } });
    if (!left.length)
        return { businesses: 0, clients: 0 };
    const due = await prisma.bizMeta.findMany({
        where: { businessId: { in: left.map((b) => b.id) }, dataHandedAt: { lte: new Date(Date.now() - LEFT_RETENTION_DAYS * DAY) } },
        select: { businessId: true },
    });
    const clients = new ClientsService(prisma, new AuditService());
    let clientsTotal = 0;
    for (const { businessId } of due)
        clientsTotal += await clients.purgeAllClientsForBusiness(businessId);
    return { businesses: due.length, clients: clientsTotal };
}
//# sourceMappingURL=business-retention.js.map