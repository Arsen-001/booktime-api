/**
 * Ответ 29 (владелец 17.11.2026): «Просматривать телефоны клиентов» — главная галочка. Без права clients.phones
 * телефоны клиентов скрыты в ответах кабинета: зеркало журнала (клиенты записей), строки с `clientPhone`
 * (заявки онлайн-записи, лист ожидания, «кого позвать»). С правом — как есть. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { ClientPhonesInterceptor } = await import('./client-phones.interceptor.js');

const ANI = '+37400160001';
const mirror = {
  bookings: [{ id: 'b1', clientId: 'c1' }],
  clients: [{ id: 'c1', name: 'Ани', phone: ANI }],
  requests: [{ bookingId: 'b2', clientPhone: ANI, nested: { clientPhone: '+37400160002' } }],
};

function run(permissions: string[] | null, path: string, body: unknown) {
  const req = { path, ctx: { member: permissions ? { permissions: new Set(permissions) } : null } };
  const context = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  return lastValueFrom(new ClientPhonesInterceptor().intercept(context, { handle: () => of(body) }));
}

test('без права clients.phones: зеркало журнала и строки clientPhone — маской', async () => {
  const out = (await run(['journal.view', 'clients.view'], '/v1/biz/biz_kay/journal/mirror', mirror)) as typeof mirror;
  assert.equal(out.clients[0]!.phone, '+374•••••01');
  assert.equal(out.requests[0]!.clientPhone, '+374•••••01');
  assert.equal(out.requests[0]!.nested.clientPhone, '+374•••••02');
  assert.equal(out.bookings[0]!.id, 'b1');
  // исходный ответ не меняется
  assert.equal(mirror.clients[0]!.phone, ANI);
});

test('с правом clients.phones и в приложении клиента — телефоны как есть', async () => {
  assert.equal(((await run(['journal.view', 'clients.phones'], '/v1/biz/biz_kay/journal/mirror', mirror)) as typeof mirror).clients[0]!.phone, ANI);
  assert.equal(((await run(null, '/v1/me/bookings', mirror)) as typeof mirror).requests[0]!.clientPhone, ANI);
});

test('уже замаскированный номер и файлы не трогаем', async () => {
  const masked = { clientPhone: '+374•••••01' };
  assert.deepEqual(await run([], '/v1/biz/b/orders', masked), masked);
  const file = Buffer.from('a,b');
  assert.equal(await run([], '/v1/biz/b/clients/export', file), file);
});

test('правка клиента без права clients.phones: номер маской или без номера — остаётся прежний (20.11.2026)', async () => {
  const { phoneForUpdate, additionalPhoneForUpdate } = await import('./clients.service.js');
  const { updateClientBody } = await import('./clients.schemas.js');
  // форма сотрудника без права видит «+374•••••01» — раньше это был invalid_phone, сохранить имя было нельзя
  assert.equal(phoneForUpdate('+374•••••01', ANI), ANI);
  assert.equal(phoneForUpdate(undefined, ANI), ANI);
  assert.equal(updateClientBody.safeParse({ name: 'Ани' }).success, true);
  // настоящий номер — по-прежнему проверяется
  assert.equal(phoneForUpdate('+37400160009', ANI), '+37400160009');
  assert.throws(() => phoneForUpdate('+3740016', ANI), /Full phone number required/);
  // доп. номер: маска — прежний, пусто — стереть
  assert.equal(additionalPhoneForUpdate('+374•••••02', '+37400160002'), '+37400160002');
  assert.equal(additionalPhoneForUpdate(undefined, '+37400160002'), null);
  assert.equal(additionalPhoneForUpdate('+37400160003', null), '+37400160003');
});
