/**
 * Имя мастера на трёх языках (владелец 17.11.2026, DESIGN.md «Ответы…» №8): правка принимает nameI18n, вид мастера
 * его отдаёт (и публичный — тоже). Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { patchStaffBody } = await import('./staff.schemas.js');
const { staffView } = await import('../businesses/views.js');

test('правка: nameI18n — три языка или null; лишние ключи — ошибка', () => {
  assert.deepEqual(patchStaffBody.parse({ nameI18n: { ru: 'Ани', hy: 'Անի', en: 'Ani' } }).nameI18n, { ru: 'Ани', hy: 'Անի', en: 'Ani' });
  assert.equal(patchStaffBody.parse({ nameI18n: null }).nameI18n, null);
  assert.equal(patchStaffBody.safeParse({ nameI18n: { de: 'Ani' } }).success, false);
  assert.equal(patchStaffBody.safeParse({ nameI18n: { ru: 'x'.repeat(121) } }).success, false);
});

test('вид мастера: nameI18n есть — отдаём, нет — поля нет (сайт переведёт буквы на лету)', () => {
  const row = { id: 's1', businessId: 'b1', name: 'Ани Саргсян', phone: '', role: 'master', sphereIds: [], photos: [], materials: [], workplaces: ['salon'], serviceIds: [], status: 'active', version: 1 };
  assert.deepEqual(staffView({ ...row, nameI18n: { hy: 'Անի Սարգսյան' } } as never).nameI18n, { hy: 'Անի Սարգսյան' });
  assert.equal(staffView({ ...row, nameI18n: null } as never).nameI18n, undefined);
});

test('уведомления клиенту (уточнение «К 8», 17.11): имя мастера на языке клиента, нет перевода — как вписали', async () => {
  const { staffNameFor } = await import('../notify/notify-type-text.js');
  const ani = { name: 'Ани Саргсян', nameI18n: { hy: 'Անի Սարգսյան', en: 'Ani Sargsyan' } };
  assert.equal(staffNameFor(ani, 'hy'), 'Անի Սարգսյան');
  assert.equal(staffNameFor(ani, 'en'), 'Ani Sargsyan');
  assert.equal(staffNameFor(ani, 'ru'), 'Ани Саргсян');
  assert.equal(staffNameFor({ name: 'Ани Саргсян', nameI18n: null }, 'en'), 'Ани Саргсян');
  assert.equal(staffNameFor(null, 'en'), '');
});
