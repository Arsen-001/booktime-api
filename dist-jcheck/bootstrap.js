import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { env } from './common/config/env.js';
import { ErrorFilter } from './common/errors/error.filter.js';
/** Собрать приложение API (общая часть для сервера и генерации OpenAPI) */
export async function createApp() {
    const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
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
//# sourceMappingURL=bootstrap.js.map