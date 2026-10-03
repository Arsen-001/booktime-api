import type { Redis } from 'ioredis';
import type { AppleProfile } from './apple-id-token.js';
import { PENDING_LINK_TTL_SEC, RedisPendingLink, type PendingLinkStore } from './pending-link.js';

/**
 * Apple-аккаунт ещё не привязан (03.10.2026): проверенный профиль ждёт 10 минут под одноразовым токеном
 * (pendingApple); верный код с этим токеном привязывает Apple к человеку с этим номером. Хранилище — pending-link.ts.
 */
export const APPLE_PENDING_TTL_SEC = PENDING_LINK_TTL_SEC;
export const APPLE_PENDING = Symbol('APPLE_PENDING');

export type ApplePendingStore = PendingLinkStore<AppleProfile>;

export class RedisApplePending extends RedisPendingLink<AppleProfile> {
  constructor(redis: Redis) {
    super(redis, 'apple-pending');
  }
}
