import { Redis } from 'ioredis';
import { env } from './config/env.js';

/** Соединение Redis. BullMQ требует maxRetriesPerRequest: null. */
export function createRedis(name: string): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, connectionName: `booktime:${name}`, lazyConnect: false });
}
