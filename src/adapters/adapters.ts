import { FakeBusinessMessenger, type BusinessMessenger } from './business-sms/business-sms.js';
import { env } from '../common/config/env.js';
import { FakeCodeSender, TelegramGatewaySender, type CodeChannel, type CodeSender } from './code-sender/code-sender.js';
import { FakeMailSender, type MailSender } from './mail/mail.js';
import { FakePaymentProvider, type PaymentProvider } from './payments/payments.js';
import { createPushSenders, type PushSenders } from './push/push.js';
import { createFileStorage, type FileStorage } from './storage/storage.js';
import { createTelegramBot, type TelegramBot } from './telegram-bot/telegram-bot.js';

/** «Розетки» внешних сервисов (PLAN.md Р14): внедряются по токенам, этапы заменяют заглушки настоящими */
export const CODE_SENDERS = Symbol('CODE_SENDERS');
export const PUSH_SENDERS = Symbol('PUSH_SENDERS');
export const MAIL_SENDER = Symbol('MAIL_SENDER');
export const PAYMENTS = Symbol('PAYMENTS');
export const BUSINESS_MESSENGER = Symbol('BUSINESS_MESSENGER');
export const FILE_STORAGE = Symbol('FILE_STORAGE');
export const TELEGRAM_BOT = Symbol('TELEGRAM_BOT');

export type CodeSenders = Record<CodeChannel, CodeSender>;

export const adapterProviders = [
  {
    provide: CODE_SENDERS,
    useFactory: (): CodeSenders => ({
      telegram: env.TELEGRAM_GATEWAY_TOKEN ? new TelegramGatewaySender(env.TELEGRAM_GATEWAY_TOKEN) : new FakeCodeSender('telegram'),
      whatsapp: new FakeCodeSender('whatsapp'),
      sms: new FakeCodeSender('sms'),
    }),
  },
  { provide: PUSH_SENDERS, useFactory: (): PushSenders => createPushSenders() },
  { provide: MAIL_SENDER, useFactory: (): MailSender => new FakeMailSender() },
  { provide: PAYMENTS, useFactory: (): PaymentProvider => new FakePaymentProvider() },
  { provide: BUSINESS_MESSENGER, useFactory: (): BusinessMessenger => new FakeBusinessMessenger() },
  { provide: FILE_STORAGE, useFactory: (): FileStorage => createFileStorage() },
  { provide: TELEGRAM_BOT, useFactory: (): TelegramBot => createTelegramBot() },
];
