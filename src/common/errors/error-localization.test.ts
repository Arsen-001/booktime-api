/**
 * Текст ошибки на языке запроса (QA 15.10.2026): `frozen` (423) приходит на hy / ru / en по Accept-Language, иначе
 * по языку сессии; код и статус прежние, остальные ошибки — как были. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { ErrorFilter } = await import('./error.filter.js');
const { ApiError } = await import('./api-error.js');
const { localeFromAcceptLanguage, errorMessage } = await import('../i18n/i18n.js');
const { messages } = await import('../i18n/messages.js');
type ArgumentsHost = import('@nestjs/common').ArgumentsHost;

function send(error: unknown, req: { headers?: Record<string, string>; ctx?: unknown }) {
  const out: { status?: number; body?: { code: string; message: string } } = {};
  const res = {
    status(s: number) {
      out.status = s;
      return this;
    },
    json(b: { code: string; message: string }) {
      out.body = b;
    },
    setHeader() {},
  };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ headers: {}, ...req }) }) } as unknown as ArgumentsHost;
  new ErrorFilter().catch(error, host);
  return out;
}

const frozen = () => new ApiError('frozen', 'Subscription is frozen: read-only until paid');

test('frozen: текст по Accept-Language — ru, hy, en', () => {
  const ru = send(frozen(), { headers: { 'accept-language': 'ru' } });
  assert.equal(ru.status, 423);
  assert.equal(ru.body!.code, 'frozen');
  assert.equal(ru.body!.message, messages.ru['error.frozen']);
  assert.match(ru.body!.message, /Подписка заморожена/);
  assert.equal(send(frozen(), { headers: { 'accept-language': 'hy-AM,hy;q=0.9,en;q=0.5' } }).body!.message, messages.hy['error.frozen']);
  assert.equal(send(frozen(), { headers: { 'accept-language': 'en-US,en;q=0.9' } }).body!.message, messages.en['error.frozen']);
});

test('frozen: без Accept-Language — язык сессии, без сессии — английский текст исключения', () => {
  assert.equal(send(frozen(), { ctx: { session: { locale: 'hy' } } }).body!.message, messages.hy['error.frozen']);
  assert.equal(send(frozen(), {}).body!.message, 'Subscription is frozen: read-only until paid');
  // незнакомый язык в заголовке — дальше по списку, иначе сессия
  assert.equal(send(frozen(), { headers: { 'accept-language': 'de-DE,de;q=0.9,ru;q=0.8' } }).body!.message, messages.ru['error.frozen']);
  assert.equal(send(frozen(), { headers: { 'accept-language': 'de' }, ctx: { session: { locale: 'ru' } } }).body!.message, messages.ru['error.frozen']);
});

test('остальные ошибки — без перевода, как были', () => {
  const r = send(new ApiError('slot_taken', 'Staff is busy at this time'), { headers: { 'accept-language': 'ru' } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { code: 'slot_taken', message: 'Staff is busy at this time' });
});

test('разбор Accept-Language', () => {
  assert.equal(localeFromAcceptLanguage(undefined), undefined);
  assert.equal(localeFromAcceptLanguage(''), undefined);
  assert.equal(localeFromAcceptLanguage('RU-ru'), 'ru');
  assert.equal(localeFromAcceptLanguage('en;q=0.4, hy;q=0.8'), 'hy');
  assert.equal(localeFromAcceptLanguage('ru;q=0, en'), 'en');
  assert.equal(localeFromAcceptLanguage('fr, de'), undefined);
  assert.equal(errorMessage('slot_taken', 'ru'), undefined);
});
