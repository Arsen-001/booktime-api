import { ApiError } from '../../common/errors/api-error.js';
import { fetchJwksFrom, JwksVerifier, type Jwks } from './jwks.js';

/**
 * Проверка Apple identity token (03.10.2026, «Войти через Apple»): как у Google — без библиотек, общий кэш ключей
 * (jwks.ts). Подпись RS256 ключом Apple из JWKS по kid, `iss` — https://appleid.apple.com, `aud` — один из наших
 * APPLE_CLIENT_IDS (bundle id приложений, Services ID сайта), срок с запасом 60 с, `sub` обязателен.
 * Почту Apple даёт не всегда (и бывает private relay …@privaterelay.appleid.com) — тогда null; имени в токене нет
 * (приходит только приложению при первом входе — его передают отдельным полем name).
 * https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api/verifying_a_user
 */
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const APPLE_ISSUER = 'https://appleid.apple.com';

export interface AppleProfile {
  /** Постоянный id аккаунта Apple (для нашей команды разработчика) */
  sub: string;
  email: string | null;
  /** Имя — не из токена: из первого ответа Apple приложению (givenName + familyName), если прислали */
  name: string | null;
}

export interface AppleVerifierOptions {
  /** Разрешённые aud — bundle id / Services ID; пусто — вход через Apple выключен */
  clientIds: string[];
  /** Загрузить JWKS (тесты подставляют свои ключи) */
  fetchJwks?: () => Promise<Jwks>;
  /** Текущее время в мс (тесты) */
  now?: () => number;
}

function invalid(reason: string): ApiError {
  return new ApiError('apple_invalid', `Apple sign-in failed: ${reason}`);
}

export class AppleIdTokenVerifier {
  private readonly jwt: JwksVerifier;

  constructor(private readonly opts: AppleVerifierOptions) {
    this.jwt = new JwksVerifier({
      provider: 'apple',
      fetchJwks: opts.fetchJwks ?? (() => fetchJwksFrom(APPLE_JWKS_URL)),
      now: opts.now ?? Date.now,
      invalid,
      unavailable: () => new ApiError('apple_unavailable', 'Apple keys are unavailable, try later'),
    });
  }

  get enabled(): boolean {
    return this.opts.clientIds.length > 0;
  }

  /** Проверить identity token. Неверный — ApiError('apple_invalid'); выключено — ApiError('apple_disabled') */
  async verify(identityToken: string): Promise<AppleProfile> {
    if (!this.enabled) throw new ApiError('apple_disabled', 'Apple sign-in is not configured');
    const c = await this.jwt.verifySignature(identityToken);
    if (c.iss !== APPLE_ISSUER) throw invalid('wrong issuer');
    this.jwt.checkAudience(c, this.opts.clientIds);
    this.jwt.checkTimes(c);
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw invalid('no subject');
    // email_verified у Apple бывает строкой 'true'; неподтверждённую почту не берём (вход по sub всё равно годен)
    const verified = c.email_verified === undefined || c.email_verified === true || c.email_verified === 'true';
    const email = typeof c.email === 'string' && c.email && verified ? c.email.slice(0, 254) : null;
    return { sub: c.sub, email, name: null };
  }
}
