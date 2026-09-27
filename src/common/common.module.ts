import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { adapterProviders } from '../adapters/adapters.js';
import { AuditService } from './audit/audit.service.js';
import { ContextMiddleware } from './http/context.middleware.js';
import { BizGuard, SessionGuard } from './http/guards.js';
import { MEMBERSHIP_RESOLVER, SESSION_RESOLVER, noMemberships, noSessions } from './http/resolvers.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.js';
import { LIVE_ACCESS, LiveController, ownChannelsOnly } from './live/live.controller.js';
import { LiveService } from './live/live.service.js';
import { PrismaService } from './prisma.service.js';
import { RateLimitGuard, RateLimitService } from './rate-limit/rate-limit.js';
import { createRedis } from './redis.js';
import { REDIS } from './tokens.js';
import { UndoController } from './undo/undo.controller.js';
import { UndoService } from './undo/undo.service.js';

/**
 * Сквозной слой (PLAN.md §5, этап 1) — общий для всех разделов. Резолверы сессий/членства и доступ к живым каналам —
 * заглушки «всё закрыто»; этапы 2 и 3 переопределяют их провайдерами в своих модулях.
 */
@Global()
@Module({
  controllers: [UndoController, LiveController],
  providers: [
    PrismaService,
    { provide: REDIS, useFactory: () => createRedis('api') },
    { provide: SESSION_RESOLVER, useValue: noSessions },
    { provide: MEMBERSHIP_RESOLVER, useValue: noMemberships },
    { provide: LIVE_ACCESS, useValue: ownChannelsOnly },
    ContextMiddleware,
    SessionGuard,
    BizGuard,
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
    SESSION_RESOLVER,
    MEMBERSHIP_RESOLVER,
    LIVE_ACCESS,
    SessionGuard,
    BizGuard,
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
