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

test('уведомления клиенту (уточнение «К 8», 17.11): имя мастера на языке клиента, нет перевода — перевод букв, как сайт', async () => {
  const { staffNameFor } = await import('../notify/notify-type-text.js');
  const ani = { name: 'Ани Саргсян', nameI18n: { hy: 'Անի Սարգսյան-Ղազարյան', en: 'Ani Sargsyan' } };
  // Вписанный перевод важнее перевода букв
  assert.equal(staffNameFor(ani, 'hy'), 'Անի Սարգսյան-Ղազարյան');
  assert.equal(staffNameFor(ani, 'en'), 'Ani Sargsyan');
  assert.equal(staffNameFor(ani, 'ru'), 'Ани Саргсян');
  // Перевода нет — те же примеры, что тест сайта name-translit (одна копия правила, scripts/sync-name-translit.mjs)
  assert.equal(staffNameFor({ name: 'Ани Саргсян', nameI18n: null }, 'en'), 'Ani Sargsyan');
  assert.equal(staffNameFor({ name: 'Ани Саргсян', nameI18n: null }, 'hy'), 'Անի Սարգսյան');
  assert.equal(staffNameFor({ name: 'Ани Мелкумян', nameI18n: { en: '  ' } }, 'hy'), 'Անի Մելքումյան');
  assert.equal(staffNameFor({ name: 'Ani Sargsyan', nameI18n: {} }, 'ru'), 'Ани Саргсян');
  assert.equal(staffNameFor({ name: 'Ани Саргсян', nameI18n: null }, 'ru'), 'Ани Саргсян');
  assert.equal(staffNameFor(null, 'en'), '');
});

test('уведомление клиенту на en и hy: Telegram-карточка записи с именем мастера без вписанного перевода', async () => {
  const { bookingCard, cardText } = await import('../telegram/telegram-texts.js');
  const one = (row: unknown) => ({ findUnique: async () => row });
  const prisma = {
    business: one({ name: 'Nuri Nails', brandName: null, slug: 'nuri-nails', phone: null }),
    location: one({ tz: 'Asia/Yerevan', phone: null }),
    staff: one({ name: 'Ани Саргсян', nameI18n: null, phone: null }),
    service: one({ name: { ru: 'Маникюр', en: 'Manicure', hy: 'Մատնահարդարում' } }),
  };
  const b = { id: 'bk1', status: 'scheduled', businessId: 'b1', locationId: 'l1', staffId: 's1', startAt: new Date('2026-11-20T08:00:00Z'), services: [{ serviceId: 'svc1' }] };
  const en = await bookingCard(prisma as never, b as never, 'en');
  assert.equal(en.master, 'Ani Sargsyan');
  assert.match(cardText(en), /👤 Ani Sargsyan/);
  const hy = await bookingCard(prisma as never, b as never, 'hy');
  assert.equal(hy.master, 'Անի Սարգսյան');
  assert.match(cardText(hy), /👤 Անի Սարգսյան/);
  const ru = await bookingCard(prisma as never, b as never, 'ru');
  assert.equal(ru.master, 'Ани Саргсян');
});
