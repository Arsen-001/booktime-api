import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';

/**
 * Этап 20 (B7, В-34, F-05-064, P11): что происходит с ДАННЫМИ ПРИЛОЖЕНИЯ, когда наступает удаление аккаунта
 * (25 дней после запроса истекли — `jobs/auth-housekeeping.ts` уже закрыл вход и отозвал сессии, это
 * следующий шаг той же транзакции). Мы обезличиваем только то, что принадлежит аккаунту человека: карточки
 * клиента в CRM бизнесов (`clients.phone`/`clients.name`) не трогаем — это чужие данные бизнеса (B7: «мы
 * обезличиваем только данные приложения»), их обезличивание по своему запросу делает `purgeClientData`
 * (этап 5), а по уходу бизнеса — `purgeAllClientsForBusiness` (этот же этап, `business-retention.ts`).
 *
 * - Имя → «Удалённый пользователь», телефон → null (номер освобождается, как у Client.purgedAt).
 * - Профиль приложения: пол/дата рождения/район/фото стёрты; согласие (`consentAt`) — оставляем как факт.
 * - Избранное и дневник — личные данные только этого человека, стираются целиком.
 * - Лист ожидания — общая таблица и для журнала бизнеса (F-01-156…162): запись остаётся (как у клиента,
 *   «записи остаются с обезличенным клиентом»), обезличивается только имя/телефон на строке.
 * - Звёздочка мастеру (`StarRating`) не трогаем: это только оценка без личных данных, а не «данные приложения»,
 *   и она входит в средний рейтинг мастера — удаление задним числом искажало бы чужую статистику.
 */
export async function anonymizeAppUserData(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.appProfile.updateMany({ where: { userId }, data: { gender: 'unknown', birthday: null, district: null, photoUrl: null } });
  await tx.favorite.deleteMany({ where: { appUserId: userId } });
  await tx.diaryEntry.deleteMany({ where: { appUserId: userId } });
  await tx.waitlistEntry.updateMany({ where: { appUserId: userId }, data: { clientName: 'Удалённый клиент', clientPhone: 'purged' } });
  await new AuditService().record(tx, null, { action: 'purged', entityType: 'user', entityId: userId, after: { name: 'Удалённый пользователь' } });
}
