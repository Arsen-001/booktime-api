import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import type { Permission } from '../../common/permissions/permissions.js';
import type { PrismaService } from '../../common/prisma.service.js';

/**
 * 02-api.md §11 даёт некоторым маршрутам два права через «/» (loyalty.manage / finance.edit — любое из двух
 * достаточно). `@Biz(...)` проверяет права через И, поэтому эти маршруты не вешают декоратор с правом вовсе
 * (голый `@Biz()`) и сверяются здесь вручную.
 */
export function requireAny(ctx: RequestContext, perms: Permission[]): void {
  if (!perms.some((p) => ctx.member!.permissions.has(p))) throw new ApiError('forbidden', `Missing permission: one of ${perms.join(', ')}`);
}

/**
 * Владелец программы лояльности (F-06-002): сеть, если бизнес в сети, иначе сам бизнес. Все типы (карт, акций,
 * сертификатов, абонементов, счетов) хранятся с этим `ownerId` — так «во всех салонах сети» (В-09) не требует
 * отдельного пути /v1/net/…, достаточно единого индекса: любой бизнес сети видит и пишет один и тот же набор.
 */
export function ownerOf(ctx: RequestContext): string {
  return ctx.member!.networkId ?? ctx.member!.businessId;
}

/** businessId сети (все филиалы) или единственный businessId — где именно карта/абонемент/сертификат «работает». */
export async function networkBusinessIds(prisma: PrismaService, ctx: RequestContext): Promise<string[]> {
  return resolveScopeBusinessIds(prisma, ctx.member!.businessId);
}

/** То же самое, но без сессии кабинета — для клиентских маршрутов (GET /v1/me/loyalty, В-09). */
export async function resolveScopeBusinessIds(prisma: PrismaService, businessId: string): Promise<string[]> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
  if (!business?.networkId) return [businessId];
  const rows = await prisma.business.findMany({ where: { networkId: business.networkId, leftAt: null }, select: { id: true } });
  return rows.map((r) => r.id);
}
