import { Injectable } from '@nestjs/common';
import type { Network } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';
import { isNetworkPermission, type NetworkPermissionKey } from './network.schemas.js';

export interface NetworkAccess {
  network: Network & { businessIds: string[] };
  isOwner: boolean;
}

/**
 * Доступ к сетевым разделам (этап 15, F-11-024…039): владелец сети (Network.ownerUserId) видит и правит всё;
 * приглашённый пользователь сети (NetworkUser, без своей строки staff ни в одном филиале) — только то, на что
 * дано право. Чужая сеть и «нет права» отвечают одинаково — 403, без подсказки, существует ли сеть (PLAN.md §5).
 */
@Injectable()
export class NetworkAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Сеть + активные бизнесы (businessIds) — не отдаёт удалённые/вышедшие филиалы */
  private async loadNetwork(networkId: string): Promise<(Network & { businessIds: string[] }) | null> {
    const n = await this.prisma.network.findUnique({ where: { id: networkId }, include: { businesses: { where: { leftAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } } } });
    if (!n) return null;
    const { businesses, ...rest } = n;
    return { ...rest, businessIds: businesses.map((b) => b.id) };
  }

  /** permission не задан — доступ только владельцу (структурные операции сети, как в NetworkService.own) */
  async require(ctx: RequestContext, networkId: string, permission?: NetworkPermissionKey): Promise<NetworkAccess> {
    if (!ctx.session) throw new ApiError('unauthorized', 'Session required');
    const network = await this.loadNetwork(networkId);
    if (!network || network.deletedAt) throw new ApiError('forbidden', 'Network is not accessible');
    if (network.ownerUserId === ctx.session.userId) return { network, isOwner: true };
    if (permission) {
      const nu = await this.prisma.networkUser.findUnique({ where: { networkId_userId: { networkId, userId: ctx.session.userId } } });
      const perms = Array.isArray(nu?.permissions) ? nu.permissions.filter(isNetworkPermission) : [];
      if (nu && perms.includes(permission)) return { network, isOwner: false };
    }
    throw new ApiError('forbidden', 'Network is not accessible');
  }
}
