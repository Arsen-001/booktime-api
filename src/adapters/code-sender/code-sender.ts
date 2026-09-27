import { logger } from '../../common/logging/logger.js';

/**
 * Отправка кода входа (PLAN.md Р14, docs/backend/05 §6). Telegram Gateway — настоящий (если задан
 * TELEGRAM_GATEWAY_TOKEN); WhatsApp и SMS — заглушки, пока не выбран провайдер (E7).
 */
export type CodeChannel = 'telegram' | 'whatsapp' | 'sms';

export interface CodeMessage {
  /** '+374XXXXXXXX' */
  phone: string;
  /** Сам код — Telegram Gateway показывает его своим шаблоном */
  code: string;
  /** Готовый текст на языке человека — для каналов, где текст пишем мы (SMS, WhatsApp-шаблон) */
  text: string;
  /** Сколько секунд код действует */
  ttlSec: number;
}

export interface CodeSender {
  readonly channel: CodeChannel;
  readonly real: boolean;
  /** Отправить код. Вернуть id сообщения у провайдера (если есть). Ошибка доставки — исключение. */
  send(message: CodeMessage): Promise<{ providerMessageId?: string }>;
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 6)}•••${phone.slice(-2)}`;
}

/** Заглушка: пишет в лог (номер маскируется, код — нет: заглушка стоит только там, где нет провайдера) */
export class FakeCodeSender implements CodeSender {
  readonly real = false;
  constructor(readonly channel: CodeChannel) {}
  async send({ phone, text }: CodeMessage): Promise<{ providerMessageId?: string }> {
    logger.info({ channel: this.channel, phone: maskPhone(phone) }, `[fake code-sender] ${text}`);
    return {};
  }
}

/**
 * Telegram Gateway API (https://core.telegram.org/gateway/api): sendVerificationMessage с нашим кодом.
 * Код генерирует и проверяет наш сервер (хэш в otp_requests), Telegram только доставляет.
 */
export class TelegramGatewaySender implements CodeSender {
  readonly channel = 'telegram' as const;
  readonly real = true;
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://gatewayapi.telegram.org',
  ) {}

  async send({ phone, code, ttlSec }: CodeMessage): Promise<{ providerMessageId?: string }> {
    const res = await fetch(`${this.baseUrl}/sendVerificationMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: phone, code, ttl: ttlSec }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: { request_id?: string } };
    if (!res.ok || !body.ok) {
      logger.warn({ phone: maskPhone(phone), status: res.status, error: body.error }, 'telegram gateway: not sent');
      throw new Error(`Telegram Gateway: ${body.error ?? res.status}`);
    }
    return { providerMessageId: body.result?.request_id };
  }
}
