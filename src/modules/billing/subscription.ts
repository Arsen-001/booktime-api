import dayjs from 'dayjs';
import { Prisma } from '../../generated/prisma/client.js';
import type { PaymentProvider } from '../../adapters/payments/payments.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { money, moneyToJson, percentOf } from '../../common/money/money.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { loadPrices, tierPercent, type Prices, type PromoTier } from './billing-prices.js';
import { computeSeats } from './billing-seats.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;
export type SubRow = Prisma.SubscriptionGetPayload<object>;

/** Статусы сервера (06 §3.2) */
/** trial — пробный период самостоятельной регистрации (7 дней, F-00-019, решение владельца 01.10.2026) */
export type SubStatus = 'unpaid' | 'trial' | 'trial_free' | 'active' | 'grace' | 'frozen' | 'cancelled' | 'left';
export type PayMethod = 'card' | 'idram' | 'telcell' | 'invoice';

// ─────────── время: срок хранится моментом UTC = начало местного дня «до» (Asia/Yerevan) ───────────

const todayLocal = () => utcToLocalDate(new Date());
export const startOfLocalDay = (date: string) => localDayRangeUtc(date).from;
/** 'YYYY-MM-DD' + n месяцев/дней в поясе Еревана → начало того дня в UTC */
export function addLocal(from: Date, n: number, unit: 'month' | 'day'): Date {
  return dayjs(from).tz(DEFAULT_TZ).add(n, unit).startOf('day').toDate();
}
/** Сколько местных дней до срока (0 — срок сегодня или прошёл) */
export function daysUntil(at: Date): number {
  return dayjs(utcToLocalDate(at)).diff(dayjs(todayLocal()), 'day');
}

// ─────────── строка подписки ───────────

/**
 * Подписка бизнеса; бизнесы до этапа 18 (и сид без неё) получают строку при первом чтении: уже опубликованный
 * (`active`) — «оплачено на 30 дней вперёд», черновик — `unpaid` (В-02: настраивает бесплатно, публикация после
 * оплаты или промокода с визита).
 */
export async function ensureSubscription(db: Db, businessId: string): Promise<SubRow> {
  const found = await db.subscription.findUnique({ where: { businessId } });
  if (found) return found;
  const biz = await db.business.findUnique({ where: { id: businessId }, select: { status: true } });
  if (!biz) throw new ApiError('not_found', 'Business not found');
  const start = startOfLocalDay(todayLocal());
  const published = biz.status === 'active';
  await db.subscription.createMany({
    data: [{ businessId, status: published ? 'active' : biz.status === 'frozen' ? 'frozen' : 'unpaid', paidUntil: published ? addLocal(start, 30, 'day') : start }],
    skipDuplicates: true,
  });
  return db.subscription.findUniqueOrThrow({ where: { businessId } });
}

/** Скидка промокода за срок `months`, пока она не потрачена (В-13, F-00-021) */
function promoPercent(sub: SubRow, months: number): number {
  if (!sub.promoTiers || sub.promoUsedAt) return 0;
  return tierPercent(sub.promoTiers as unknown as PromoTier[], months);
}
const bestTier = (sub: SubRow) => Math.max(0, ...((sub.promoTiers as unknown as PromoTier[] | null) ?? []).map((t) => t.percent));

/** PriceQuote фронта: разбивка, сумма за months, скидка кода, остаток бесплатных дней (F-15-033/041/059/062) */
export async function quoteFor(db: Db, businessId: string, months: number, prices?: Prices) {
  const p = prices ?? (await loadPrices(db));
  const sub = await ensureSubscription(db, businessId);
  const seats = await computeSeats(db, businessId, p);
  const regularTotal = seats.monthlyTotal * months;
  const pct = promoPercent(sub, months);
  const discountAmount = pct ? moneyToJson(percentOf(money(regularTotal), pct)) : 0;
  const trial = sub.status === 'trial';
  return {
    businessId,
    kind: seats.kind,
    months,
    seats: seats.seats,
    breakdown: seats.breakdown,
    monthlyTotal: seats.monthlyTotal,
    regularTotal,
    total: regularTotal - discountAmount,
    discountPercent: pct || undefined,
    discountAmount: pct ? discountAmount : undefined,
    freeMonthDaysCarried: sub.status === 'trial_free' && sub.freeUntil ? Math.max(daysUntil(sub.freeUntil), 0) : undefined,
    paidMasters: seats.paidMasters,
    paidAdmins: seats.paidAdmins,
  };
}

/** SubscriptionView фронта (src/api/settings.ts) + статус сервера */
export async function subscriptionView(db: Db, businessId: string) {
  const sub = await ensureSubscription(db, businessId);
  const quote = await quoteFor(db, businessId, 1);
  const card = sub.savedCardId ? await db.savedCard.findUnique({ where: { id: sub.savedCardId } }) : null;
  const daysLeft = daysUntil(sub.paidUntil);
  const frozen = sub.status === 'frozen' || sub.status === 'left';
  const trial = sub.status === 'trial';
  // Статус как в моке (getSubscription): заморожен → бесплатный месяц → пробный период → «скоро конец» → активна
  const status = frozen ? 'frozen' : sub.status === 'trial_free' ? 'freeMonth' : trial && daysLeft >= 0 ? 'trial' : daysLeft <= 7 ? 'endingSoon' : 'active';
  return {
    businessId,
    paidUntil: utcToLocalDate(sub.paidUntil),
    autoRenew: sub.autoRenew,
    frozen,
    freeMonthUntil: sub.status === 'trial_free' && sub.freeUntil ? utcToLocalDate(sub.freeUntil) : undefined,
    /** Пробный период самостоятельной регистрации (Subscription.trialUntil мока, F-00-019): paidUntil = trialUntil */
    trialUntil: trial ? utcToLocalDate(sub.paidUntil) : undefined,
    promoApplied: sub.promoCode ?? undefined,
    promoDiscountPercent: sub.promoTiers && !sub.promoUsedAt ? bestTier(sub) || undefined : undefined,
    promoUsed: sub.promoCode ? Boolean(sub.promoUsedAt) : undefined,
    promoTiers: sub.promoTiers && !sub.promoUsedAt ? (sub.promoTiers as unknown as PromoTier[]) : undefined,
    savedPaymentMethod: card ? { method: card.method as PayMethod, label: card.label, unavailable: card.unavailable || undefined } : undefined,
    paymentDocsEmail: sub.paymentDocsEmail,
    status,
    daysLeft,
    quote,
    serverStatus: sub.status as SubStatus,
    graceUntil: sub.graceUntil ? utcToLocalDate(sub.graceUntil) : undefined,
    /** В-02: после отсрочки кабинет только для чтения */
    readOnly: frozen,
    version: sub.version,
  };
}

// ─────────── счета ───────────

export async function nextInvoiceNumber(tx: Tx): Promise<string> {
  await tx.billingCounter.createMany({ data: [{ key: 'invoice', value: 1000 }], skipDuplicates: true });
  const row = await tx.billingCounter.update({ where: { key: 'invoice' }, data: { value: { increment: 1 } } });
  return String(row.value);
}

/** Реквизиты плательщика — снимок в счёт (F-15-088): из настроек раздела `legal` */
export async function payerSnapshot(db: Db, businessId: string): Promise<Prisma.InputJsonValue | typeof Prisma.DbNull> {
  const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: 'legal' } } });
  const legal = (row?.data ?? {}) as { companyName?: string; billingAddress?: string; legalAddress?: string; taxId?: string };
  if (!legal.companyName) return Prisma.DbNull;
  return { name: legal.companyName, address: legal.billingAddress ?? legal.legalAddress ?? '', ...(legal.taxId ? { taxId: legal.taxId } : {}) };
}

export function invoiceView(i: Prisma.BillingInvoiceGetPayload<object>) {
  return {
    id: i.id,
    businessId: i.businessId,
    number: i.number,
    purpose: i.purpose as 'subscription' | 'coins' | 'ads',
    amount: moneyToJson(i.amount),
    status: i.status as 'paid' | 'unpaid' | 'cancelled',
    date: utcToLocal(i.createdAt),
    periodFrom: i.periodFrom ?? undefined,
    periodTo: i.periodTo ?? undefined,
    method: (i.method ?? undefined) as 'card' | 'promo' | 'freeMonth' | 'platform' | undefined,
    payer: (i.payer ?? undefined) as { name: string; address: string; taxId?: string } | undefined,
  };
}

// ─────────── публикация бизнеса ───────────

/** Бизнес виден клиентам (F-00-024) — только когда подписка жива. Статус «на проверке» не трогаем (этап 19). */
async function publish(tx: Tx, businessId: string, visible: boolean) {
  const b = await tx.business.findUnique({ where: { id: businessId }, select: { status: true } });
  if (!b || b.status === 'moderation') return;
  const next = visible ? 'active' : 'frozen';
  if (b.status !== next) await tx.business.update({ where: { id: businessId }, data: { status: next, version: { increment: 1 } } });
}

// ─────────── бесплатные дни (06 §5) ───────────

export async function grantFreeDays(tx: Tx, input: { businessId: string; days: number; reason: 'visit' | 'first' | 'promo' | 'manual'; by: string; note?: string }) {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 366) throw new ApiError('validation', 'days 1…366', { days: 'range' });
  const sub = await ensureSubscription(tx, input.businessId);
  const now = new Date();
  const start = startOfLocalDay(todayLocal());
  const base = [sub.freeUntil, sub.paidUntil, start].filter((d): d is Date => Boolean(d) && d! > now).sort((a, b) => b.getTime() - a.getTime())[0] ?? start;
  const until = addLocal(base, input.days, 'day');
  await tx.freePeriodGrant.create({ data: { id: newId('freePeriodGrant'), businessId: input.businessId, days: input.days, reason: input.reason, by: input.by, note: input.note ?? null } });
  const paidStillAhead = sub.status === 'active' && sub.paidUntil > now;
  await tx.subscription.update({
    where: { businessId: input.businessId },
    data: {
      freeUntil: until,
      paidUntil: until > sub.paidUntil ? until : sub.paidUntil,
      status: paidStillAhead ? 'active' : 'trial_free',
      graceUntil: null,
      retryAt: null,
      warnedDays: null,
      version: { increment: 1 },
    },
  });
  await publish(tx, input.businessId, true);
  return until;
}

// ─────────── пробный период самостоятельной регистрации (F-00-019) ───────────

/** Решение владельца 01.10.2026 (qa/full-test-0930 settings.md): сам зарегистрировался — 7 дней на знакомство */
export const INTRO_TRIAL_DAYS = 7;

/**
 * Пробный период нового бизнеса (introTrial/startIntroTrial мока): статус `trial`, paidUntil = trialUntil = сегодня +
 * 7 дней — бизнес опубликован и работает, потом обычное «продлите»: billingTick ведёт `trial` как `active`
 * (предупреждения 7/3/1, отсрочка, заморозка), оплата делает `active`. Только у свежей подписки `unpaid`: бесплатный
 * месяц с визита (промокод freeMonth → grantFreeDays, `trial_free`) — вместо него. Скидочный промокод — на первую
 * оплату, как раньше. Статус — VARCHAR(12), не enum базы: миграция не нужна.
 */
export async function startIntroTrial(tx: Tx, businessId: string): Promise<void> {
  const sub = await ensureSubscription(tx, businessId);
  if (sub.status !== 'unpaid') return;
  const until = addLocal(startOfLocalDay(todayLocal()), INTRO_TRIAL_DAYS, 'day');
  await tx.subscription.update({ where: { businessId }, data: { status: 'trial', paidUntil: until, freeUntil: null, graceUntil: null, retryAt: null, warnedDays: null, version: { increment: 1 } } });
  await publish(tx, businessId, true);
}

// ─────────── оплата ───────────

export interface ChargeInput {
  businessId: string;
  months: number;
  method: PayMethod;
  trigger: 'manual' | 'auto';
  by: string;
}

/**
 * Оплатить подписку (F-15-070/074/083/084, 06 §3.3, §3.5). Транзакции короткие, вызов провайдера — между ними
 * (PLAN §4.2): 1) строка списания `pending`; 2) провайдер; 3) итог — продление срока, счёт, трата промокода.
 * «Счёт для фирмы» (invoice) — деньги ещё не пришли: неоплаченный счёт, срок не продлевается (отметит наша панель).
 */
export async function chargeSubscription(prisma: PrismaService, payments: PaymentProvider, input: ChargeInput) {
  if (![1, 3, 6, 12].includes(input.months)) throw new ApiError('validation', 'months must be 1|3|6|12', { months: 'oneOf' });
  const q = await quoteFor(prisma, input.businessId, input.months);
  if (q.total <= 0) throw new ApiError('validation', 'Nothing to pay');
  const sub = await ensureSubscription(prisma, input.businessId);
  const now = new Date();
  const base = sub.paidUntil > now ? sub.paidUntil : startOfLocalDay(todayLocal());
  const periodEnd = addLocal(base, input.months, 'month');
  const payer = await payerSnapshot(prisma, input.businessId);

  if (input.method === 'invoice') {
    return prisma.$transaction(async (tx) => {
      const invoice = await tx.billingInvoice.create({
        data: {
          id: newId('billingInvoice'),
          businessId: input.businessId,
          number: await nextInvoiceNumber(tx),
          purpose: 'subscription',
          amount: money(q.total),
          status: 'unpaid',
          periodFrom: utcToLocalDate(base),
          periodTo: utcToLocalDate(periodEnd),
          method: 'card',
          payer,
        },
      });
      await tx.subscriptionCharge.create({
        data: {
          id: newId('subscriptionCharge'),
          businessId: input.businessId,
          periodStart: base,
          periodEnd,
          months: input.months,
          seatsMasters: q.paidMasters,
          seatsAdmins: q.paidAdmins,
          baseAmount: money(q.regularTotal),
          discountPct: q.discountPercent ?? 0,
          amount: money(q.total),
          method: 'invoice',
          status: 'pending',
          provider: 'invoice',
          invoiceId: invoice.id,
          trigger: input.trigger,
          createdBy: input.by,
        },
      });
      return { invoiceId: invoice.id, status: 'unpaid' as const };
    });
  }

  const chargeId = newId('subscriptionCharge');
  await prisma.subscriptionCharge.create({
    data: {
      id: chargeId,
      businessId: input.businessId,
      periodStart: base,
      periodEnd,
      months: input.months,
      seatsMasters: q.paidMasters,
      seatsAdmins: q.paidAdmins,
      baseAmount: money(q.regularTotal),
      discountPct: q.discountPercent ?? 0,
      amount: money(q.total),
      method: input.method,
      status: 'pending',
      provider: payments.kind,
      trigger: input.trigger,
      createdBy: input.by,
    },
  });
  const result = await payments.charge({ amount: money(q.total), purpose: `subscription ${input.months}m`, businessId: input.businessId, idempotencyKey: chargeId });
  if (result.status === 'failed') {
    await prisma.subscriptionCharge.update({ where: { id: chargeId }, data: { status: 'failed', providerRef: result.providerRef } });
    throw new ApiError('payment_failed', 'Payment declined');
  }
  if (result.status === 'pending') {
    await prisma.subscriptionCharge.update({ where: { id: chargeId }, data: { providerRef: result.providerRef } });
    return { invoiceId: null, status: 'pending' as const, chargeId };
  }
  const invoiceId = await settleCharge(prisma, chargeId, result.providerRef);
  return { invoiceId, status: 'paid' as const, chargeId };
}

/**
 * Итог успешного списания — одна транзакция: срок продлён от max(сегодня, текущего срока), бизнес опубликован,
 * промокод потрачен (F-00-021), счёт-документ выставлен (В-33: нефискальный). Настоящий провайдер позовёт это
 * из вебхука; заглушка — сразу.
 */
export async function settleCharge(prisma: PrismaService, chargeId: string, providerRef: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const c = await tx.subscriptionCharge.findUniqueOrThrow({ where: { id: chargeId } });
    if (c.status === 'paid' && c.invoiceId) return c.invoiceId;
    const sub = await ensureSubscription(tx, c.businessId);
    const now = new Date();
    // Срок считаем заново под транзакцией: между созданием строки и оплатой срок мог сдвинуться (другая оплата)
    const base = sub.paidUntil > now ? sub.paidUntil : startOfLocalDay(todayLocal());
    const periodEnd = addLocal(base, c.months, 'month');
    const invoice = await tx.billingInvoice.create({
      data: {
        id: newId('billingInvoice'),
        businessId: c.businessId,
        number: await nextInvoiceNumber(tx),
        purpose: 'subscription',
        amount: c.amount,
        status: 'paid',
        periodFrom: utcToLocalDate(base),
        periodTo: utcToLocalDate(periodEnd),
        method: c.discountPct > 0 ? 'promo' : 'card',
        payer: await payerSnapshot(tx, c.businessId),
        paidAt: now,
      },
    });
    await tx.subscriptionCharge.update({ where: { id: chargeId }, data: { status: 'paid', providerRef, paidAt: now, invoiceId: invoice.id, periodStart: base, periodEnd } });
    await tx.subscription.update({
      where: { businessId: c.businessId },
      data: {
        status: 'active',
        paidUntil: periodEnd,
        freeUntil: null,
        graceUntil: null,
        retryAt: null,
        warnedDays: null,
        ...(c.discountPct > 0 && !sub.promoUsedAt ? { promoUsedAt: now } : {}),
        version: { increment: 1 },
      },
    });
    // Первая оплата картой запоминает способ для автопродления (F-15-082) — токен даёт провайдер; заглушка — свой
    if (!sub.savedCardId && ['card', 'idram', 'telcell'].includes(c.method)) {
      const card = await tx.savedCard.create({
        data: { id: newId('savedCard'), businessId: c.businessId, provider: c.provider, method: c.method, token: providerRef, label: c.method === 'card' ? `•• ${providerRef.replace(/\D/g, '').slice(-4).padStart(4, '0')}` : c.method === 'idram' ? 'Idram' : 'Telcell' },
      });
      await tx.subscription.update({ where: { businessId: c.businessId }, data: { savedCardId: card.id } });
    }
    await publish(tx, c.businessId, true);
    return invoice.id;
  });
}

/** Оплата «счёта для фирмы» пришла (наша панель): счёт оплачен, срок продлён */
export async function markInvoicePaid(prisma: PrismaService, invoiceId: string) {
  const charge = await prisma.subscriptionCharge.findFirst({ where: { invoiceId, method: 'invoice' } });
  if (!charge) throw new ApiError('not_found', 'Invoice charge not found');
  if (charge.status === 'paid') return;
  await prisma.$transaction(async (tx) => {
    const sub = await ensureSubscription(tx, charge.businessId);
    const now = new Date();
    const base = sub.paidUntil > now ? sub.paidUntil : startOfLocalDay(todayLocal());
    const periodEnd = addLocal(base, charge.months, 'month');
    await tx.billingInvoice.update({ where: { id: invoiceId }, data: { status: 'paid', paidAt: now } });
    await tx.subscriptionCharge.update({ where: { id: charge.id }, data: { status: 'paid', paidAt: now, periodStart: base, periodEnd } });
    await tx.subscription.update({
      where: { businessId: charge.businessId },
      data: { status: 'active', paidUntil: periodEnd, freeUntil: null, graceUntil: null, retryAt: null, warnedDays: null, ...(charge.discountPct > 0 && !sub.promoUsedAt ? { promoUsedAt: now } : {}), version: { increment: 1 } },
    });
    await publish(tx, charge.businessId, true);
  });
}

// ─────────── ход подписки во времени (06 §3.3) ───────────

export interface TickResult {
  warned: number;
  charged: number;
  failed: number;
  grace: number;
  frozen: number;
}

type Notifier = (businessId: string, key: 'billing.endingSoon' | 'billing.paymentFailed' | 'billing.frozen', params: Record<string, string | number>, dedupe: string) => Promise<void>;

/**
 * Воркер (ежедневно 03:00 по Еревану + каждые 5 мин для повторов): предупреждения за 7/3/1 день (F-00-023),
 * автопродление с сохранённой карты, неудача → отсрочка graceDays (В-02) с повтором раз в сутки, отсрочка истекла →
 * заморозка: бизнес скрыт из каталога и по ссылке (F-00-024), кабинет только для чтения. Идемпотентно: повторный
 * проход в тот же день ничего не удваивает (warnedDays, retryAt, ключи дублей уведомлений).
 */
export async function billingTick(prisma: PrismaService, payments: PaymentProvider, notify: Notifier): Promise<TickResult> {
  const res: TickResult = { warned: 0, charged: 0, failed: 0, grace: 0, frozen: 0 };
  const prices = await loadPrices(prisma);
  const now = new Date();
  const horizon = addLocal(now, 8, 'day');
  const subs = await prisma.subscription.findMany({
    where: { OR: [{ status: { in: ['active', 'trial', 'trial_free'] }, paidUntil: { lt: horizon } }, { status: 'grace' }] },
  });
  for (const sub of subs) {
    const paidDate = utcToLocalDate(sub.paidUntil);
    // пробный период регистрации (trial) — как оплаченный срок: предупреждения, потом отсрочка и заморозка
    if (sub.status === 'active' || sub.status === 'trial' || sub.status === 'trial_free') {
      const days = daysUntil(sub.paidUntil);
      if (sub.paidUntil > now) {
        if ([7, 3, 1].includes(days) && sub.warnedDays !== days) {
          await notify(sub.businessId, 'billing.endingSoon', { days }, `billing:warn:${sub.businessId}:${paidDate}:${days}`);
          await prisma.subscription.update({ where: { businessId: sub.businessId }, data: { warnedDays: days } });
          res.warned++;
        }
        continue;
      }
      // Срок вышел: автопродление с сохранённой карты, иначе — сразу отсрочка без попыток
      if (sub.autoRenew && sub.savedCardId) {
        const card = await prisma.savedCard.findUnique({ where: { id: sub.savedCardId } });
        const ok = card && !card.unavailable ? await tryAutoCharge(prisma, payments, sub.businessId, card.method as PayMethod) : false;
        if (ok) {
          res.charged++;
          continue;
        }
        res.failed++;
        await notify(sub.businessId, 'billing.paymentFailed', {}, `billing:fail:${sub.businessId}:${paidDate}:${todayLocal()}`);
      }
      await prisma.subscription.update({
        where: { businessId: sub.businessId },
        data: { status: 'grace', graceUntil: addLocal(sub.paidUntil, prices.graceDays, 'day'), retryAt: addLocal(now, 1, 'day'), version: { increment: 1 } },
      });
      res.grace++;
      continue;
    }
    // grace
    if (sub.graceUntil && now >= sub.graceUntil) {
      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({ where: { businessId: sub.businessId }, data: { status: 'frozen', retryAt: null, version: { increment: 1 } } });
        await publish(tx, sub.businessId, false);
      });
      await notify(sub.businessId, 'billing.frozen', {}, `billing:frozen:${sub.businessId}:${paidDate}`);
      res.frozen++;
      continue;
    }
    if (sub.autoRenew && sub.savedCardId && sub.retryAt && now >= sub.retryAt) {
      const card = await prisma.savedCard.findUnique({ where: { id: sub.savedCardId } });
      const ok = card && !card.unavailable ? await tryAutoCharge(prisma, payments, sub.businessId, card.method as PayMethod) : false;
      if (ok) res.charged++;
      else {
        res.failed++;
        await prisma.subscription.update({ where: { businessId: sub.businessId }, data: { retryAt: addLocal(now, 1, 'day') } });
      }
    }
  }
  return res;
}

async function tryAutoCharge(prisma: PrismaService, payments: PaymentProvider, businessId: string, method: PayMethod): Promise<boolean> {
  try {
    const r = await chargeSubscription(prisma, payments, { businessId, months: 1, method, trigger: 'auto', by: 'system' });
    return r.status === 'paid' || r.status === 'pending';
  } catch {
    return false;
  }
}
