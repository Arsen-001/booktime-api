import 'dotenv/config';
import { PrismaService } from '/Users/arsen/WebstormProjects/booktime-backend/src/common/prisma.service.js';
import { billingDispatch } from '/Users/arsen/WebstormProjects/booktime-backend/src/jobs/billing-tick.js';
const prisma = new PrismaService();
const day = 86400000; const now = Date.now();
const show = async (id: string) => { const s = await prisma.subscription.findUnique({ where: { businessId: id } }); const b = await prisma.business.findUnique({ where: { id }, select: { status: true } }); console.log(id, s?.status, s?.paidUntil.toISOString(), s?.graceUntil?.toISOString() ?? '-', 'biz=' + b?.status); };
// 1) бесплатный срок вышел, карты нет → отсрочка
await prisma.subscription.update({ where: { businessId: 'biz_01M3HQYC8JPKQZXADQYCW33EMG' }, data: { paidUntil: new Date(now - day), freeUntil: new Date(now - day) } });
// 2) активная с картой, срок вышел → автосписание
await prisma.subscription.update({ where: { businessId: 'biz_kaytsak' }, data: { paidUntil: new Date(now - 3600000), autoRenew: true } });
const k = await prisma.subscription.findUnique({ where: { businessId: 'biz_kaytsak' } }); console.log('kaytsak card', k?.savedCardId);
// 3) предупреждение за 3 дня
const nuri = await prisma.subscription.findUnique({ where: { businessId: 'biz_nuri' } });
const { localDayRangeUtc, utcToLocalDate } = await import('/Users/arsen/WebstormProjects/booktime-backend/src/common/time/time.js');
await prisma.subscription.update({ where: { businessId: 'biz_nuri' }, data: { paidUntil: localDayRangeUtc(utcToLocalDate(new Date(now + 3 * day))).from, warnedDays: null } });
console.log('tick1', await billingDispatch(prisma));
for (const id of ['biz_01M3HQYC8JPKQZXADQYCW33EMG', 'biz_kaytsak', 'biz_nuri']) await show(id);
console.log('tick1 again (idempotent)', await billingDispatch(prisma));
await prisma.subscription.update({ where: { businessId: 'biz_01M3HQYC8JPKQZXADQYCW33EMG' }, data: { graceUntil: new Date(now - 1000) } });
console.log('tick2', await billingDispatch(prisma));
await show('biz_01M3HQYC8JPKQZXADQYCW33EMG');
const out = await prisma.notifyOutbox.findMany({ where: { kind: { startsWith: 'billing_' } }, select: { kind: true, body: true, dedupeKey: true } });
console.log(out);
// вернуть демо nuri
await prisma.subscription.update({ where: { businessId: 'biz_nuri' }, data: { paidUntil: nuri!.paidUntil, warnedDays: null } });
await prisma.$disconnect();
