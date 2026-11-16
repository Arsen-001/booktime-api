import { ApiError } from '../../common/errors/api-error.js';
import type { PrismaService } from '../../common/prisma.service.js';

/**
 * Кому бизнес может написать в ленту приложения (личное сообщение из окна записи, чек визита): только своему клиенту —
 * неудалённая карточка клиента этого бизнеса с этим appUserId или он сам записан на эту запись (записался из приложения,
 * карточки ещё нет). Запись, если передана, — только этого бизнеса. Иначе 404: без проверки сотрудник с journal.edit
 * писал бы в ленту любому человеку.
 */
export async function assertBusinessAppRecipient(prisma: PrismaService, businessId: string, appUserId: string, bookingId?: string): Promise<void> {
  const booking = bookingId ? await prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { appUserId: true } }) : null;
  if (bookingId && !booking) throw new ApiError('not_found', 'Booking not found');
  if (booking?.appUserId === appUserId) return;
  const cards = await prisma.client.count({ where: { businessId, appUserId, deletedAt: null } });
  if (!cards) throw new ApiError('not_found', 'Client not found');
}
