import { createPublicKey, verify as verifySignature, type KeyObject, type webcrypto } from 'node:crypto';
import type { ApiError } from '../../common/errors/api-error.js';
import { logger } from '../../common/logging/logger.js';

/**
 * Общее для «Войти через Google» и «Войти через Apple» (03.10.2026): JWT, подписанный RS256 ключом провайдера из JWKS.
 * Без библиотек — node:crypto умеет RS256 и ключи JWK. Ключи кэшируются (Cache-Control: max-age или час), незнакомый
 * kid — перечитать, не чаще раза в минуту; провайдер недоступен — старые ключи годятся, если нужный среди них.
 */
export const CLOCK_SKEW_SEC = 60;
const DEFAULT_JWKS_TTL_SEC = 3600;
const REFETCH_UNKNOWN_KID_SEC = 60;

export interface Jwks {
  keys: (webcrypto.JsonWebKey & { kid?: string })[];
  /** Сколько секунд ключи можно не перечитывать (Cache-Control: max-age) */
  maxAgeSec?: number;
}

/** Загрузить JWKS по адресу провайдера (таймаут 5 с) */
export async function fetchJwksFrom(url: string): Promise<Jwks> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS ${url} HTTP ${res.status}`);
  const body = (await res.json()) as Jwks;
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
  return { keys: body.keys ?? [], maxAgeSec: maxAge ? Number(maxAge) : undefined };
}

export interface JwksVerifierOptions {
  /** 'google' | 'apple' — в лог при сбое загрузки ключей */
  provider: string;
  fetchJwks: () => Promise<Jwks>;
  now: () => number;
  /** Токен не прошёл проверку (причина — в message, по-английски) */
  invalid: (reason: string) => ApiError;
  /** Ключи провайдера недоступны, а нужного среди старых нет */
  unavailable: () => ApiError;
}

/** Кэш ключей провайдера + проверка заголовка и подписи RS256. Утверждения (iss, aud, срок…) проверяет вызывающий. */
export class JwksVerifier {
  private keys = new Map<string, KeyObject>();
  private keysUntil = 0;
  private fetchedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly opts: JwksVerifierOptions) {}

  private async refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const jwks = await this.opts.fetchJwks();
        const next = new Map<string, KeyObject>();
        for (const k of jwks.keys) {
          if (!k.kid || k.kty !== 'RSA') continue;
          next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
        }
        this.keys = next;
        this.fetchedAt = this.opts.now();
        this.keysUntil = this.fetchedAt + (jwks.maxAgeSec ?? DEFAULT_JWKS_TTL_SEC) * 1000;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const now = this.opts.now();
    const stale = now >= this.keysUntil;
    const unknown = !this.keys.has(kid) && now - this.fetchedAt >= REFETCH_UNKNOWN_KID_SEC * 1000;
    if (stale || unknown) {
      try {
        await this.refresh();
      } catch (err) {
        logger.warn({ err: (err as Error).message, provider: this.opts.provider }, 'jwks fetch failed');
        // Старые ключи ещё годятся, если среди них нужный; иначе — сервис провайдера недоступен
        if (!this.keys.has(kid)) throw this.opts.unavailable();
      }
    }
    const key = this.keys.get(kid);
    if (!key) throw this.opts.invalid('unknown signing key');
    return key;
  }

  private decodePart<T>(part: string): T {
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
    } catch {
      throw this.opts.invalid('malformed token');
    }
  }

  /** Разобрать JWT, проверить alg RS256 и подпись ключом из JWKS → утверждения (claims) */
  async verifySignature(token: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw this.opts.invalid('malformed token');
    const [h, p, s] = parts as [string, string, string];
    const header = this.decodePart<{ alg?: string; kid?: string }>(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw this.opts.invalid('unexpected alg');
    const key = await this.keyFor(header.kid);
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw this.opts.invalid('bad signature');
    const claims = this.decodePart<unknown>(p);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw this.opts.invalid('malformed token');
    return claims as Record<string, unknown>;
  }

  /** aud — один из наших id (строка или массив) */
  checkAudience(c: Record<string, unknown>, allowed: string[]): void {
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.some((a) => typeof a === 'string' && allowed.includes(a))) throw this.opts.invalid('wrong audience');
  }

  /** exp обязателен, iat не из будущего — с запасом 60 с на разницу часов */
  checkTimes(c: Record<string, unknown>): void {
    const nowSec = this.opts.now() / 1000;
    if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_SEC < nowSec) throw this.opts.invalid('expired');
    if (typeof c.iat === 'number' && c.iat - CLOCK_SKEW_SEC > nowSec) throw this.opts.invalid('issued in the future');
  }
}
