import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { ORDER_CODE_RE, type OrderRow } from './order-rules.js';

/**
 * Бизнес показывает заказы по ссылке: работает (active) или заморожен (frozen — не оплатил подписку, но вещь клиента всё
 * ещё у него) и не ушёл с платформы. Черновик (draft) и ушедший — нет.
 */
export const isPublicBusiness = (b: { status: string; leftAt: Date | null } | null | undefined): boolean => Boolean(b && (b.status === 'active' || b.status === 'frozen') && !b.leftAt);

/**
 * Заказ по публичному коду /o/<code> — для всех публичных действий (статус, смета, выдача). Неверный код, нет заказа,
 * бизнес ушёл с платформы или не работает — одинаково 404 not_found (ничего не выдаём о существовании заказа).
 */
export async function publicOrderByCode(db: Pick<Prisma.TransactionClient, 'order' | 'business'>, code: string): Promise<OrderRow> {
  const row = ORDER_CODE_RE.test(code) ? ((await db.order.findUnique({ where: { code } })) as OrderRow | null) : null;
  const biz = row ? await db.business.findUnique({ where: { id: row.businessId }, select: { status: true, leftAt: true } }) : null;
  if (!row || !isPublicBusiness(biz)) throw new ApiError('not_found', 'Order not found');
  return row;
}
