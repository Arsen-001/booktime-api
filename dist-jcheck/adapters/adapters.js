import { FakeBusinessMessenger } from './business-sms/business-sms.js';
import { env } from '../common/config/env.js';
import { FakeCodeSender, TelegramGatewaySender } from './code-sender/code-sender.js';
import { FakeMailSender } from './mail/mail.js';
import { FakePaymentProvider } from './payments/payments.js';
import { createPushSenders } from './push/push.js';
import { createFileStorage } from './storage/storage.js';
/** «Розетки» внешних сервисов (PLAN.md Р14): внедряются по токенам, этапы заменяют заглушки настоящими */
export const CODE_SENDERS = Symbol('CODE_SENDERS');
export const PUSH_SENDERS = Symbol('PUSH_SENDERS');
export const MAIL_SENDER = Symbol('MAIL_SENDER');
export const PAYMENTS = Symbol('PAYMENTS');
export const BUSINESS_MESSENGER = Symbol('BUSINESS_MESSENGER');
export const FILE_STORAGE = Symbol('FILE_STORAGE');
export const adapterProviders = [
    {
        provide: CODE_SENDERS,
        useFactory: () => ({
            telegram: env.TELEGRAM_GATEWAY_TOKEN ? new TelegramGatewaySender(env.TELEGRAM_GATEWAY_TOKEN) : new FakeCodeSender('telegram'),
            whatsapp: new FakeCodeSender('whatsapp'),
            sms: new FakeCodeSender('sms'),
        }),
    },
    { provide: PUSH_SENDERS, useFactory: () => createPushSenders() },
    { provide: MAIL_SENDER, useFactory: () => new FakeMailSender() },
    { provide: PAYMENTS, useFactory: () => new FakePaymentProvider() },
    { provide: BUSINESS_MESSENGER, useFactory: () => new FakeBusinessMessenger() },
    { provide: FILE_STORAGE, useFactory: () => createFileStorage() },
];
//# sourceMappingURL=adapters.js.map