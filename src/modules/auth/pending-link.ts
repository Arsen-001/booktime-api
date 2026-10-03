import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Внешний вход (Google, Apple) ещё не привязан (03.10.2026): сервер помнит проверенный профиль 10 минут под
 * одноразовым случайным токеном (pendingGoogle / pendingApple). Экран просит номер и код; верный код с этим токеном
 * привязывает аккаунт к человеку с этим номером. Токен гасится при первом успешном коде (GETDEL) — повторно привязать
 * им нельзя. В Redis — sha256 токена, у каждого провайдера свой префикс ключа.
 */
export const PENDING_LINK_TTL_SEC = 10 * 60;

export interface PendingLinkStore<P> {
  put(profile: P): Promise<string>;
  /** Забрать и погасить; нет / истёк — null */
  take(token: string): Promise<P | null>;
}

export function newPendingToken(): string {
  return randomBytes(24).toString('base64url');
}

export class RedisPendingLink<P> implements PendingLinkStore<P> {
  constructor(
    private readonly redis: Redis,
    /** 'google-pending' | 'apple-pending' */
    private readonly prefix: string,
  ) {}

  private key(token: string): string {
    return `${this.prefix}:${createHash('sha256').update(token).digest('hex')}`;
  }

  async put(profile: P): Promise<string> {
    const token = newPendingToken();
    await this.redis.set(this.key(token), JSON.stringify(profile), 'EX', PENDING_LINK_TTL_SEC);
    return token;
  }

  async take(token: string): Promise<P | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const raw = await this.redis.getdel(this.key(token));
    return raw ? (JSON.parse(raw) as P) : null;
  }
}
