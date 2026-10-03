import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { GoogleProfile } from './google-id-token.js';

/**
 * Google-аккаунт ещё не привязан (03.10.2026): сервер помнит проверенный профиль 10 минут под одноразовым случайным
 * токеном (pendingGoogle). Экран просит номер и код; верный код с этим токеном привязывает Google к человеку с этим
 * номером. Токен гасится при первом успешном коде (GETDEL) — повторно привязать им нельзя. В Redis — sha256 токена.
 */
export const GOOGLE_PENDING_TTL_SEC = 10 * 60;
export const GOOGLE_PENDING = Symbol('GOOGLE_PENDING');

export interface GooglePendingStore {
  put(profile: GoogleProfile): Promise<string>;
  /** Забрать и погасить; нет / истёк — null */
  take(token: string): Promise<GoogleProfile | null>;
}

const key = (token: string) => `google-pending:${createHash('sha256').update(token).digest('hex')}`;

export function newPendingToken(): string {
  return randomBytes(24).toString('base64url');
}

export class RedisGooglePending implements GooglePendingStore {
  constructor(private readonly redis: Redis) {}

  async put(profile: GoogleProfile): Promise<string> {
    const token = newPendingToken();
    await this.redis.set(key(token), JSON.stringify(profile), 'EX', GOOGLE_PENDING_TTL_SEC);
    return token;
  }

  async take(token: string): Promise<GoogleProfile | null> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const raw = await this.redis.getdel(key(token));
    return raw ? (JSON.parse(raw) as GoogleProfile) : null;
  }
}
