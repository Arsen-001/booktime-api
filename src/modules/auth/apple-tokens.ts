import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { env } from '../../common/config/env.js';
import { SecretBox } from '../../common/crypto/secret-box.js';
import { logger } from '../../common/logging/logger.js';
import { APPLE_ISSUER } from './apple-id-token.js';

/**
 * Отзыв «Войти через Apple» при удалении аккаунта (04.10.2026, App Store 5.1.1(v)).
 * - Вход: приложение присылает одноразовый authorizationCode (живёт 5 минут) → POST /auth/token меняет его на
 *   refresh token → он хранится зашифрованным (SecretBox, SECRETS_KEY) на строке user_identities.
 * - Удаление аккаунта (jobs/auth-housekeeping.ts): POST /auth/revoke с этим токеном — Apple убирает BookTime из
 *   «Приложения, использующие Apple ID» у человека.
 * client_secret — JWT ES256 ключом Sign in with Apple (.p8): iss — Team ID, sub — client_id (bundle id / Services ID,
 * тот же, что aud у identity token), aud — https://appleid.apple.com, срок — 10 минут (Apple разрешает до 6 месяцев).
 * Всё — по возможности: нет ключа, Apple недоступен — вход и удаление идут дальше, в лог — предупреждение.
 * https://developer.apple.com/documentation/sign_in_with_apple/revoke_tokens
 */
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const CLIENT_SECRET_TTL_SEC = 600;

export interface AppleKeyConfig {
  teamId: string;
  keyId: string;
  /** Содержимое .p8 (PKCS#8, EC P-256) */
  privateKey: string;
}

/** Ключ Apple из переменных: все три заданы — конфиг, иначе null (отзыв выключен) */
export function appleKeyConfig(e: { APPLE_TEAM_ID?: string; APPLE_KEY_ID?: string; APPLE_PRIVATE_KEY?: string } = env): AppleKeyConfig | null {
  if (!e.APPLE_TEAM_ID || !e.APPLE_KEY_ID || !e.APPLE_PRIVATE_KEY) return null;
  return { teamId: e.APPLE_TEAM_ID, keyId: e.APPLE_KEY_ID, privateKey: e.APPLE_PRIVATE_KEY };
}

/** client_secret для /auth/token и /auth/revoke: JWT ES256 (подпись r||s, как требует JWS) */
export function appleClientSecret(cfg: AppleKeyConfig, clientId: string, nowMs: number, key?: KeyObject): string {
  const iat = Math.floor(nowMs / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' })}.${enc({ iss: cfg.teamId, iat, exp: iat + CLIENT_SECRET_TTL_SEC, aud: APPLE_ISSUER, sub: clientId })}`;
  const sig = sign('sha256', Buffer.from(input), { key: key ?? createPrivateKey(cfg.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

/** Сохранённый вход Apple: зашифрованный refresh token и client_id, которым он выдан */
export interface StoredAppleToken {
  refreshTokenEnc: string;
  clientId: string;
}

export interface AppleTokenClientOptions {
  key: AppleKeyConfig | null;
  box: SecretBox | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export class AppleTokenClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private keyObject: KeyObject | null = null;
  private warned = false;

  constructor(private readonly opts: AppleTokenClientOptions) {
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
  }

  /** Есть ключ Apple и ключ шифрования — можно сохранять и отзывать */
  get enabled(): boolean {
    return Boolean(this.opts.key && this.opts.box);
  }

  private warnDisabled(what: string): void {
    if (this.warned) return;
    this.warned = true;
    const missing = [!this.opts.key && 'APPLE_TEAM_ID/APPLE_KEY_ID/APPLE_PRIVATE_KEY', !this.opts.box && 'SECRETS_KEY'].filter(Boolean).join(', ');
    logger.warn({ missing }, `apple tokens: ${what} skipped — not configured`);
  }

  private secret(clientId: string): string {
    const key = this.opts.key!;
    this.keyObject ??= createPrivateKey(key.privateKey);
    return appleClientSecret(key, clientId, this.now(), this.keyObject);
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    return this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(8000),
    });
  }

  /**
   * Вход: authorizationCode → refresh token (зашифрованный). Не настроено, код просрочен, Apple недоступен — null и
   * предупреждение в лог; вход от этого не зависит.
   */
  async exchangeCode(code: string, clientId: string): Promise<StoredAppleToken | null> {
    if (!this.enabled) {
      this.warnDisabled('code exchange');
      return null;
    }
    try {
      const res = await this.post(APPLE_TOKEN_URL, {
        client_id: clientId,
        client_secret: this.secret(clientId),
        code,
        grant_type: 'authorization_code',
      });
      const body = (await res.json().catch(() => ({}))) as { refresh_token?: unknown; error?: unknown };
      if (!res.ok || typeof body.refresh_token !== 'string' || !body.refresh_token) {
        logger.warn({ status: res.status, error: typeof body.error === 'string' ? body.error : undefined }, 'apple tokens: code exchange failed');
        return null;
      }
      return { refreshTokenEnc: this.opts.box!.seal(body.refresh_token), clientId };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'apple tokens: code exchange failed');
      return null;
    }
  }

  /**
   * Удаление аккаунта: отозвать сохранённый вход. 'skipped' — не настроено или токен не расшифровать (предупреждение);
   * Apple ответил ошибкой или недоступен — бросает (очередь повторит).
   */
  async revoke(t: StoredAppleToken): Promise<'revoked' | 'skipped'> {
    if (!this.enabled) {
      this.warnDisabled('revoke');
      return 'skipped';
    }
    const token = this.opts.box!.open(t.refreshTokenEnc);
    if (!token) {
      logger.warn({ clientId: t.clientId }, 'apple tokens: stored token cannot be decrypted (SECRETS_KEY changed?) — revoke skipped');
      return 'skipped';
    }
    const res = await this.post(APPLE_REVOKE_URL, {
      client_id: t.clientId,
      client_secret: this.secret(t.clientId),
      token,
      token_type_hint: 'refresh_token',
    });
    if (!res.ok) throw new Error(`apple revoke HTTP ${res.status}`);
    return 'revoked';
  }
}

/** Клиент по переменным окружения (API и воркер) */
export function createAppleTokenClient(): AppleTokenClient {
  return new AppleTokenClient({ key: appleKeyConfig(), box: SecretBox.fromEnv(env.SECRETS_KEY) });
}
