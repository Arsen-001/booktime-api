import type { PrismaService } from '../common/prisma.service.js';

const DAY = 86_400_000;
/** Как ACCOUNT_DELETION_DAYS в modules/account (F-10-129) */
const ACCOUNT_DELETION_DAYS = 25;
/** Журнал входов хранится 1 год (решение F3) */
const LOGIN_EVENTS_KEEP_DAYS = 365;

/**
 * Уборка входа (воркер, раз в час): старые коды, журнал входов старше года, наступившие удаления аккаунтов.
 * Удаление здесь — «аккаунт закрыт» (вход невозможен, сессии отозваны); чистку данных делает этап 20.
 */
export async function authHousekeeping(prisma: PrismaService): Promise<Record<string, number>> {
  const now = Date.now();
  const otp = await prisma.otpRequest.deleteMany({ where: { sentAt: { lt: new Date(now - DAY) } } });
  const events = await prisma.loginEvent.deleteMany({ where: { at: { lt: new Date(now - LOGIN_EVENTS_KEEP_DAYS * DAY) } } });
  const sessions = await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now - 30 * DAY) } }, { revokedAt: { lt: new Date(now - 90 * DAY) } }] } });
  const due = await prisma.user.findMany({
    where: { deletedAt: null, deleteRequestedAt: { lte: new Date(now - ACCOUNT_DELETION_DAYS * DAY) } },
    select: { id: true },
  });
  for (const u of due) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: u.id }, data: { deletedAt: new Date(), version: { increment: 1 } } }),
      prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'deleted' } }),
      prisma.pushToken.deleteMany({ where: { userId: u.id } }),
    ]);
  }
  return { otp: otp.count, loginEvents: events.count, sessions: sessions.count, accountsClosed: due.length };
}
