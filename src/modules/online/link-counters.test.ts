/** Счётчики салона на ссылке (F-03-118/119): формат ID пикселя Meta и потока GA4 проверяется на входе. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateLinkBody } from './online.schemas.js';

test('ID пикселя Meta — только цифры; пусто и null — убрать', () => {
  assert.equal(updateLinkBody.parse({ metaPixelId: ' 1234567890123456 ' }).metaPixelId, '1234567890123456');
  assert.equal(updateLinkBody.parse({ metaPixelId: '' }).metaPixelId, '');
  assert.equal(updateLinkBody.parse({ metaPixelId: null }).metaPixelId, null);
  assert.equal(updateLinkBody.safeParse({ metaPixelId: '123abc' }).success, false);
  assert.equal(updateLinkBody.safeParse({ metaPixelId: '"><script>' }).success, false);
});

test('ID потока GA4 — G-XXXXXXXXXX, регистр не важен', () => {
  assert.equal(updateLinkBody.parse({ ga4StreamId: 'g-ab12cd34ef' }).ga4StreamId, 'G-AB12CD34EF');
  assert.equal(updateLinkBody.safeParse({ ga4StreamId: 'UA-12345-1' }).success, false);
  assert.equal(updateLinkBody.safeParse({ ga4StreamId: 'G-1' }).success, false);
  assert.equal(updateLinkBody.parse({ name: 'Ссылка' }).ga4StreamId, undefined);
});
