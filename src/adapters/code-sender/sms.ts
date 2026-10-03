import { logger } from '../../common/logging/logger.js';
import type { CodeMessage, CodeSender } from './code-sender.js';

/**
 * SMS для кода входа (03.10.2026). Провайдер — за интерфейсом SmsProvider: первый — Twilio Programmable Messaging,
 * армянский провайдер добавляется своим классом и значением SMS_PROVIDER. SMS — самый дорогой канал и цель накрутки
 * (SMS pumping), поэтому: последний в порядке каналов, только номера из SMS_ALLOWED_PREFIXES, свои лимиты в OtpService.
 */
export interface SmsProvider {
  readonly name: string;
  /** Отправить текст. Вернуть id сообщения у провайдера. Ошибка — исключение. */
  sendSms(to: string, text: string): Promise<{ id?: string }>;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Номер или Alphanumeric Sender ID ('BookTime') — если не задан Messaging Service */
  from?: string;
  /** Messaging Service SID (MG…) — предпочтительнее: пул отправителей, Geo permissions, защита от SMS pumping */
  messagingServiceSid?: string;
}

/** Twilio Programmable Messaging: POST /2010-04-01/Accounts/<SID>/Messages.json (form-urlencoded, Basic auth) */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(
    private readonly config: TwilioConfig,
    private readonly baseUrl = 'https://api.twilio.com',
  ) {}

  /** Поля формы — отдельно, чтобы проверять в тестах без сети */
  form(to: string, text: string): URLSearchParams {
    const form = new URLSearchParams({ To: to, Body: text });
    if (this.config.messagingServiceSid) form.set('MessagingServiceSid', this.config.messagingServiceSid);
    else if (this.config.from) form.set('From', this.config.from);
    return form;
  }

  async sendSms(to: string, text: string): Promise<{ id?: string }> {
    const { accountSid, authToken } = this.config;
    const res = await fetch(`${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.form(to, text),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok || !body.sid) throw new Error(`Twilio: ${body.code ?? res.status} ${body.message ?? ''}`.trim());
    return { id: body.sid };
  }
}

/** Номер разрешён для SMS: начинается с одного из префиксов ('+374') */
export function smsAllowed(phone: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => phone.startsWith(p));
}

/** Канал «SMS» кода входа поверх любого SmsProvider; текст — готовый на языке человека (auth.code в i18n) */
export class SmsCodeSender implements CodeSender {
  readonly channel = 'sms' as const;
  readonly real = true;
  readonly enabled = true;
  constructor(
    private readonly provider: SmsProvider,
    private readonly allowedPrefixes: readonly string[],
  ) {}

  accepts(phone: string): boolean {
    return smsAllowed(phone, this.allowedPrefixes);
  }

  async send({ phone, text }: CodeMessage): Promise<{ providerMessageId?: string }> {
    if (!smsAllowed(phone, this.allowedPrefixes)) throw new Error('SMS: country not allowed');
    try {
      const sent = await this.provider.sendSms(phone, text);
      return { providerMessageId: sent.id };
    } catch (err) {
      logger.warn({ provider: this.provider.name, phone: `${phone.slice(0, 6)}•••${phone.slice(-2)}`, err: (err as Error).message }, 'sms: not sent');
      throw err;
    }
  }
}

export interface SmsEnv {
  SMS_PROVIDER?: 'twilio';
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
}

/** Провайдер по env; не выбран или не хватает ключей — null (канал SMS выключен) */
export function createSmsProvider(e: SmsEnv): SmsProvider | null {
  if (e.SMS_PROVIDER === 'twilio') {
    if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !(e.TWILIO_FROM || e.TWILIO_MESSAGING_SERVICE_SID)) {
      logger.warn('SMS_PROVIDER=twilio, but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM|TWILIO_MESSAGING_SERVICE_SID missing — SMS disabled');
      return null;
    }
    return new TwilioSmsProvider({
      accountSid: e.TWILIO_ACCOUNT_SID,
      authToken: e.TWILIO_AUTH_TOKEN,
      from: e.TWILIO_FROM,
      messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID,
    });
  }
  return null;
}
