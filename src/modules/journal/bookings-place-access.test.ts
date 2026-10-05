/** Запись из кабинета с онлайн-источником (06.10.2026): право journal.create на мастера проверяется всегда. Запуск: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { BookingsService, staffActor, clientActor } = await import('./bookings.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

/** Без базы: до проверки прав сервис ничего не читает; после неё — падает на пустой базе (это и отличаем) */
const svc = new BookingsService(null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never, null as never);
const member = (perms: string[], staffId = 'st_me') => ({ requestId: 'r', member: { businessId: 'biz_1', staffId, name: 'M', role: 'master', kind: 'salon', permissions: new Set(perms) } }) as never;
const input = (source: string, staffId = 'st_other') => ({ source, businessId: 'biz_1', staffId, start: '2026-10-07T10:00', services: [{ serviceId: 'svc_1' }] });
const isForbidden = (e: unknown) => e instanceof ApiError && e.code === 'forbidden';

test('сотрудник без journal.create: и с source link/widget/app — forbidden', async () => {
  for (const source of ['link', 'widget', 'app', 'journal']) {
    await assert.rejects(svc.place(staffActor(member(['journal.view', 'journal.edit'])), input(source)), isForbidden, source);
  }
});

test('сотрудник с journal.create, но без journal.others — чужому мастеру нельзя и с онлайн-источником', async () => {
  await assert.rejects(svc.place(staffActor(member(['journal.view', 'journal.edit', 'journal.create'])), input('link')), isForbidden);
});

test('проверка прав пройдена: свой мастер / journal.others; публичный путь (без членства) — без проверки прав', async () => {
  const notForbidden = (e: unknown) => !isForbidden(e);
  await assert.rejects(svc.place(staffActor(member(['journal.view', 'journal.edit', 'journal.create'])), input('link', 'st_me')), notForbidden);
  await assert.rejects(svc.place(staffActor(member(['journal.view', 'journal.edit', 'journal.create', 'journal.others'])), input('widget')), notForbidden);
  await assert.rejects(svc.place(clientActor(null, 'link_holder'), input('link')), notForbidden);
});
