var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { applyDecorators, createParamDecorator, Inject, Injectable, SetMetadata, UseGuards, } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiCookieAuth } from '@nestjs/swagger';
import { ApiError } from '../errors/api-error.js';
import { MEMBERSHIP_RESOLVER } from './resolvers.js';
/** Контекст запроса в обработчике: handler(@Ctx() ctx: RequestContext) */
export const Ctx = createParamDecorator((_, host) => {
    return host.switchToHttp().getRequest().ctx;
});
/** Нужна сессия (любой вошедший) */
let SessionGuard = class SessionGuard {
    canActivate(host) {
        const { ctx } = host.switchToHttp().getRequest();
        if (!ctx?.session)
            throw new ApiError('unauthorized', 'Session required');
        return true;
    }
};
SessionGuard = __decorate([
    Injectable()
], SessionGuard);
export { SessionGuard };
const REQUIRED = 'bt:required-permissions';
/**
 * Кабинет бизнеса: `businessId` из пути сверяется с членством вошедшего (арендатор, PLAN.md §5), затем права.
 * Чужой бизнес и «нет права» отвечают одинаково — 403 forbidden, без подсказки, существует ли бизнес.
 */
let BizGuard = class BizGuard {
    constructor(reflector, memberships) {
        this.reflector = reflector;
        this.memberships = memberships;
    }
    async canActivate(host) {
        const req = host.switchToHttp().getRequest();
        const session = req.ctx?.session;
        if (!session)
            throw new ApiError('unauthorized', 'Session required');
        const businessId = req.params['businessId'];
        if (typeof businessId !== 'string' || !businessId)
            throw new ApiError('forbidden', 'Business is not accessible');
        const member = await this.memberships.resolve(session, businessId);
        if (!member)
            throw new ApiError('forbidden', 'Business is not accessible');
        const required = this.reflector.getAllAndOverride(REQUIRED, [host.getHandler(), host.getClass()]) ?? [];
        const missing = required.filter((p) => !member.permissions.has(p));
        if (missing.length)
            throw new ApiError('forbidden', `Missing permission: ${missing.join(', ')}`);
        req.ctx.member = member;
        return true;
    }
};
BizGuard = __decorate([
    Injectable(),
    __param(1, Inject(MEMBERSHIP_RESOLVER)),
    __metadata("design:paramtypes", [Reflector, Object])
], BizGuard);
export { BizGuard };
/** Маршрут кабинета: @Biz('journal.edit') над обработчиком пути /v1/biz/:businessId/… */
export function Biz(...permissions) {
    return applyDecorators(SetMetadata(REQUIRED, permissions), UseGuards(BizGuard), ApiCookieAuth());
}
/** Маршрут для любого вошедшего: @Authed() */
export function Authed() {
    return applyDecorators(UseGuards(SessionGuard), ApiCookieAuth());
}
/** Арендатор в выборках: where: { ...tenant(ctx) } — business_id обязателен (PLAN.md §5) */
export function tenant(ctx) {
    if (!ctx.member)
        throw new ApiError('forbidden', 'Business context required');
    return { businessId: ctx.member.businessId };
}
/** Наша панель: сессия команды платформы (Р11, своя cookie) */
let PlatformGuard = class PlatformGuard {
    canActivate(host) {
        const { ctx } = host.switchToHttp().getRequest();
        if (!ctx?.session?.platform)
            throw new ApiError('unauthorized', 'Platform session required');
        return true;
    }
};
PlatformGuard = __decorate([
    Injectable()
], PlatformGuard);
export { PlatformGuard };
/** Маршрут нашей панели /v1/platform/…: @Platform() */
export function Platform() {
    return applyDecorators(UseGuards(PlatformGuard), ApiCookieAuth());
}
//# sourceMappingURL=guards.js.map