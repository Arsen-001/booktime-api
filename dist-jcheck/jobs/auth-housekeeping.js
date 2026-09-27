import { anonymizeAppUserData } from '../modules/account/account-anonymize.js';
const DAY = 86_400_000;
/** Как ACCOUNT_DELETION_DAYS в modules/account (F-10-129) */
const ACCOUNT_DELETION_DAYS = 25;
/** Журнал входов хранится 1 год (решение F3) */
const LOGIN_EVENTS_KEEP_DAYS = 365;
/**
 * Уборка входа (воркер, раз в час): старые коды, журнал входов старше года, наступившие удаления аккаунтов.
 * Удаление здесь — «аккаунт закрыт» (вход невозможен, сессии отозваны) И обезличивание данных приложения
 * (F-05-064, B7, P11, этап 20, account-anonymize.ts) в той же транзакции — `deletedAt IS NULL` в выборке ниже
 * делает шаг идемпотентным: обработанный однажды пользователь больше не попадёт в `due`.
 */
export async function authHousekeeping(prisma) {
    const now = Date.now();
    const otp = await prisma.otpRequest.deleteMany({ where: { sentAt: { lt: new Date(now - DAY) } } });
    const events = await prisma.loginEvent.deleteMany({ where: { at: { lt: new Date(now - LOGIN_EVENTS_KEEP_DAYS * DAY) } } });
    const sessions = await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now - 30 * DAY) } }, { revokedAt: { lt: new Date(now - 90 * DAY) } }] } });
    const due = await prisma.user.findMany({
        where: { deletedAt: null, deleteRequestedAt: { lte: new Date(now - ACCOUNT_DELETION_DAYS * DAY) } },
        select: { id: true },
    });
    for (const u of due) {
        await prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { id: u.id }, data: { deletedAt: new Date(), name: 'Удалённый пользователь', phone: null, version: { increment: 1 } } });
            await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'deleted' } });
            await tx.pushToken.deleteMany({ where: { userId: u.id } });
            await anonymizeAppUserData(tx, u.id);
        });
    }
    return { otp: otp.count, loginEvents: events.count, sessions: sessions.count, accountsClosed: due.length };
}
//# sourceMappingURL=auth-housekeeping.js.map