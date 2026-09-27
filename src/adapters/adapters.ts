import { FakeBusinessMessenger, type BusinessMessenger } from './business-sms/business-sms.js';
import { FakeCodeSender, type CodeChannel, type CodeSender } from './code-sender/code-sender.js';
import { FakeMailSender, type MailSender } from './mail/mail.js';
import { FakePaymentProvider, type PaymentProvider } from './payments/payments.js';
import { FakePushSender, type PushSender } from './push/push.js';
import { createFileStorage, type FileStorage } from './storage/storage.js';

/** «Розетки» внешних сервисов (PLAN.md Р14): внедряются по токенам, этапы заменяют заглушки настоящими */
export const CODE_SENDERS = Symbol('CODE_SENDERS');
export const PUSH_SENDER = Symbol('PUSH_SENDER');
export const MAIL_SENDER = Symbol('MAIL_SENDER');
export const PAYMENTS = Symbol('PAYMENTS');
export const BUSINESS_MESSENGER = Symbol('BUSINESS_MESSENGER');
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export type CodeSenders = Record<CodeChannel, CodeSender>;

export const adapterProviders = [
  {
    provide: CODE_SENDERS,
    useFactory: (): CodeSenders => ({
      telegram: new FakeCodeSender('telegram'),
      whatsapp: new FakeCodeSender('whatsapp'),
      sms: new FakeCodeSender('sms'),
    }),
  },
  { provide: PUSH_SENDER, useFactory: (): PushSender => new FakePushSender() },
  { provide: MAIL_SENDER, useFactory: (): MailSender => new FakeMailSender() },
  { provide: PAYMENTS, useFactory: (): PaymentProvider => new FakePaymentProvider() },
  { provide: BUSINESS_MESSENGER, useFactory: (): BusinessMessenger => new FakeBusinessMessenger() },
  { provide: FILE_STORAGE, useFactory: (): FileStorage => createFileStorage() },
];
