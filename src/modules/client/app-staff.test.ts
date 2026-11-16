/**
 * Раздел «Приложение» кабинета (app-staff.service.ts): «Расчёт» зарплаты в приложении берёт дни периода по Еревану, а не
 * от полуночи UTC; «Отправить сообщение» из окна записи — только клиенту этого бизнеса и по записи этого бизнеса.
 * База — заглушка в памяти. Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AppStaffService } = await import('./app-staff.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

type Range = { gte?: Date; lt?: Date; lte?: Date };
const inRange = (at: Date, r: Range) => (!r.gte || at >= r.gte) && (!r.lt || at < r.lt) && (!r.lte || at <= r.lte);

test('«Расчёт» в приложении: визиты 00:00–04:00 первого дня по Еревану входят в период, ранние визиты дня после — нет', async () => {
  // Ереван = UTC+4: «1 ноября 01:00» — это 31 октября 21:00 UTC
  const visits = [
    { id: 'bk_before', startAt: new Date('2026-10-31T19:30:00Z'), total: 1000n }, // 31.10 23:30 — до периода
    { id: 'bk_first_night', startAt: new Date('2026-10-31T21:00:00Z'), total: 2000n }, // 01.11 01:00 — первый день
    { id: 'bk_first_early', startAt: new Date('2026-10-31T23:30:00Z'), total: 3000n }, // 01.11 03:30 — первый день
    { id: 'bk_last_late', startAt: new Date('2026-11-30T19:00:00Z'), total: 4000n }, // 30.11 23:00 — последний день
    { id: 'bk_after', startAt: new Date('2026-11-30T22:00:00Z'), total: 5000n }, // 01.12 02:00 — после периода
  ].map((b) => ({ ...b, businessId: 'biz_1', staffId: 'st_1', status: 'arrived', durationMin: 60 }));
  const prisma = {
    booking: {
      findMany: async ({ where }: { where: { businessId: string; staffId: string; status: string; startAt: Range } }) =>
        visits.filter((b) => b.businessId === where.businessId && b.staffId === where.staffId && b.status === where.status && inRange(b.startAt, where.startAt)),
    },
    bookingPayment: { findMany: async () => [] },
  };
  const schedule = { hours: async () => ({ days: [] }) };
  const svc = new AppStaffService(prisma as never, {} as never, schedule as never);
  const calc = await svc.getPayrollCalculation('biz_1', 'st_1', '2026-11-01', '2026-11-30');
  assert.equal(calc.servicesCount, 3);
  assert.equal(calc.servicesValue, 2000 + 3000 + 4000);
});

/** Бизнес biz_1: карточка клиента au_mine, запись bk_mine (записался au_app — без карточки), чужая запись bk_other */
function messageService() {
  const sent: { appUserId: string; businessId: string; bookingId?: string }[] = [];
  const bookings = [
    { id: 'bk_mine', businessId: 'biz_1', appUserId: null },
    { id: 'bk_app', businessId: 'biz_1', appUserId: 'au_app' },
    { id: 'bk_other', businessId: 'biz_2', appUserId: 'au_mine' },
  ];
  const clients = [
    { businessId: 'biz_1', appUserId: 'au_mine', deletedAt: null },
    { businessId: 'biz_2', appUserId: 'au_stranger', deletedAt: null },
    { businessId: 'biz_1', appUserId: 'au_deleted', deletedAt: new Date() },
  ];
  const prisma = {
    booking: { findFirst: async ({ where }: { where: { id: string; businessId: string } }) => bookings.find((b) => b.id === where.id && b.businessId === where.businessId) ?? null },
    client: { count: async ({ where }: { where: { businessId: string; appUserId: string } }) => clients.filter((c) => c.businessId === where.businessId && c.appUserId === where.appUserId && c.deletedAt === null).length },
    inboxItem: {
      create: async ({ data }: { data: { id: string; appUserId: string; businessId: string; bookingId?: string; kind: string; params: unknown } }) => {
        sent.push(data);
        return { ...data, createdAt: new Date() };
      },
    },
  };
  return { svc: new AppStaffService(prisma as never, {} as never, {} as never), sent };
}

const notFound = (e: unknown) => e instanceof ApiError && e.code === 'not_found' && e.status === 404;

test('«Отправить сообщение»: своему клиенту — уходит личным (direct), по своей записи и без записи', async () => {
  const { svc, sent } = messageService();
  const item = await svc.sendOneOffPush('biz_1', { appUserId: 'au_mine', bookingId: 'bk_mine', text: ' Привет ' });
  assert.equal(item.kind, 'direct');
  assert.deepEqual(item.params, { text: 'Привет' });
  await svc.sendOneOffPush('biz_1', { appUserId: 'au_mine', text: 'Без записи' });
  // записался из приложения, карточки ещё нет — по его же записи сообщение проходит
  await svc.sendOneOffPush('biz_1', { appUserId: 'au_app', bookingId: 'bk_app', text: 'Ждём вас' });
  assert.equal(sent.length, 3);
});

test('«Отправить сообщение»: чужой клиент и чужая запись — 404, в ленту ничего не пишется', async () => {
  const { svc, sent } = messageService();
  await assert.rejects(svc.sendOneOffPush('biz_1', { appUserId: 'au_stranger', text: 'Привет' }), notFound); // клиент другого бизнеса
  await assert.rejects(svc.sendOneOffPush('biz_1', { appUserId: 'au_deleted', text: 'Привет' }), notFound); // карточка удалена
  await assert.rejects(svc.sendOneOffPush('biz_1', { appUserId: 'au_mine', bookingId: 'bk_other', text: 'Привет' }), notFound); // запись другого бизнеса
  await assert.rejects(svc.sendOneOffPush('biz_1', { appUserId: 'au_stranger', bookingId: 'bk_app', text: 'Привет' }), notFound); // своя запись, но чужой человек
  assert.equal(sent.length, 0);
});
