import crypto from 'node:crypto';
import webpush from 'web-push';
import { env } from '../../common/config/env.js';
import { logger } from '../../common/logging/logger.js';

/** Пуш (docs/backend/05, PLAN.md Р14): Web Push и FCM — настоящие, если заданы ключи; иначе заглушка в лог. */
export interface PushMessage {
  title: string;
  body: string;
  /** Куда ведёт тап: путь сайта */
  url?: string;
}

/** Что нужно, чтобы доставить конкретному токену: web — вся подписка (endpoint+keys), fcm — сам токен */
export interface PushTarget {
  token: string;
  subscription?: unknown;
}

export interface PushSender {
  readonly kind: 'webpush' | 'fcm' | 'fake';
  /** false — токен больше не действует (удалить подписку) */
  send(target: PushTarget, message: PushMessage): Promise<boolean>;
}

/** По платформе токена (PushToken.platform) — web идёт через Web Push, android/ios — через FCM (FCM мостит APNs) */
export interface PushSenders {
  web: PushSender;
  fcm: PushSender;
}

export class FakePushSender implements PushSender {
  readonly kind = 'fake' as const;
  async send(target: PushTarget, message: PushMessage): Promise<boolean> {
    logger.info({ token: target.token.slice(0, 8) }, `[fake push] ${message.title}: ${message.body}`);
    return true;
  }
}

/** Web Push (VAPID, RFC 8030) — доставляет напрямую в браузер получателя, ключ сервера не палит личность отправителя */
export class WebPushSender implements PushSender {
  readonly kind = 'webpush' as const;

  constructor(publicKey: string, privateKey: string, subject: string) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }

  async send(target: PushTarget, message: PushMessage): Promise<boolean> {
    if (!target.subscription) {
      logger.warn({ token: target.token.slice(0, 8) }, 'webpush: подписки нет у токена, отправить нечем');
      return false;
    }
    try {
      await webpush.sendNotification(target.subscription as webpush.PushSubscription, JSON.stringify(message));
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 — подписка браузера отозвана/устарела (пользователь снял разрешение, переустановил); остальное — сбой сети/сервиса
      if (status === 404 || status === 410) return false;
      logger.error({ err, status }, 'webpush: отправка не удалась');
      return false;
    }
  }
}

/**
 * FCM HTTP v1 (Firebase Cloud Messaging) — доставляет на Android напрямую и на iOS через мост APNs самого FCM.
 * Без лишней зависимости: OAuth2 JWT-Bearer подписываем сами (node:crypto RSA-SHA256), как описывает Google —
 * `firebase-admin` целиком нам не нужен, только messages:send.
 */
export class FcmSender implements PushSender {
  readonly kind = 'fcm' as const;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly projectId: string,
    private readonly clientEmail: string,
    private readonly privateKey: string,
  ) {}

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) return this.cachedToken.value;
    const iat = Math.floor(now / 1000);
    const claims = {
      iss: this.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    };
    const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}`;
    // Ключ сервисного аккаунта хранится в env одной строкой; \n там часто экранирован буквально
    const key = this.privateKey.includes('\\n') ? this.privateKey.replace(/\\n/g, '\n') : this.privateKey;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
    const assertion = `${unsigned}.${signature}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`FCM OAuth2 token: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(target: PushTarget, message: PushMessage): Promise<boolean> {
    try {
      const accessToken = await this.accessToken();
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: target.token,
            notification: { title: message.title, body: message.body },
            ...(message.url ? { webpush: { fcm_options: { link: message.url } }, data: { url: message.url } } : {}),
          },
        }),
      });
      if (res.ok) return true;
      const text = await res.text();
      // UNREGISTERED/INVALID_ARGUMENT на битый токен — не сбой сети, токен больше не действует
      if (res.status === 404 || (res.status === 400 && text.includes('UNREGISTERED'))) return false;
      logger.error({ status: res.status, text }, 'fcm: отправка не удалась');
      return false;
    } catch (err) {
      logger.error({ err }, 'fcm: отправка не удалась');
      return false;
    }
  }
}

/** Настоящие отправители — если заданы ключи (Р14: «розетка + заглушка», как CODE_SENDERS у Telegram Gateway) */
export function createPushSenders(): PushSenders {
  const web =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? new WebPushSender(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT)
      : new FakePushSender();
  const fcm =
    env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY
      ? new FcmSender(env.FCM_PROJECT_ID, env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY)
      : new FakePushSender();
  return { web, fcm };
}
