var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { isNetworkPermission } from './network.schemas.js';
/**
 * Доступ к сетевым разделам (этап 15, F-11-024…039): владелец сети (Network.ownerUserId) видит и правит всё;
 * приглашённый пользователь сети (NetworkUser, без своей строки staff ни в одном филиале) — только то, на что
 * дано право. Чужая сеть и «нет права» отвечают одинаково — 403, без подсказки, существует ли сеть (PLAN.md §5).
 */
let NetworkAccessService = class NetworkAccessService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    /** Сеть + активные бизнесы (businessIds) — не отдаёт удалённые/вышедшие филиалы */
    async loadNetwork(networkId) {
        const n = await this.prisma.network.findUnique({ where: { id: networkId }, include: { businesses: { where: { leftAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } } } });
        if (!n)
            return null;
        const { businesses, ...rest } = n;
        return { ...rest, businessIds: businesses.map((b) => b.id) };
    }
    /** permission не задан — доступ только владельцу (структурные операции сети, как в NetworkService.own) */
    async require(ctx, networkId, permission) {
        if (!ctx.session)
            throw new ApiError('unauthorized', 'Session required');
        const network = await this.loadNetwork(networkId);
        if (!network || network.deletedAt)
            throw new ApiError('forbidden', 'Network is not accessible');
        if (network.ownerUserId === ctx.session.userId)
            return { network, isOwner: true };
        if (permission) {
            const nu = await this.prisma.networkUser.findUnique({ where: { networkId_userId: { networkId, userId: ctx.session.userId } } });
            const perms = Array.isArray(nu?.permissions) ? nu.permissions.filter(isNetworkPermission) : [];
            if (nu && perms.includes(permission))
                return { network, isOwner: false };
        }
        throw new ApiError('forbidden', 'Network is not accessible');
    }
};
NetworkAccessService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], NetworkAccessService);
export { NetworkAccessService };
//# sourceMappingURL=network-access.service.js.map