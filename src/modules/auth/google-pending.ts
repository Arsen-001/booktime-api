import type { Redis } from 'ioredis';
import type { GoogleProfile } from './google-id-token.js';
import { PENDING_LINK_TTL_SEC, RedisPendingLink, type PendingLinkStore } from './pending-link.js';

export { newPendingToken } from './pending-link.js';

/**
 * Google-аккаунт ещё не привязан (03.10.2026): проверенный профиль ждёт 10 минут под одноразовым токеном
 * (pendingGoogle); верный код с этим токеном привязывает Google к человеку с этим номером. Хранилище — pending-link.ts.
 */
export const GOOGLE_PENDING_TTL_SEC = PENDING_LINK_TTL_SEC;
export const GOOGLE_PENDING = Symbol('GOOGLE_PENDING');

export type GooglePendingStore = PendingLinkStore<GoogleProfile>;

export class RedisGooglePending extends RedisPendingLink<GoogleProfile> {
  constructor(redis: Redis) {
    super(redis, 'google-pending');
  }
}
