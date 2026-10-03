import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { env } from './common/config/env.js';
import { ErrorFilter } from './common/errors/error.filter.js';

/** Собрать приложение API (общая часть для сервера и генерации OpenAPI) */
export async function createApp(): Promise<{ app: NestExpressApplication; openapi: OpenAPIObject }> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  // Фото/логотипы/сторис приходят как data: URL в JSON-теле (imageUrl до 4 000 000 симв. в схемах platform/
  // services/client) — дефолтный лимит Express (100kb) резал их 413 ещё до валидации zod (этап 21, лейн rest).
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });
  // IP для лимитов (rate-limit.ts) и журнала сессий: за прокси Railway — из X-Forwarded-For (TRUST_PROXY=1)
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const config = new DocumentBuilder()
    .setTitle('BookTime API')
    .setDescription('Сервер для booking-platform. Ошибки — { code, message } (docs/backend/02-api.md §0).')
    .setVersion('0.1.0')
    .build();
  const openapi = SwaggerModule.createDocument(app, config);
  return { app, openapi };
}
