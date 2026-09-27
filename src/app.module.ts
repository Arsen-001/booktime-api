import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { ContextMiddleware } from './common/http/context.middleware.js';
import { HealthController } from './modules/health/health.controller.js';

/** Корневой модуль API. Разделы (PLAN.md §6) добавляются сюда по этапам. */
@Module({
  imports: [CommonModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}
