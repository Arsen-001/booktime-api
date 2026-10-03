import 'reflect-metadata';
import { SwaggerModule } from '@nestjs/swagger';
import { createApp } from './bootstrap.js';
import { env } from './common/config/env.js';
import { logger } from './common/logging/logger.js';
import { initSentry } from './common/monitoring/sentry.js';

/** HTTP-сервер: API + (позже) SSE /v1/live. Отложенные дела — в отдельном процессе worker.ts. */
initSentry('api');
const { app, openapi } = await createApp();
SwaggerModule.setup('docs', app, () => openapi, { jsonDocumentUrl: 'openapi.json' });
await app.listen(env.PORT);
logger.info(`api: http://localhost:${env.PORT}  (OpenAPI: /openapi.json, документация: /docs)`);
