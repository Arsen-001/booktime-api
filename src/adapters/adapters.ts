import { FakeBusinessMessenger, type BusinessMessenger } from './business-sms/business-sms.js';
import { env } from '../common/config/env.js';
import {
  FakeCodeSender,
  TelegramGatewaySender,
  WhatsAppCloudSender,
  type CodeChannel,
  type CodeSender,
} from './code-sender/code-sender.js';
import { createSmsProvider, SmsCodeSender } from './code-sender/sms.js';
import { FakeMailSender, type MailSender } from './mail/mail.js';
import { FakePaymentProvider, type PaymentProvider } from './payments/payments.js';
import { createPushSenders, type PushSenders } from './push/push.js';
import { createFileStorage, createPrivateUploadStorage, createUploadStorage, type FileStorage } from './storage/storage.js';
import { createTelegramBot, type TelegramBot } from './telegram-bot/telegram-bot.js';

/** «Розетки» внешних сервисов (PLAN.md Р14): внедряются по токенам, этапы заменяют заглушки настоящими */
export const CODE_SENDERS = Symbol('CODE_SENDERS');
export const PUSH_SENDERS = Symbol('PUSH_SENDERS');
export const MAIL_SENDER = Symbol('MAIL_SENDER');
export const PAYMENTS = Symbol('PAYMENTS');
export const BUSINESS_MESSENGER = Symbol('BUSINESS_MESSENGER');
export const FILE_STORAGE = Symbol('FILE_STORAGE');
/** Хранилище фото (диск UPLOADS_DIR или S3) — 04.10.2026 */
export const UPLOAD_STORAGE = Symbol('UPLOAD_STORAGE');
/** Закрытое хранилище документов клиентов (наружу не раздаётся) — 04.10.2026 */
export const PRIVATE_STORAGE = Symbol('PRIVATE_STORAGE');
export const TELEGRAM_BOT = Symbol('TELEGRAM_BOT');

export type CodeSenders = Record<CodeChannel, CodeSender>;

export const adapterProviders = [
  {
    provide: CODE_SENDERS,
    useFactory: (): CodeSenders => ({
      // Telegram без токена — заглушка, но включённая: разработка и DEV_LOGIN_CODE работают как раньше
      telegram: env.TELEGRAM_GATEWAY_TOKEN ? new TelegramGatewaySender(env.TELEGRAM_GATEWAY_TOKEN) : new FakeCodeSender('telegram', true),
      // WhatsApp без настроек выключен: не предлагается и не используется как запасной
      whatsapp:
        env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
          ? new WhatsAppCloudSender({
              token: env.WHATSAPP_TOKEN,
              phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
              templateName: env.WHATSAPP_TEMPLATE_NAME,
              languages: env.WHATSAPP_TEMPLATE_LANGS,
              apiVersion: env.WHATSAPP_API_VERSION,
            })
          : new FakeCodeSender('whatsapp'),
      // SMS — провайдер по SMS_PROVIDER (Twilio); без него выключен
      sms: ((p) => (p ? new SmsCodeSender(p, env.SMS_ALLOWED_PREFIXES) : new FakeCodeSender('sms')))(createSmsProvider(env)),
    }),
  },
  { provide: PUSH_SENDERS, useFactory: (): PushSenders => createPushSenders() },
  { provide: MAIL_SENDER, useFactory: (): MailSender => new FakeMailSender() },
  { provide: PAYMENTS, useFactory: (): PaymentProvider => new FakePaymentProvider() },
  { provide: BUSINESS_MESSENGER, useFactory: (): BusinessMessenger => new FakeBusinessMessenger() },
  { provide: FILE_STORAGE, useFactory: (): FileStorage => createFileStorage() },
  { provide: UPLOAD_STORAGE, useFactory: (): FileStorage => createUploadStorage() },
  { provide: PRIVATE_STORAGE, useFactory: (): FileStorage => createPrivateUploadStorage() },
  { provide: TELEGRAM_BOT, useFactory: (): TelegramBot => createTelegramBot() },
];
