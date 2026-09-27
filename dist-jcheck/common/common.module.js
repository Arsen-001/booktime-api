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
import { Global, Module, Inject } from '@nestjs/common';
import { adapterProviders } from '../adapters/adapters.js';
import { AuditService } from './audit/audit.service.js';
import { ContextMiddleware } from './http/context.middleware.js';
import { BizGuard, PlatformGuard, SessionGuard } from './http/guards.js';
import { DbLiveAccess, DbMembership } from './http/membership.js';
import { MEMBERSHIP_LISTER, MEMBERSHIP_RESOLVER, SESSION_RESOLVER } from './http/resolvers.js';
import { SessionStore } from './http/sessions.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.js';
import { LIVE_ACCESS, LiveController } from './live/live.controller.js';
import { LiveService } from './live/live.service.js';
import { PrismaService } from './prisma.service.js';
import { RateLimitGuard, RateLimitService } from './rate-limit/rate-limit.js';
import { createRedis } from './redis.js';
import { REDIS } from './tokens.js';
import { UndoController } from './undo/undo.controller.js';
import { UndoService } from './undo/undo.service.js';
/**
 * Сквозной слой (PLAN.md §5, этап 1) — общий для всех разделов. Сессии — из базы (SessionStore, этап 2), членство в
 * бизнесе и доступ к живым каналам — из таблицы staff и владения сетью (DbMembership, этап 3).
 */
let CommonModule = class CommonModule {
    constructor(redis) {
        this.redis = redis;
    }
    async onApplicationShutdown() {
        await this.redis.quit();
    }
};
CommonModule = __decorate([
    Global(),
    Module({
        controllers: [UndoController, LiveController],
        providers: [
            PrismaService,
            { provide: REDIS, useFactory: () => createRedis('api') },
            SessionStore,
            { provide: SESSION_RESOLVER, useExisting: SessionStore },
            DbMembership,
            DbLiveAccess,
            { provide: MEMBERSHIP_RESOLVER, useExisting: DbMembership },
            { provide: MEMBERSHIP_LISTER, useExisting: DbMembership },
            { provide: LIVE_ACCESS, useExisting: DbLiveAccess },
            ContextMiddleware,
            SessionGuard,
            BizGuard,
            PlatformGuard,
            AuditService,
            RateLimitService,
            RateLimitGuard,
            IdempotencyInterceptor,
            UndoService,
            LiveService,
            ...adapterProviders,
        ],
        exports: [
            PrismaService,
            REDIS,
            SessionStore,
            DbMembership,
            SESSION_RESOLVER,
            MEMBERSHIP_RESOLVER,
            MEMBERSHIP_LISTER,
            LIVE_ACCESS,
            SessionGuard,
            BizGuard,
            PlatformGuard,
            AuditService,
            RateLimitService,
            RateLimitGuard,
            IdempotencyInterceptor,
            UndoService,
            LiveService,
            ...adapterProviders.map((p) => p.provide),
        ],
    }),
    __param(0, Inject(REDIS)),
    __metadata("design:paramtypes", [Function])
], CommonModule);
export { CommonModule };
//# sourceMappingURL=common.module.js.map