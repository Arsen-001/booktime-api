import { Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from './common/prisma.service.js';
import { createRedis } from './common/redis.js';
import { REDIS } from './common/tokens.js';
import { HealthController } from './modules/health/health.controller.js';

/** Корневой модуль API. Разделы (PLAN.md §6) добавляются сюда по этапам. */
@Module({
  controllers: [HealthController],
  providers: [PrismaService, { provide: REDIS, useFactory: () => createRedis('api') }],
  exports: [PrismaService, REDIS],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
