import { Injectable } from '@nestjs/common';
import type { Network } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';
import { NETWORK_PERMISSION_KEYS, isNetworkPermission, type NetworkPermissionKey } from './network.schemas.js';

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
      if (nu && !nu.pending && perms.includes(permission) && (await this.inAllowedBranch(ctx.session.userId, network.businessIds, nu.businessIds))) {
        return { network, isOwner: false };
      }
    }
    throw new ApiError('forbidden', 'Network is not accessible');
  }

  /**
   * Сеть7 (как мок `canSeeNetworkClientData`): пользователь сети с ограничением по филиалам, который сам работает
   * в филиале ВНЕ своего списка, сеть не видит. Без ограничения (null) или без своей строки staff в сети
   * (вход логином+паролем, F-11-026) — проходит.
   */
  private async inAllowedBranch(userId: string, networkBusinessIds: string[], allowed: unknown): Promise<boolean> {
    if (!Array.isArray(allowed)) return true;
    const own = await this.prisma.staff.findMany({ where: { userId, businessId: { in: networkBusinessIds }, deletedAt: null, firedAt: null }, select: { businessId: true } });
    return !own.length || own.some((st) => (allowed as string[]).includes(st.businessId));
  }

  /**
   * Права текущего пользователя в сети ЭТОГО филиала — для меню и экранов кабинета сети (01.10.2026: права
   * режут кабинет). Владелец сети — все; пользователь сети — свои галочки; филиал вне его списка — не участник.
   */
  async myAccess(userId: string, businessId: string): Promise<{ networkId?: string; member: boolean; permissions: NetworkPermissionKey[]; businessIds?: string[] }> {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
    if (!biz?.networkId) return { member: false, permissions: [] };
    const network = await this.loadNetwork(biz.networkId);
    if (!network || network.deletedAt) return { member: false, permissions: [] };
    if (network.ownerUserId === userId) return { networkId: network.id, member: true, permissions: [...NETWORK_PERMISSION_KEYS] };
    const nu = await this.prisma.networkUser.findUnique({ where: { networkId_userId: { networkId: network.id, userId } } });
    if (!nu || nu.pending) return { networkId: network.id, member: false, permissions: [] };
    const branches = Array.isArray(nu.businessIds) ? (nu.businessIds as string[]) : undefined;
    if (branches && !branches.includes(businessId)) return { networkId: network.id, member: false, permissions: [] };
    const permissions = Array.isArray(nu.permissions) ? nu.permissions.filter(isNetworkPermission) : [];
    return { networkId: network.id, member: true, permissions, ...(branches ? { businessIds: branches } : {}) };
  }
}
