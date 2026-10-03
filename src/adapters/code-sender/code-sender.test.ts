/** Каналы кода входа: порядок, запасной канал, тела запросов WhatsApp и Twilio. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { deliverCode, deliveryOrder, enabledChannels, FakeCodeSender, WhatsAppCloudSender, whatsappLanguage } = await import('./code-sender.js');
const { SmsCodeSender, TwilioSmsProvider, createSmsProvider } = await import('./sms.js');
type CodeSender = import('./code-sender.js').CodeSender;
type CodeChannel = import('./code-sender.js').CodeChannel;

const AM = '+37491123456';
const msg = { phone: AM, code: '1234', text: 'Код BookTime: 1234', ttlSec: 300, locale: 'ru' as const };

/** Канал-болванка: включён/выключен, доставляет или падает, считает вызовы */
function stub(channel: CodeChannel, enabled: boolean, fails = false, accepts?: (p: string) => boolean) {
  const calls: string[] = [];
  const sender: CodeSender & { calls: string[] } = {
    channel,
    real: true,
    enabled,
    calls,
    ...(accepts ? { accepts } : {}),
    async send(m) {
      calls.push(m.code);
      if (fails) throw new Error(`${channel} down`);
      return { providerMessageId: `${channel}-1` };
    },
  };
  return sender;
}

test('порядок: по умолчанию Telegram → WhatsApp → SMS, выключенные не участвуют', () => {
  const all = { telegram: stub('telegram', true), whatsapp: stub('whatsapp', true), sms: stub('sms', true) };
  assert.deepEqual(deliveryOrder(all, AM), ['telegram', 'whatsapp', 'sms']);
  assert.deepEqual(deliveryOrder(all, AM, 'telegram'), ['telegram', 'whatsapp', 'sms']);
  assert.deepEqual(deliveryOrder(all, AM, 'whatsapp'), ['whatsapp', 'telegram', 'sms']);
  assert.deepEqual(deliveryOrder(all, AM, 'sms'), ['sms', 'telegram', 'whatsapp']);

  const tgOnly = { telegram: new FakeCodeSender('telegram', true), whatsapp: new FakeCodeSender('whatsapp'), sms: new FakeCodeSender('sms') };
  assert.deepEqual(enabledChannels(tgOnly, AM), ['telegram']);
  // Запросили выключенный WhatsApp — код всё равно уйдёт в Telegram
  assert.deepEqual(deliveryOrder(tgOnly, AM, 'whatsapp'), ['telegram']);
});

test('SMS только на разрешённые номера', () => {
  const sms = new SmsCodeSender({ name: 'x', sendSms: async () => ({ id: 's' }) }, ['+374']);
  const senders = { telegram: stub('telegram', true), whatsapp: stub('whatsapp', false), sms };
  assert.deepEqual(enabledChannels(senders, AM), ['telegram', 'sms']);
  assert.deepEqual(enabledChannels(senders, '+79001234567'), ['telegram']);
  assert.deepEqual(deliveryOrder(senders, '+79001234567', 'sms'), ['telegram']);
});

test('запасной канал: Telegram не доставил → тот же код в WhatsApp', async () => {
  const s = { telegram: stub('telegram', true, true), whatsapp: stub('whatsapp', true), sms: stub('sms', true) };
  const sent = await deliverCode(s, deliveryOrder(s, AM), msg);
  assert.equal(sent.channel, 'whatsapp');
  assert.equal(sent.providerMessageId, 'whatsapp-1');
  assert.deepEqual(sent.failed, ['telegram']);
  assert.deepEqual(s.telegram.calls, ['1234']);
  assert.deepEqual(s.whatsapp.calls, ['1234']);
  assert.deepEqual(s.sms.calls, []);
});

test('все каналы отказали — исключение, ни одного лишнего канала', async () => {
  const s = { telegram: stub('telegram', true, true), whatsapp: stub('whatsapp', false), sms: stub('sms', true, true) };
  await assert.rejects(deliverCode(s, deliveryOrder(s, AM), msg), /sms down/);
  assert.deepEqual(s.whatsapp.calls, []);
});

test('WhatsApp: язык шаблона по локали, иначе первый из списка', () => {
  assert.equal(whatsappLanguage('ru', ['ru', 'en']), 'ru');
  assert.equal(whatsappLanguage('hy', ['ru', 'en']), 'ru');
  assert.equal(whatsappLanguage('en', ['ru', 'en_US']), 'en_US');
  assert.equal(whatsappLanguage('hy', ['ru', 'hy', 'en']), 'hy');
});

test('WhatsApp: шаблон authentication — код в теле и в кнопке copy code', async () => {
  const wa = new WhatsAppCloudSender({ token: 'T', phoneNumberId: '123', templateName: 'booktime_login_code', languages: ['ru', 'en'], apiVersion: 'v23.0' });
  const body = wa.body({ phone: AM, code: '1234', locale: 'en' });
  assert.equal(body.to, '37491123456');
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'booktime_login_code');
  assert.deepEqual(body.template.language, { code: 'en' });
  assert.deepEqual(body.template.components, [
    { type: 'body', parameters: [{ type: 'text', text: '1234' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '1234' }] },
  ]);

  const realFetch = globalThis.fetch;
  try {
    let url = '';
    let auth = '';
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      url = u;
      auth = (init.headers as Record<string, string>).Authorization ?? '';
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await wa.send(msg), { providerMessageId: 'wamid.X' });
    assert.equal(url, 'https://graph.facebook.com/v23.0/123/messages');
    assert.equal(auth, 'Bearer T');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Template name does not exist in the translation', code: 132001 } }), { status: 404 })) as typeof fetch;
    await assert.rejects(wa.send(msg), /132001/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Twilio: Messaging Service предпочтительнее From; без ключей SMS выключен', () => {
  assert.equal(new TwilioSmsProvider({ accountSid: 'AC1', authToken: 't', from: 'BookTime', messagingServiceSid: 'MG1' }).form(AM, 'x').get('MessagingServiceSid'), 'MG1');
  const f = new TwilioSmsProvider({ accountSid: 'AC1', authToken: 't', from: 'BookTime' }).form(AM, 'Код');
  assert.equal(f.get('From'), 'BookTime');
  assert.equal(f.get('To'), AM);
  assert.equal(f.get('Body'), 'Код');
  assert.equal(createSmsProvider({}), null);
  assert.equal(createSmsProvider({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }), null);
  assert.equal(createSmsProvider({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: 'BookTime' })?.name, 'twilio');
});
