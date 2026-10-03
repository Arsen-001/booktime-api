import { createPublicKey, verify as verifySignature, type KeyObject, type webcrypto } from 'node:crypto';
import { ApiError } from '../../common/errors/api-error.js';
import { logger } from '../../common/logging/logger.js';

/**
 * Проверка Google ID token (03.10.2026, «Войти через Google»): без библиотек — node:crypto умеет RS256 и ключи JWK.
 * Подпись — открытым ключом Google из JWKS (по kid заголовка; ключи кэшируются по Cache-Control, незнакомый kid —
 * перечитать, не чаще раза в минуту), `iss` — accounts.google.com, `aud` — один из наших Client ID (web/android/ios),
 * срок (`exp`, с запасом 60 с на разницу часов), `email_verified`. Ответ — постоянный `sub`, почта и имя.
 * https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_SEC = 60;
const DEFAULT_JWKS_TTL_SEC = 3600;
const REFETCH_UNKNOWN_KID_SEC = 60;

export interface GoogleProfile {
  /** Постоянный id аккаунта Google */
  sub: string;
  email: string;
  name: string | null;
}

export interface Jwks {
  keys: (webcrypto.JsonWebKey & { kid?: string })[];
  /** Сколько секунд ключи можно не перечитывать (Cache-Control: max-age) */
  maxAgeSec?: number;
}

export interface GoogleVerifierOptions {
  /** Разрешённые aud — наши Client ID; пусто — вход через Google выключен */
  clientIds: string[];
  /** Загрузить JWKS (тесты подставляют свои ключи) */
  fetchJwks?: () => Promise<Jwks>;
  /** Текущее время в мс (тесты) */
  now?: () => number;
}

async function fetchGoogleJwks(): Promise<Jwks> {
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Google JWKS HTTP ${res.status}`);
  const body = (await res.json()) as Jwks;
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
  return { keys: body.keys ?? [], maxAgeSec: maxAge ? Number(maxAge) : undefined };
}

function invalid(reason: string): ApiError {
  return new ApiError('google_invalid', `Google sign-in failed: ${reason}`);
}

function decodePart<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    throw invalid('malformed token');
  }
}

export class GoogleIdTokenVerifier {
  private keys = new Map<string, KeyObject>();
  private keysUntil = 0;
  private fetchedAt = 0;
  private loading: Promise<void> | null = null;
  private readonly fetchJwks: () => Promise<Jwks>;
  private readonly now: () => number;

  constructor(private readonly opts: GoogleVerifierOptions) {
    this.fetchJwks = opts.fetchJwks ?? fetchGoogleJwks;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.clientIds.length > 0;
  }

  private async refresh(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const jwks = await this.fetchJwks();
        const next = new Map<string, KeyObject>();
        for (const k of jwks.keys) {
          if (!k.kid || k.kty !== 'RSA') continue;
          next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
        }
        this.keys = next;
        this.fetchedAt = this.now();
        this.keysUntil = this.fetchedAt + (jwks.maxAgeSec ?? DEFAULT_JWKS_TTL_SEC) * 1000;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const now = this.now();
    const stale = now >= this.keysUntil;
    const unknown = !this.keys.has(kid) && now - this.fetchedAt >= REFETCH_UNKNOWN_KID_SEC * 1000;
    if (stale || unknown) {
      try {
        await this.refresh();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'google jwks fetch failed');
        // Старые ключи ещё годятся, если среди них нужный; иначе — сервис Google недоступен
        if (!this.keys.has(kid)) throw new ApiError('google_unavailable', 'Google keys are unavailable, try later');
      }
    }
    const key = this.keys.get(kid);
    if (!key) throw invalid('unknown signing key');
    return key;
  }

  /** Проверить ID token. Неверный — ApiError('google_invalid'); выключено — ApiError('google_disabled') */
  async verify(idToken: string): Promise<GoogleProfile> {
    if (!this.enabled) throw new ApiError('google_disabled', 'Google sign-in is not configured');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw invalid('malformed token');
    const [h, p, s] = parts as [string, string, string];
    const header = decodePart<{ alg?: string; kid?: string }>(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid('unexpected alg');
    const key = await this.keyFor(header.kid);
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw invalid('bad signature');

    const c = decodePart<Record<string, unknown>>(p);
    if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.has(c.iss)) throw invalid('wrong issuer');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.some((a) => typeof a === 'string' && this.opts.clientIds.includes(a))) throw invalid('wrong audience');
    const nowSec = this.now() / 1000;
    if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_SEC < nowSec) throw invalid('expired');
    if (typeof c.iat === 'number' && c.iat - CLOCK_SKEW_SEC > nowSec) throw invalid('issued in the future');
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw invalid('no subject');
    if (typeof c.email !== 'string' || !c.email) throw invalid('no email');
    if (c.email_verified !== true && c.email_verified !== 'true') throw invalid('email not verified');
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 120) : null;
    return { sub: c.sub, email: c.email.slice(0, 254), name };
  }
}
