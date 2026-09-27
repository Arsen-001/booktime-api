import { logger } from '../../common/logging/logger.js';

/** Пуш (docs/backend/05): Web Push и FCM настоящие — этап 10; до него заглушка */
export interface PushMessage {
  title: string;
  body: string;
  /** Куда ведёт тап: путь сайта */
  url?: string;
}

export interface PushSender {
  readonly kind: 'webpush' | 'fcm' | 'fake';
  /** false — токен больше не действует (удалить подписку) */
  send(token: string, message: PushMessage): Promise<boolean>;
}

export class FakePushSender implements PushSender {
  readonly kind = 'fake' as const;
  async send(token: string, message: PushMessage): Promise<boolean> {
    logger.info({ token: token.slice(0, 8) }, `[fake push] ${message.title}: ${message.body}`);
    return true;
  }
}
