var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, nowLocal, utcToLocal } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { eachDay, fromMinutes, intersectIntervals, mergeIntervals, staffDayHours, staffWorkIntervals, subtractInterval, toMinutes, } from '../availability/engine.js';
import { personKeyOf } from '../availability/occupy.js';
import { FinanceCatalogService, SYSTEM_ITEMS } from '../finance/finance-catalog.service.js';
import { FinOpsService } from '../finance/fin-ops.service.js';
import { extrasOf } from '../journal/rules.js';
import { LoyaltyInstancesService } from '../loyalty/loyalty-instances.service.js';
import { ownerOf } from '../loyalty/loyalty.owner.js';
import { StockCatalogService } from '../stock/stock-catalog.service.js';
import { StockOpsService } from '../stock/stock-ops.service.js';
const arr = (v) => (Array.isArray(v) ? v : []);
/** Отменённые не занимают время и не считаются «записанными» (INACTIVE фронта, src/api/journal.ts) */
const INACTIVE = new Set(['cancelled_by_client', 'cancelled_by_master']);
/**
 * Палитра лаков салона (DESIGN.md, F-00-094) — та же, что LACQUER_SHADES сида среза journal фронта.
 * Своего поля «оттенок» у записи ещё нет: оттенок берётся из палитры детерминированно по id записи,
 * тем же хэшем, что `lacquersOf()` фронта, — одинаковый в режимах mock и api.
 */
const LACQUER_SHADES = [
    { name: 'Nude 012', hex: '#e9c6bd' },
    { name: 'Cherry 207', hex: '#9b1b30' },
    { name: 'Rose milk', hex: '#e3a9c1' },
    { name: 'Navy 402', hex: '#1f3a5f' },
    { name: 'Sage 118', hex: '#8fb9a8' },
    { name: 'Emerald 305', hex: '#2e7d6b' },
    { name: 'Latte 051', hex: '#cdb49a' },
    { name: 'Lilac 233', hex: '#9b86d1' },
    { name: 'Coral 144', hex: '#e8836b' },
    { name: 'Plum 390', hex: '#6b2d5c' },
];
/** JournalLedgerCategory фронта → системная статья финансов (SYSTEM_ITEMS) */
const LEDGER_ITEM = {
    materials: 'materialsPurchase',
    goods_purchase: 'goodsPurchase',
    salary: 'staffPayroll',
    taxes: 'taxes',
    services: 'servicePayment',
    membership_sale: 'membershipSale',
    other_income: 'otherIncome',
    other_expense: 'otherExpense',
    topup: 'accountTopUp',
    acquiring_fee: 'acquiringFee',
    certificate_sale: 'certificateSale',
    penalty_writeoff: 'penaltyCharge',
};
const LEDGER_PARTY = { contractor: 'counterparty', client: 'client', staff: 'staff' };
const PARTY_LEDGER = { counterparty: 'contractor', client: 'client', staff: 'staff' };
const EMPTY_PREFS = { clientCardPins: [], favorites: [], waitlistPanelOpen: false };
const prefsArea = (userKey) => `jprefs:${userKey}`.slice(0, 40);
const DRAFTS_AREA = 'journal.drafts';
const MAX_DRAFTS = 200;
/**
 * Этап 21, лейн «journal»: то, что экраны журнала раньше считали у себя по моковой базе браузера (часы
 * сетки, загрузка дней, лаки, статистика клиента, частые услуги, сводка дня, окна пакета, личные закрепления,
 * черновик окна записи, продажа вне визита, «Новый платёж»). Всё читает настоящие таблицы; деньги
 * «Нового платежа» и продажи вне визита идут в настоящую кассу (FinOp), товар — со склада (StockOp).
 */
let JournalMoreService = class JournalMoreService {
    constructor(prisma, availability, stockCatalog, stockOps, finCatalog, finOps, loyalty) {
        this.prisma = prisma;
        this.availability = availability;
        this.stockCatalog = stockCatalog;
        this.stockOps = stockOps;
        this.finCatalog = finCatalog;
        this.finOps = finOps;
        this.loyalty = loyalty;
    }
    async tzOf(businessId) {
        const loc = await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
        return loc?.tz ?? DEFAULT_TZ;
    }
    async assertStaff(businessIds, staffIds) {
        if (!staffIds.length)
            return [];
        const rows = await this.prisma.staff.findMany({ where: { id: { in: staffIds }, businessId: { in: businessIds } }, select: { id: true } });
        return rows.map((r) => r.id);
    }
    // ─────────── часы и загрузка (F-01-013, F-01-019, F-01-023, F-01-003/004) ───────────
    /** Рабочие часы набора сотрудников по дням: {staffId: {date: DayHours}} — сетка дня и недели */
    async staffHours(businessIds, staffIds, from, to, locationId) {
        const ids = await this.assertStaff(businessIds, staffIds);
        const days = eachDay(from, to).slice(0, 62);
        const schedules = await this.availability.schedules(this.prisma, ids, days[0], days[days.length - 1]);
        const out = {};
        for (const id of staffIds) {
            out[id] = {};
            for (const d of days)
                out[id][d] = ids.includes(id) ? staffDayHours(schedules, id, d, locationId) : [];
        }
        return out;
    }
    /** Загрузка дней диапазона: доля занятого рабочего времени и «есть ли график» — мини-календарь */
    async rangeLoad(businessIds, staffIds, from, to) {
        const ids = await this.assertStaff(businessIds, staffIds);
        const days = eachDay(from, to).slice(0, 62);
        const schedules = await this.availability.schedules(this.prisma, ids, days[0], days[days.length - 1]);
        const tz = await this.tzOf(businessIds[0]);
        const rows = ids.length
            ? await this.prisma.booking.findMany({
                where: {
                    staffId: { in: ids },
                    deletedAt: null,
                    status: { notIn: [...INACTIVE] },
                    startAt: { gte: localDayRangeUtc(days[0], tz).from, lt: localDayRangeUtc(days[days.length - 1], tz).to },
                },
                select: { startAt: true, durationMin: true },
            })
            : [];
        const busyByDay = new Map();
        for (const b of rows) {
            const d = utcToLocal(b.startAt, tz).slice(0, 10);
            busyByDay.set(d, (busyByDay.get(d) ?? 0) + b.durationMin);
        }
        const out = {};
        for (const d of days) {
            let worked = 0;
            let hasSchedule = false;
            for (const id of ids) {
                const hours = staffDayHours(schedules, id, d);
                if (hours.length)
                    hasSchedule = true;
                worked += hours.reduce((s, r) => s + (toMinutes(r.to) - toMinutes(r.from)), 0);
            }
            out[d] = { ratio: worked === 0 ? 0 : Math.min((busyByDay.get(d) ?? 0) / worked, 1), hasSchedule };
        }
        return out;
    }
    // ─────────── лаки (F-00-094) ───────────
    async lacquers(businessIds, q) {
        const where = { businessId: { in: businessIds } };
        if (q.ids?.length)
            where.id = { in: q.ids.slice(0, 500) };
        else if (q.date) {
            const tz = await this.tzOf(businessIds[0]);
            const r = localDayRangeUtc(q.date, tz);
            where.startAt = { gte: r.from, lt: r.to };
        }
        else
            return {};
        const rows = await this.prisma.booking.findMany({ where, select: { id: true, services: true } });
        const serviceIds = [...new Set(rows.flatMap((b) => arr(b.services).map((l) => l.serviceId)))];
        const shadeServices = new Set((await this.prisma.service.findMany({ where: { id: { in: serviceIds }, shadeChoice: { not: null } }, select: { id: true, shadeChoice: true } }))
            .filter((s) => s.shadeChoice && s.shadeChoice !== 'none')
            .map((s) => s.id));
        const out = {};
        for (const b of rows) {
            if (!arr(b.services).some((l) => shadeServices.has(l.serviceId)))
                continue;
            let h = 0;
            for (let i = 0; i < b.id.length; i++)
                h = (h * 31 + b.id.charCodeAt(i)) >>> 0;
            out[b.id] = LACQUER_SHADES[h % LACQUER_SHADES.length];
        }
        return out;
    }
    // ─────────── клиент в окне записи (F-01-071, F-01-056, F-00-060, F-01-129, F-01-163) ───────────
    async clientVisitStats(businessIds, clientId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId: { in: businessIds } }, select: { noShowCount: true } });
        const rows = await this.prisma.booking.findMany({
            where: { clientId, businessId: { in: businessIds } },
            select: { status: true, total: true, paidAmount: true, startAt: true },
        });
        const arrived = rows.filter((b) => b.status === 'arrived');
        const sold = arrived.reduce((s, b) => s + Number(b.total), 0);
        const paid = rows.reduce((s, b) => s + Number(b.paidAmount), 0);
        const last = arrived.map((b) => b.startAt).sort((a, b) => a.getTime() - b.getTime()).at(-1);
        const tz = await this.tzOf(businessIds[0]);
        return {
            totalVisits: arrived.length,
            sold,
            paid,
            balance: paid - sold,
            noShowCount: client?.noShowCount ?? 0,
            ...(last ? { lastVisitAt: utcToLocal(last, tz) } : {}),
        };
    }
    /** Id самых частых индивидуальных активных услуг мастера по его записям (порядок = частота) */
    async frequentServices(businessId, staffId, limit) {
        const rows = await this.prisma.booking.findMany({ where: { businessId, staffId, deletedAt: null }, select: { services: true }, orderBy: { startAt: 'desc' }, take: 2000 });
        const counts = new Map();
        for (const b of rows)
            for (const l of arr(b.services))
                counts.set(l.serviceId, (counts.get(l.serviceId) ?? 0) + 1);
        if (!counts.size)
            return [];
        const services = (await this.prisma.service.findMany({ where: { id: { in: [...counts.keys()] }, businessId, active: true, kind: 'individual' }, select: { id: true, staffIds: true } })).filter((s) => arr(s.staffIds).includes(staffId));
        return services
            .map((s) => s.id)
            .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
            .slice(0, Math.min(Math.max(limit, 1), 20));
    }
    // ─────────── сводка дня (F-01-011) ───────────
    async daySummary(businessId, date) {
        const tz = await this.tzOf(businessId);
        const r = localDayRangeUtc(date, tz);
        const rows = await this.prisma.booking.findMany({ where: { businessId, deletedAt: null, startAt: { gte: r.from, lt: r.to } } });
        const clientIds = new Set();
        let bookedTotal = 0;
        let doneTotal = 0;
        let goodsTotal = 0;
        let cashIn = 0;
        let cash = 0;
        let loyaltyTotal = 0;
        for (const b of rows) {
            const total = Number(b.total);
            bookedTotal += total;
            if (b.clientId)
                clientIds.add(b.clientId);
            const extras = extrasOf(b);
            const lineGoods = extras.goodsLines.reduce((s, g) => s + Math.round(g.price * g.qty * (1 - g.discountPct / 100)), 0);
            goodsTotal += lineGoods;
            if (b.status === 'arrived')
                doneTotal += total + lineGoods;
            cashIn += Number(b.paidAmount);
            for (const p of extras.payments ?? []) {
                if (p.method === 'cash')
                    cash += p.amount;
                else if (['loyalty', 'certificate', 'membership', 'bonus', 'account'].includes(p.method))
                    loyaltyTotal += p.amount;
            }
        }
        // Оплата без строк способов (старые записи): всё, что не разложено по способам, — наличными, как у мока
        const byMethods = rows.reduce((s, b) => s + (extrasOf(b).payments ?? []).reduce((x, p) => x + p.amount, 0), 0);
        cash += Math.max(0, cashIn - byMethods);
        return { cashIn, cash, cashless: Math.max(0, cashIn - cash - loyaltyTotal), doneTotal, bookedTotal, loyaltyTotal, goodsTotal, clientsCount: clientIds.size };
    }
    // ─────────── окна пакета (F-01-134, F-02-069) ───────────
    async packageSlots(businessId, locationId, date, steps, order) {
        if (!steps.length)
            return [];
        const staffIds = [...new Set(steps.map((s) => s.staffId))];
        const staff = await this.availability.staffRows(this.prisma, { id: { in: staffIds }, businessId });
        if (staff.length !== staffIds.length)
            throw new ApiError('staff_not_found', 'Staff not found');
        const loc = await this.prisma.location.findFirst({ where: { id: locationId, businessId }, select: { tz: true } });
        if (!loc)
            throw new ApiError('not_found', 'Location not found');
        const tz = loc.tz ?? DEFAULT_TZ;
        const now = nowLocal(tz);
        if (date < now.slice(0, 10))
            return [];
        const [schedules, marks, rules] = await Promise.all([
            this.availability.schedules(this.prisma, staffIds, date, date),
            this.availability.marks(this.prisma, staffIds, date, date),
            this.availability.ruleSets(this.prisma, businessId),
        ]);
        const free = new Map();
        for (const s of staff) {
            let list = mergeIntervals(staffWorkIntervals(this.availability.toStaffLike(s), schedules, marks, date, { locationId }).map((w) => [w.from, w.to]));
            for (const b of await this.availability.busyMinutes(this.prisma, personKeyOf(s), date, tz))
                list = subtractInterval(list, [b.from, b.to]);
            if (date === now.slice(0, 10))
                list = intersectIntervals(list, [[toMinutes(now.slice(11, 16)), 24 * 60]]);
            free.set(s.id, list);
        }
        const buffer = (st) => st.bufferAfterMin || (rules.get(`staff:${st.staffId}`)?.bufferMin ?? rules.get(`location:${locationId}`)?.bufferMin ?? 0);
        const at = (m) => `${date}T${fromMinutes(m)}`;
        const STEP = 5;
        const out = [];
        if (order === 'parallel') {
            const need = Math.max(...steps.map((s) => s.durationMin + buffer(s)));
            const longest = Math.max(...steps.map((s) => s.durationMin));
            let common = [[0, 24 * 60]];
            for (const s of steps)
                common = intersectIntervals(common, free.get(s.staffId) ?? []);
            for (const [a, b] of common)
                for (let t = a; t + need <= b; t += STEP)
                    out.push({ start: at(t), end: at(t + longest) });
            return out;
        }
        if (order === 'sequential_one') {
            const staffId = steps[0].staffId;
            if (!steps.every((s) => s.staffId === staffId))
                return [];
            const need = steps.reduce((sum, s) => sum + s.durationMin + buffer(s), 0);
            const total = steps.reduce((sum, s) => sum + s.durationMin, 0);
            for (const [a, b] of free.get(staffId) ?? [])
                for (let t = a; t + need <= b; t += STEP)
                    out.push({ start: at(t), end: at(t + total) });
            return out;
        }
        for (let t0 = 0; t0 < 24 * 60; t0 += STEP) {
            let t = t0;
            let ok = true;
            for (const s of steps) {
                const need = s.durationMin + buffer(s);
                if (!(free.get(s.staffId) ?? []).some(([a, b]) => t >= a && t + need <= b)) {
                    ok = false;
                    break;
                }
                t += need;
            }
            if (ok)
                out.push({ start: at(t0), end: at(t) });
        }
        return out;
    }
    // ─────────── личные настройки и черновик окна записи ───────────
    async prefs(businessId, userKey) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: prefsArea(userKey) } } });
        const stored = { ...EMPTY_PREFS, ...(row?.data ?? {}) };
        // Строки, записанные до проверки формы (без labelKey/href), не отдаём — экран строит по ним ссылки
        const favorites = (Array.isArray(stored.favorites) ? stored.favorites : []).filter((f) => f && typeof f.id === 'string' && typeof f.labelKey === 'string' && typeof f.href === 'string' && f.href.startsWith('/'));
        return { ...stored, favorites };
    }
    async patchPrefs(ctx, businessId, userKey, patch) {
        const next = { ...(await this.prefs(businessId, userKey)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
        const data = next;
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: prefsArea(userKey) } },
            create: { businessId, area: prefsArea(userKey), data, updatedBy: ctx.member.staffId },
            update: { data, updatedBy: ctx.member.staffId, version: { increment: 1 } },
        });
        return next;
    }
    async drafts(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: DRAFTS_AREA } } });
        return row?.data ?? {};
    }
    async draft(businessId, key) {
        return { draft: (await this.drafts(businessId))[key]?.data ?? null };
    }
    async setDraft(ctx, businessId, key, data) {
        const all = await this.drafts(businessId);
        if (data === null)
            delete all[key];
        else
            all[key] = { at: Date.now(), data };
        const keep = Object.entries(all)
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, MAX_DRAFTS);
        const json = Object.fromEntries(keep);
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: DRAFTS_AREA } },
            create: { businessId, area: DRAFTS_AREA, data: json, updatedBy: ctx.member.staffId },
            update: { data: json, updatedBy: ctx.member.staffId },
        });
    }
    // ─────────── продажа вне визита (F-01-010, F-04-219) ───────────
    /** Каталог «Продать»: товары склада (остаток на складах «для продажи»), типы абонементов и сертификатов */
    async goodsCatalog(ctx, locationId) {
        const businessId = ctx.member.businessId;
        const byLocation = locationId && locationId !== 'all' ? locationId : undefined;
        const warehouses = await this.prisma.warehouse.findMany({ where: { businessId, type: 'sale', ...(byLocation ? { locationId: byLocation } : {}) }, select: { id: true } });
        const saleIds = new Set(warehouses.map((w) => w.id));
        const goods = await this.prisma.product.findMany({ where: { businessId, archived: false, ...(byLocation ? { locationId: byLocation } : {}) }, orderBy: { name: 'asc' }, take: 500 });
        const products = [];
        for (const g of goods) {
            const levels = await this.stockCatalog.computeLevels(businessId, g.id);
            const stock = levels.filter((l) => saleIds.has(l.warehouseId)).reduce((s, l) => s + l.qty, 0);
            products.push({ id: g.id, name: g.name, kind: 'product', price: Number(g.salePrice), stock, requiresCode: false });
        }
        products.sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || a.name.localeCompare(b.name));
        const owner = ownerOf(ctx);
        const [memberships, certificates] = await Promise.all([
            this.prisma.membershipType.findMany({ where: { ownerId: owner, archived: false }, orderBy: { name: 'asc' } }),
            this.prisma.certificateType.findMany({ where: { ownerId: owner, archived: false }, orderBy: { name: 'asc' } }),
        ]);
        return [
            ...products,
            ...memberships.map((m) => ({ id: m.id, name: m.name, kind: 'subscription', price: Number(m.price), stock: 0, requiresCode: false, autoWriteoffAllowed: true })),
            ...certificates.map((c) => ({ id: c.id, name: c.name, kind: 'certificate', price: Number(c.faceValue), stock: 0, requiresCode: false })),
        ];
    }
    async register(businessId, locationId, method) {
        const list = await this.finCatalog.listCashRegisters(businessId, [locationId]);
        return list.find((a) => a.kind === method) ?? list[0];
    }
    async sell(ctx, body) {
        const businessId = ctx.member.businessId;
        const createdAt = nowLocal(await this.tzOf(businessId));
        const base = { qty: body.qty, paymentMethod: body.paymentMethod, createdAt, ...(body.clientId ? { clientId: body.clientId } : {}), ...(body.clientName ? { clientName: body.clientName } : {}) };
        const good = await this.prisma.product.findFirst({ where: { id: body.itemId, businessId } });
        if (good) {
            const locationId = body.locationId && body.locationId !== 'all' ? body.locationId : good.locationId;
            const whs = await this.prisma.warehouse.findMany({ where: { businessId, locationId }, orderBy: { order: 'asc' } });
            const warehouse = whs.find((w) => w.type === 'sale') ?? whs[0];
            if (!warehouse)
                throw new ApiError('validation', 'No warehouse', { locationId: 'no warehouse' });
            const doc = await this.stockOps.createSale(ctx, locationId, {
                locationId,
                warehouseId: warehouse.id,
                clientId: body.clientId,
                paymentMethod: body.paymentMethod,
                lines: [{ goodId: good.id, qtySale: body.qty, unitPrice: Number(good.salePrice) }],
            });
            if (!doc)
                throw new ApiError('internal', 'Sale not saved');
            return { id: doc.id, itemId: good.id, itemName: good.name, kind: 'product', totalPrice: Number(good.salePrice) * body.qty, ...base };
        }
        const locationId = body.locationId && body.locationId !== 'all' ? body.locationId : (await this.prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { id: true } }))?.id;
        const owner = ownerOf(ctx);
        const membership = await this.prisma.membershipType.findFirst({ where: { id: body.itemId, ownerId: owner } });
        const certificate = membership ? null : await this.prisma.certificateType.findFirst({ where: { id: body.itemId, ownerId: owner } });
        if (!membership && !certificate)
            throw new ApiError('not_found', 'Item not found');
        const ids = [];
        for (let i = 0; i < Math.max(1, Math.floor(body.qty)); i++) {
            const sold = membership
                ? await this.loyalty.sellMembership(ctx, membership.id, { clientId: body.clientId })
                : await this.loyalty.sellCertificate(ctx, certificate.id, { clientId: body.clientId });
            ids.push(sold.id);
        }
        const price = membership ? Number(membership.price) : Number(certificate.faceValue);
        const total = price * ids.length;
        // Деньги — в настоящую кассу филиала (продажа абонемента/сертификата сама по себе кассу не трогает)
        if (locationId && total > 0) {
            const account = await this.register(businessId, locationId, body.paymentMethod);
            if (account)
                await this.finOps.create(ctx, {
                    locationId,
                    accountId: account.id,
                    itemId: await this.finCatalog.systemItemId(businessId, membership ? 'membershipSale' : 'certificateSale'),
                    kind: 'income',
                    amount: total,
                    date: createdAt,
                    method: body.paymentMethod,
                    partyType: body.clientId ? 'client' : 'none',
                    partyId: body.clientId,
                    partyName: body.clientName,
                    source: 'sale',
                    refId: ids[0],
                    lineLabel: (membership?.name ?? certificate.name).slice(0, 160),
                });
        }
        return {
            id: ids[0],
            itemId: body.itemId,
            itemName: membership?.name ?? certificate.name,
            kind: membership ? 'subscription' : 'certificate',
            totalPrice: total,
            ...base,
        };
    }
    /** Отмена продажи вне визита: товар — документ склада отменяется (товар назад, выручка из кассы) */
    async cancelSale(ctx, id) {
        const businessId = ctx.member.businessId;
        const doc = await this.prisma.stockOp.findFirst({ where: { id, businessId, type: 'sale' } });
        if (!doc)
            throw new ApiError('not_found', 'Sale not found');
        if (doc.cancelledAt)
            return;
        await this.stockOps.cancelSale(ctx, id);
    }
    // ─────────── «Новый платёж» журнала (F-01-151, F-01-084) ───────────
    ledgerView(r, tz, items, registers) {
        const key = items.get(r.itemId)?.systemKey;
        const category = Object.entries(LEDGER_ITEM).find(([, v]) => v === key)?.[0] ?? (r.kind === 'income' ? 'other_income' : 'other_expense');
        return {
            id: r.id,
            locationId: r.locationId,
            at: utcToLocal(r.date, tz),
            category,
            cashRegister: registers.get(r.accountId) ?? '',
            counterpartyType: PARTY_LEDGER[r.partyType] ?? 'contractor',
            counterpartyName: r.partyName ?? '',
            amount: Number(r.amount),
            ...(r.comment ? { comment: r.comment } : {}),
            ...(r.cancelled ? { canceled: true } : {}),
            ...(r.createdBy ? { createdByStaffId: r.createdBy } : {}),
        };
    }
    async ledger(businessId, locationId) {
        const tz = await this.tzOf(businessId);
        const rows = await this.prisma.finOp.findMany({ where: { businessId, locationId, source: 'manual', kind: { in: ['income', 'expense'] } }, orderBy: { date: 'desc' }, take: 500 });
        const items = new Map((await this.prisma.paymentItem.findMany({ where: { businessId }, select: { id: true, systemKey: true } })).map((i) => [i.id, i]));
        const registers = new Map((await this.prisma.cashRegister.findMany({ where: { businessId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
        return rows.map((r) => this.ledgerView(r, tz, items, registers));
    }
    async createLedger(ctx, body) {
        const businessId = ctx.member.businessId;
        const itemKey = LEDGER_ITEM[body.category];
        if (!itemKey)
            throw new ApiError('validation', 'Unknown category', { category: 'unknown' });
        const account = await this.register(businessId, body.locationId, 'cash');
        if (!account)
            throw new ApiError('not_found', 'Cash register not found');
        const at = body.at.slice(0, 16);
        const op = await this.finOps.create(ctx, {
            locationId: body.locationId,
            accountId: account.id,
            itemId: await this.finCatalog.systemItemId(businessId, itemKey),
            kind: SYSTEM_ITEMS[itemKey].kind,
            amount: body.amount,
            date: at,
            method: 'cash',
            partyType: LEDGER_PARTY[body.counterpartyType] ?? 'none',
            partyName: body.counterpartyName,
            comment: body.comment,
            source: 'manual',
        }, 'manual');
        const row = await this.prisma.finOp.findUniqueOrThrow({ where: { id: op.id } });
        const items = new Map((await this.prisma.paymentItem.findMany({ where: { businessId }, select: { id: true, systemKey: true } })).map((i) => [i.id, i]));
        return this.ledgerView(row, await this.tzOf(businessId), items, new Map([[account.id, account.name]]));
    }
    async cancelLedger(ctx, id) {
        const row = await this.prisma.finOp.findFirst({ where: { id, businessId: ctx.member.businessId, source: 'manual' } });
        if (!row)
            throw new ApiError('not_found', 'Operation not found');
        await this.finOps.cancel(ctx, id);
    }
};
JournalMoreService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AvailabilityService,
        StockCatalogService,
        StockOpsService,
        FinanceCatalogService,
        FinOpsService,
        LoyaltyInstancesService])
], JournalMoreService);
export { JournalMoreService };
//# sourceMappingURL=journal-more.service.js.map