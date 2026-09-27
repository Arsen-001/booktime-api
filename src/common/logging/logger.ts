import { pino } from 'pino';
import { env } from '../config/env.js';

/** Один логгер на процесс: JSON в проде, читаемый вид при разработке. Секреты не пишем. */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.code'], remove: true },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } } }
    : {}),
});
