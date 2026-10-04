import type { Locale } from '../../common/i18n/i18n.js';
import { logger } from '../../common/logging/logger.js';

/**
 * Отправка кода входа (PLAN.md Р14, docs/backend/05 §6). Telegram Gateway — настоящий (если задан
 * TELEGRAM_GATEWAY_TOKEN, без него — заглушка в лог, канал остаётся включённым для разработки).
 * WhatsApp Business Cloud API — настоящий, если заданы WHATSAPP_TOKEN и WHATSAPP_PHONE_NUMBER_ID; без них канал выключен.
 * SMS — для кода входа выключен (владелец 04.10.2026: только Telegram и WhatsApp), см. adapters.ts.
 */
export type CodeChannel = 'telegram' | 'whatsapp' | 'sms';

/** Порядок каналов по умолчанию (решение 03.10.2026): Telegram бесплатный → WhatsApp → SMS */
export const CODE_CHANNEL_ORDER: readonly CodeChannel[] = ['telegram', 'whatsapp', 'sms'];

export interface CodeMessage {
  /** '+374XXXXXXXX' */
  phone: string;
  /** Сам код — Telegram Gateway показывает его своим шаблоном */
  code: string;
  /** Готовый текст на языке человека — для каналов, где текст пишем мы (SMS, WhatsApp-шаблон) */
  text: string;
  /** Сколько секунд код действует */
  ttlSec: number;
  /** Язык человека — WhatsApp выбирает по нему перевод шаблона */
  locale: Locale;
}

export interface CodeSender {
  readonly channel: CodeChannel;
  readonly real: boolean;
  /** Канал можно предлагать людям и использовать как запасной (выключенный — только явная заглушка) */
  readonly enabled: boolean;
  /** Канал может доставить на этот номер (SMS — только разрешённые страны); нет метода — любой номер */
  accepts?(phone: string): boolean;
  /** Отправить код. Вернуть id сообщения у провайдера (если есть). Ошибка доставки — исключение. */
  send(message: CodeMessage): Promise<{ providerMessageId?: string }>;
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 6)}•••${phone.slice(-2)}`;
}

/** Заглушка: пишет в лог (номер маскируется, код — нет: заглушка стоит только там, где нет провайдера) */
export class FakeCodeSender implements CodeSender {
  readonly real = false;
  constructor(
    readonly channel: CodeChannel,
    readonly enabled = false,
  ) {}
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
  readonly enabled = true;
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

export interface WhatsAppConfig {
  /** Постоянный токен системного пользователя Meta Business */
  token: string;
  /** Phone number ID из WhatsApp Manager (не сам номер) */
  phoneNumberId: string;
  /** Имя одобренного шаблона категории AUTHENTICATION с кнопкой «Copy code» */
  templateName: string;
  /** Языки, на которых шаблон одобрен; первый — запасной, если языка человека нет */
  languages: readonly string[];
  /** Версия Graph API, 'v23.0' */
  apiVersion: string;
}

/** Язык шаблона по локали человека: точное совпадение ('ru'), затем вариант ('en_US' для 'en'), иначе первый из списка */
export function whatsappLanguage(locale: Locale, languages: readonly string[]): string {
  return (
    languages.find((l) => l === locale) ??
    languages.find((l) => l.split('_')[0] === locale) ??
    languages[0] ??
    'en'
  );
}

/**
 * WhatsApp Business Cloud API (https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates):
 * POST /<версия>/<PHONE_NUMBER_ID>/messages с шаблоном AUTHENTICATION. Текст шаблона задаёт Meta («<код> — ваш код
 * подтверждения…»), мы передаём код дважды: в тело и в параметр кнопки «Copy code» (url-кнопка с индексом 0).
 * Ответ 200 значит «принято к отправке»; если у номера нет WhatsApp, Meta сообщит об этом позже вебхуком (131026) —
 * синхронно ловим только ошибки API. Для этого на экране кода есть кнопка «Прислать в Telegram».
 */
export class WhatsAppCloudSender implements CodeSender {
  readonly channel = 'whatsapp' as const;
  readonly real = true;
  readonly enabled = true;
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  /** Тело запроса — отдельно, чтобы проверять его в тестах без сети */
  body({ phone, code, locale }: Pick<CodeMessage, 'phone' | 'code' | 'locale'>) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: this.config.templateName,
        language: { code: whatsappLanguage(locale, this.config.languages) },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    };
  }

  async send(message: CodeMessage): Promise<{ providerMessageId?: string }> {
    const { apiVersion, phoneNumberId, token } = this.config;
    const res = await fetch(`${this.baseUrl}/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.body(message)),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { message?: string; code?: number };
    };
    const id = body.messages?.[0]?.id;
    if (!res.ok || body.error || !id) {
      logger.warn({ phone: maskPhone(message.phone), status: res.status, error: body.error?.message, code: body.error?.code }, 'whatsapp: not sent');
      throw new Error(`WhatsApp: ${body.error?.code ?? res.status} ${body.error?.message ?? ''}`.trim());
    }
    return { providerMessageId: id };
  }
}

/** Каналы, которые можно предлагать человеку с этим номером, в порядке по умолчанию */
export function enabledChannels(senders: Record<CodeChannel, CodeSender>, phone: string): CodeChannel[] {
  return CODE_CHANNEL_ORDER.filter((c) => senders[c].enabled && (senders[c].accepts?.(phone) ?? true));
}

/**
 * Куда пробовать слать код: сначала запрошенный канал (если включён), затем остальные включённые по порядку.
 * Запрошенный выключенный канал (WhatsApp/SMS без настроек, SMS на номер чужой страны) не пробуется — человек получит код туда, где он работает.
 */
export function deliveryOrder(senders: Record<CodeChannel, CodeSender>, phone: string, requested?: CodeChannel): CodeChannel[] {
  const enabled = enabledChannels(senders, phone);
  return requested && enabled.includes(requested) ? [requested, ...enabled.filter((c) => c !== requested)] : enabled;
}

/**
 * Доставить один и тот же код: по каналам из deliveryOrder, при ошибке — следующий (Telegram Gateway не доставил,
 * например у номера нет Telegram → WhatsApp). Все каналы отказали — исключение с последней ошибкой.
 */
export async function deliverCode(
  senders: Record<CodeChannel, CodeSender>,
  order: readonly CodeChannel[],
  message: CodeMessage,
): Promise<{ channel: CodeChannel; providerMessageId?: string; failed: CodeChannel[] }> {
  const failed: CodeChannel[] = [];
  let lastError: unknown = new Error('No code channel enabled');
  for (const channel of order) {
    try {
      const sent = await senders[channel].send(message);
      return { channel, providerMessageId: sent.providerMessageId, failed };
    } catch (err) {
      failed.push(channel);
      lastError = err;
      logger.warn({ channel, phone: maskPhone(message.phone), err: (err as Error).message }, 'code channel failed, trying next');
    }
  }
  throw lastError;
}
