import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

/**
 * Мониторинг ошибок (Sentry, 03.10.2026; организация BookTime, данные в ЕС). Без SENTRY_DSN — выключен (разработка,
 * тесты). Уходят только неожиданные ошибки: 500 из ErrorFilter и упавшие задачи воркера; ошибки ввода и ApiError —
 * нет. Личные данные не отправляем (dataCollection по умолчанию + beforeSend вырезает заголовки, cookie, тело и пользователя).
 */
let enabled = false;

export function initSentry(service: 'api' | 'worker'): void {
  if (!env.SENTRY_DSN || enabled) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV,
    release: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12),
    serverName: service,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.data;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
  });
  Sentry.setTag('service', service);
  enabled = true;
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext('booktime', context);
    Sentry.captureException(err);
  });
}

/** Дождаться отправки перед выходом процесса */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}
