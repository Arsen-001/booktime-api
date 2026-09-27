import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../common/ids/ids.js';
const J = (v) => (v === undefined || v === null ? Prisma.DbNull : v);
/**
 * Кладёт строку в очередь отправки (05 §4). `dedupeKey` уникален — вызов с уже известным ключом ничего не
 * делает и возвращает false, поэтому вызывающему безопасно звать это на каждый проход задачи, а не только
 * один раз в жизни события.
 */
export async function enqueueOutbox(db, input) {
    const existing = await db.notifyOutbox.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
    if (existing)
        return false;
    try {
        await db.notifyOutbox.create({
            data: {
                id: newId('notifyOutbox'),
                businessId: input.businessId ?? null,
                app: input.app,
                kind: input.kind,
                recipientUserId: input.recipientUserId,
                title: input.title.slice(0, 200),
                body: input.body.slice(0, 600),
                url: input.url,
                dedupeKey: input.dedupeKey,
                sendAt: input.sendAt ?? new Date(),
                meta: J(input.meta),
            },
        });
        return true;
    }
    catch (err) {
        // Гонка: два прохода задачи вставили один dedupeKey одновременно — вторая строка не нужна, не сбой
        if (err.code === 'P2002')
            return false;
        throw err;
    }
}
/** Клиенту: строка в очередь + (опционально) строка в его ленту — атомарно, одной проверкой dedupeKey */
export async function enqueueClientNotification(db, input) {
    const created = await enqueueOutbox(db, { ...input, app: 'client', recipientUserId: input.appUserId });
    if (created && input.inbox) {
        await db.inboxItem.create({
            data: {
                id: newId('inboxItem'),
                appUserId: input.appUserId,
                kind: input.inbox.kind,
                businessId: input.inbox.businessId ?? null,
                staffId: input.inbox.staffId ?? null,
                bookingId: input.inbox.bookingId ?? null,
                params: J(input.inbox.params),
            },
        });
    }
    return created;
}
//# sourceMappingURL=outbox.js.map