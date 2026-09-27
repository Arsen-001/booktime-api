import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
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
@Global()
@Module({
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
})
export class CommonModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
