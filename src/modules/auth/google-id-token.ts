import { ApiError } from '../../common/errors/api-error.js';
import { fetchJwksFrom, JwksVerifier, type Jwks } from './jwks.js';

export type { Jwks } from './jwks.js';

/**
 * Проверка Google ID token (03.10.2026, «Войти через Google»): без библиотек — node:crypto умеет RS256 и ключи JWK.
 * Подпись — открытым ключом Google из JWKS (по kid заголовка; ключи кэшируются по Cache-Control, незнакомый kid —
 * перечитать, не чаще раза в минуту; общий кэш — jwks.ts), `iss` — accounts.google.com, `aud` — один из наших
 * Client ID (web/android/ios), срок (`exp`, с запасом 60 с на разницу часов), `email_verified`. Ответ — постоянный
 * `sub`, почта и имя. https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export interface GoogleProfile {
  /** Постоянный id аккаунта Google */
  sub: string;
  email: string;
  name: string | null;
}

export interface GoogleVerifierOptions {
  /** Разрешённые aud — наши Client ID; пусто — вход через Google выключен */
  clientIds: string[];
  /** Загрузить JWKS (тесты подставляют свои ключи) */
  fetchJwks?: () => Promise<Jwks>;
  /** Текущее время в мс (тесты) */
  now?: () => number;
}

function invalid(reason: string): ApiError {
  return new ApiError('google_invalid', `Google sign-in failed: ${reason}`);
}

export class GoogleIdTokenVerifier {
  private readonly jwt: JwksVerifier;

  constructor(private readonly opts: GoogleVerifierOptions) {
    this.jwt = new JwksVerifier({
      provider: 'google',
      fetchJwks: opts.fetchJwks ?? (() => fetchJwksFrom(GOOGLE_JWKS_URL)),
      now: opts.now ?? Date.now,
      invalid,
      unavailable: () => new ApiError('google_unavailable', 'Google keys are unavailable, try later'),
    });
  }

  get enabled(): boolean {
    return this.opts.clientIds.length > 0;
  }

  /** Проверить ID token. Неверный — ApiError('google_invalid'); выключено — ApiError('google_disabled') */
  async verify(idToken: string): Promise<GoogleProfile> {
    if (!this.enabled) throw new ApiError('google_disabled', 'Google sign-in is not configured');
    const c = await this.jwt.verifySignature(idToken);
    if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.has(c.iss)) throw invalid('wrong issuer');
    this.jwt.checkAudience(c, this.opts.clientIds);
    this.jwt.checkTimes(c);
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw invalid('no subject');
    if (typeof c.email !== 'string' || !c.email) throw invalid('no email');
    if (c.email_verified !== true && c.email_verified !== 'true') throw invalid('email not verified');
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 120) : null;
    return { sub: c.sub, email: c.email.slice(0, 254), name };
  }
}
