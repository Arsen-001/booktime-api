/**
 * Раздел «Приложение» кабинета (app-staff.service.ts, visit-cash.service.ts): «Расчёт» зарплаты в приложении берёт дни
 * периода по Еревану, а не от полуночи UTC, и не считает удалённые записи; «Отправить сообщение» из окна записи и чек
 * визита — только клиенту этого бизнеса и по записи этого бизнеса (app-recipient.ts). База — заглушка в памяти.
 * Запуск: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const { AppStaffService } = await import('./app-staff.service.js');
const { VisitCashService } = await import('./visit-cash.service.js');
const { ApiError } = await import('../../common/errors/api-error.js');

type Range = { gte?: Date; lt?: Date; lte?: Date };
const inRange = (at: Date, r: Range) => (!r.gte || at >= r.gte) && (!r.lt || at < r.lt) && (!r.lte || at <= r.lte);

test('«Расчёт» в приложении: визиты 00:00–04:00 первого дня по Еревану входят в период, ранние визиты дня после — нет; удалённые не считаются', async () => {
  // Ереван = UTC+4: «1 ноября 01:00» — это 31 октября 21:00 UTC
  const visits = [
    { id: 'bk_before', startAt: new Date('2026-10-31T19:30:00Z'), total: 1000n }, // 31.10 23:30 — до периода
    { id: 'bk_first_night', startAt: new Date('2026-10-31T21:00:00Z'), total: 2000n }, // 01.11 01:00 — первый день
    { id: 'bk_first_early', startAt: new Date('2026-10-31T23:30:00Z'), total: 3000n }, // 01.11 03:30 — первый день
    { id: 'bk_last_late', startAt: new Date('2026-11-30T19:00:00Z'), total: 4000n }, // 30.11 23:00 — последний день
    { id: 'bk_after', startAt: new Date('2026-11-30T22:00:00Z'), total: 5000n }, // 01.12 02:00 — после периода
    { id: 'bk_deleted', startAt: new Date('2026-11-10T08:00:00Z'), total: 6000n, deletedAt: new Date('2026-11-11T08:00:00Z') }, // «Пришёл», но удалена
  ].map((b) => ({ deletedAt: null as Date | null, ...b, businessId: 'biz_1', staffId: 'st_1', status: 'arrived', durationMin: 60 }));
  const prisma = {
    booking: {
      findMany: async ({ where }: { where: { businessId: string; staffId: string; status: string; deletedAt?: null; startAt: Range } }) =>
        visits.filter((b) => b.businessId === where.businessId && b.staffId === where.staffId && b.status === where.status && (where.deletedAt !== null || b.deletedAt === null) && inRange(b.startAt, where.startAt)),
    },
    bookingPayment: { findMany: async () => [] },
  };
  const schedule = { hours: async () => ({ days: [] }) };
  const svc = new AppStaffService(prisma as never, {} as never, schedule as never);
  const calc = await svc.getPayrollCalculation('biz_1', 'st_1', '2026-11-01', '2026-11-30');
  assert.equal(calc.servicesCount, 3);
  assert.equal(calc.servicesValue, 2000 + 3000 + 4000);
});

test('Z-отчёт в приложении: день по Еревану, удалённые «Пришёл» не считаются, разбивка по кассам сходится с «Итого» (проход 17.11)', async () => {
  const visits = [
    { id: 'bk_night', startAt: new Date('2026-11-16T22:06:00Z'), total: 7000n, staffId: 'st_1' }, // 17.11 02:06 — этот день
    { id: 'bk_day', startAt: new Date('2026-11-17T08:00:00Z'), total: 5000n, staffId: 'st_2' }, // 17.11 12:00
    { id: 'bk_yesterday', startAt: new Date('2026-11-16T19:30:00Z'), total: 1000n, staffId: 'st_1' }, // 16.11 23:30 — вчера
    { id: 'bk_deleted', startAt: new Date('2026-11-17T09:00:00Z'), total: 6000n, staffId: 'st_1', deletedAt: new Date('2026-11-17T10:00:00Z') },
  ].map((b) => ({ deletedAt: null as Date | null, ...b, businessId: 'biz_1', status: 'arrived', durationMin: 60, clientId: null, visitorName: null, locationId: 'loc_1' }));
  const prisma = {
    booking: {
      findMany: async ({ where }: { where: { businessId: string; status: string; deletedAt?: null; startAt: Range; staffId?: string } }) =>
        visits.filter((b) => b.businessId === where.businessId && b.status === where.status && (where.deletedAt !== null || b.deletedAt === null) && inRange(b.startAt, where.startAt) && (!where.staffId || b.staffId === where.staffId)),
    },
    client: { findMany: async () => [] },
    staff: { findMany: async () => [{ id: 'st_1', name: 'Ани' }, { id: 'st_2', name: 'Ева' }] },
    paymentMethod: { findMany: async () => [{ key: 'card', kind: 'card' }] },
    bookingPayment: { findMany: async () => [{ bookingId: 'bk_day', amount: 5000n, refundedAmount: 0n, kind: 'money', methodKey: 'card' }] },
  };
  const bookings = { views: async (_db: unknown, rows: { id: string }[]) => rows.map((r) => ({ id: r.id })) };
  const svc = new AppStaffService(prisma as never, bookings as never, {} as never);
  const z = await svc.getDayZReport('biz_1', '2026-11-17');
  assert.deepEqual(z.rows.map((r) => r.booking.id), ['bk_night', 'bk_day']);
  assert.equal(z.total, 12000);
  // Ответ 14: визит без оплат — долг целиком; сумма по способам = «Итого»
  assert.deepEqual(z.byMethod, { cash: 0, card: 5000, transfer: 0, loyalty: 0, debt: 7000 });
  assert.equal(z.rows[0]!.clientName, '', 'гость — подписью экрана на языке человека');
});

test('Z-отчёт (ответ 14, 17.11): предоплата переводом и долг — отдельными строками, «Итого» = сумма по способам', async () => {
  // Визит 6 000: предоплата 1 800 переводом, 3 000 наличными, 1 200 картой — оплачен. Визит 10 000: 2 000 наличными,
  // 3 000 счётом в долг, 5 000 не оплачено. Итого 16 000 = 5 000 нал. + 1 200 карта + 1 800 перевод + 8 000 долг.
  const visits = [
    { id: 'bk_paid', startAt: new Date('2026-11-17T08:00:00Z'), total: 6000n, prepayment: { amount: 1800, paid: true } },
    { id: 'bk_owes', startAt: new Date('2026-11-17T10:00:00Z'), total: 10000n, prepayment: null },
  ].map((b) => ({ deletedAt: null as Date | null, ...b, businessId: 'biz_1', staffId: 'st_1', status: 'arrived', durationMin: 60, clientId: null, visitorName: null, locationId: 'loc_1' }));
  const prisma = {
    booking: { findMany: async () => visits },
    client: { findMany: async () => [] },
    staff: { findMany: async () => [{ id: 'st_1', name: 'Ани' }] },
    paymentMethod: { findMany: async () => [{ key: 'cash', kind: 'cash' }, { key: 'card', kind: 'card' }] },
    bookingPayment: {
      findMany: async () => [
        { bookingId: 'bk_paid', amount: 3000n, refundedAmount: 0n, kind: 'money', methodKey: 'cash', debt: false },
        { bookingId: 'bk_paid', amount: 1200n, refundedAmount: 0n, kind: 'money', methodKey: 'card', debt: false },
        { bookingId: 'bk_owes', amount: 2000n, refundedAmount: 0n, kind: 'money', methodKey: 'cash', debt: false },
        { bookingId: 'bk_owes', amount: 3000n, refundedAmount: 0n, kind: 'account', methodKey: 'account', debt: true },
      ],
    },
  };
  const bookings = { views: async (_db: unknown, rows: { id: string }[]) => rows.map((r) => ({ id: r.id })) };
  const z = await new AppStaffService(prisma as never, bookings as never, {} as never).getDayZReport('biz_1', '2026-11-17');
  assert.equal(z.total, 16000);
  assert.deepEqual(z.byMethod, { cash: 5000, card: 1200, transfer: 1800, loyalty: 0, debt: 8000 });
  assert.equal(Object.values(z.byMethod).reduce((a, b) => a + b, 0), z.total);
  assert.deepEqual(z.rows.map((r) => r.paidTotal), [6000, 2000]);
});

/** Бизнес biz_1: карточка клиента au_mine, запись bk_mine, запись bk_app (записался au_app — без карточки), чужая запись bk_other */
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
  return { svc: new AppStaffService(prisma as never, {} as never, {} as never), receipts: new VisitCashService(prisma as never, {} as never), sent };
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

test('чек визита: своему клиенту по своей записи — уходит; чужому человеку и по чужой записи — 404', async () => {
  const { receipts, sent } = messageService();
  const item = await receipts.sendVisitReceipt('biz_1', 'bk_mine', { appUserId: 'au_mine', total: 12000 });
  assert.equal(item.kind, 'receipt');
  await receipts.sendVisitReceipt('biz_1', 'bk_app', { appUserId: 'au_app', total: 8000 }); // записался сам, без карточки
  assert.equal(sent.length, 2);
  await assert.rejects(receipts.sendVisitReceipt('biz_1', 'bk_mine', { appUserId: 'au_stranger', total: 12000 }), notFound); // клиент другого бизнеса
  await assert.rejects(receipts.sendVisitReceipt('biz_1', 'bk_other', { appUserId: 'au_mine', total: 12000 }), notFound); // запись другого бизнеса
  assert.equal(sent.length, 2);
});
