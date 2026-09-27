import { createHash } from 'node:crypto';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/common/prisma.service.js';
import type { MockCore } from './mock-core.js';

type Rec = Record<string, unknown>;

/**
 * Этап 21, лейн «finance+stock»: срез «finance» мока фронта (src/mock/slices/finance.ts, `areaFinance` из
 * export-mock.ts) — то, что раздел «Финансы» держит на сервере JSON-ом: настройки по ключам (`business_settings`,
 * `finance.<key>`: политика оплаты, Adyen, уведомления, типы счетов, чек, методы оплаты, онлайн-ссылка, предоплата)
 * и демо-документы онлайн-платежей (`fin_records`: ссылки на оплату, снимки/счёт политики, транзакции Adyen, заказы
 * «другим способом»). Кассы/операции/оплаты визитов сеет этап 12 (seed.ts). Идемпотентно: upsert по id.
 */
const SETTING_KEYS: Record<string, string> = {
  paymentMethods: 'paymentMethods',
  receiptSettings: 'receipt',
  onlinePaymentSettings: 'onlinePayment',
  onlineLinkSettings: 'onlineLink',
  prepaymentSettings: 'prepayment',
  staffPrepayment: 'staffPrepayment',
  servicePrepayment: 'servicePrepayment',
  fiscalSettings: 'fiscal',
  paymentPolicy: 'policy',
  policyServiceOverrides: 'policyServiceOverrides',
  adyenConnections: 'adyen',
  paymentNotifications: 'paymentNotifications',
  accountTypes: 'accountTypes',
};

const short = (id: string) => (id.length <= 32 ? id : `${id.split('_')[0]}_${createHash('sha1').update(id).digest('hex').slice(0, 24)}`.slice(0, 32));

export async function seedFinanceFromMock(prisma: PrismaService, core: MockCore): Promise<void> {
  const area = ((core as Rec).areaFinance ?? null) as Rec | null;
  if (!area) return;
  const known = new Set(core.businesses.map((b) => String(b.id)));
  // Методы оплаты мока ссылаются на кассы мока (другие id) — касса берётся из payment_methods сервера, не из мока
  const skipAccountRefs = new Set(['paymentMethods']);
  let settings = 0;
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    const byBiz = (area[field] ?? {}) as Record<string, unknown>;
    for (const [businessId, value] of Object.entries(byBiz)) {
      if (!known.has(businessId) || value === undefined || value === null) continue;
      if (skipAccountRefs.has(field)) continue;
      const areaKey = `finance.${key}`;
      await prisma.businessSetting.upsert({
        where: { businessId_area: { businessId, area: areaKey } },
        create: { businessId, area: areaKey, data: value as Prisma.InputJsonValue, updatedBy: 'seed' },
        update: {},
      });
      settings++;
    }
  }
  // Права раздела мока — карта staffId → права (без бизнеса): раскладываем по бизнесу сотрудника
  const rights = (area.financeRights ?? {}) as Record<string, unknown>;
  const staffBiz = new Map(((core as Rec).staff as Rec[] | undefined ?? []).map((s) => [String(s.id), String(s.businessId)]));
  const rightsByBiz = new Map<string, Record<string, unknown>>();
  for (const [staffId, r] of Object.entries(rights)) {
    const b = staffBiz.get(staffId);
    if (!b || !known.has(b)) continue;
    rightsByBiz.set(b, { ...(rightsByBiz.get(b) ?? {}), [staffId]: r });
  }
  for (const [businessId, map] of rightsByBiz) {
    await prisma.businessSetting.upsert({ where: { businessId_area: { businessId, area: 'finance.rights' } }, create: { businessId, area: 'finance.rights', data: map as Prisma.InputJsonValue, updatedBy: 'seed' }, update: {} });
    settings++;
  }

  const bookingIds = new Set(((core as Rec).bookings as Rec[] | undefined ?? []).map((b) => String(b.id)));
  const rows: { id: string; businessId: string; kind: string; refId?: string; clientId?: string; data: Rec }[] = [];
  for (const l of (area.paymentLinks ?? []) as Rec[]) {
    if (!known.has(String(l.businessId))) continue;
    if (l.bookingId && !bookingIds.has(String(l.bookingId))) continue;
    rows.push({ id: short(String(l.id)), businessId: String(l.businessId), kind: 'paymentLink', refId: l.bookingId ? String(l.bookingId) : undefined, data: l });
  }
  for (const [bookingId, snap] of Object.entries((area.bookingPolicySnapshots ?? {}) as Record<string, Rec>)) {
    if (!known.has(String(snap.businessId)) || !bookingIds.has(bookingId)) continue;
    rows.push({ id: short(`psn_${bookingId}`), businessId: String(snap.businessId), kind: 'policySnapshot', refId: bookingId, clientId: String(snap.clientId), data: snap });
  }
  for (const e of (area.policyAccountEntries ?? []) as Rec[]) {
    if (!known.has(String(e.businessId))) continue;
    rows.push({ id: short(String(e.id)), businessId: String(e.businessId), kind: 'policyEntry', refId: e.bookingId ? String(e.bookingId) : undefined, clientId: String(e.clientId), data: e });
  }
  for (const t of (area.adyenTransactions ?? []) as Rec[]) {
    if (!known.has(String(t.businessId))) continue;
    rows.push({ id: short(String(t.id)), businessId: String(t.businessId), kind: 'adyenTxn', data: t });
  }
  for (const [businessId, list] of Object.entries((area.manualOnlineOrders ?? {}) as Record<string, Rec[]>)) {
    if (!known.has(businessId)) continue;
    for (const o of list) rows.push({ id: short(String(o.id)), businessId, kind: 'manualOrder', refId: short(String(o.id)), data: o });
  }
  for (const r of rows) {
    const data = { ...r.data, id: r.id } as Prisma.InputJsonValue;
    await prisma.finRecord.upsert({ where: { id: r.id }, create: { id: r.id, businessId: r.businessId, kind: r.kind, refId: r.refId ?? null, clientId: r.clientId ?? null, data }, update: {} });
  }
  console.log(`seed: финансы из мока — настроек ${settings}, демо-документов ${rows.length}`);
}

if (process.argv[1]?.endsWith('seed/finance.ts')) {
  const { PrismaService } = await import('../../src/common/prisma.service.js');
  const { loadMockCore } = await import('./mock-core.js');
  await import('dotenv/config');
  const prisma = new PrismaService();
  await seedFinanceFromMock(prisma, loadMockCore());
  await prisma.$disconnect();
}
