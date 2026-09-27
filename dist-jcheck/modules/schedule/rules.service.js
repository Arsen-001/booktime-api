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
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { nowLocal } from '../../common/time/time.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { addDays, newSlotRule, resolveSlotRule } from '../availability/engine.js';
import { personKeyOf } from '../availability/occupy.js';
import { actorOf, ScheduleService } from './schedule.service.js';
const baseRule = () => newSlotRule('scr_default', { isBase: true });
/**
 * Правила онлайн-записи (F-02-041…055, F-02-059, F-02-067): правило окон по филиалу или «персонально» мастеру,
 * исключения по дням недели, ручное выключение времени, недоступные дни, запас между клиентами, окно услуги.
 * Любая правка сбрасывает кеш окон бизнеса и пишет строку «История правок» (recheck-c3).
 */
let RulesService = class RulesService {
    constructor(schedule, availability) {
        this.schedule = schedule;
        this.availability = availability;
    }
    get prisma() {
        return this.schedule.prisma;
    }
    /** scope принадлежит бизнесу: филиал или сотрудник этого бизнеса */
    async assertScope(db, businessId, kind, id) {
        const ok = kind === 'location'
            ? await db.location.findFirst({ where: { id, businessId }, select: { id: true } })
            : await db.staff.findFirst({ where: { id, businessId }, select: { id: true } });
        if (!ok)
            throw new ApiError('not_found', 'Scope not found');
    }
    /** Правило окон правит schedule.edit; свои правила мастер — только себе */
    assertEdit(ctx, kind, id) {
        if (kind === 'staff')
            this.schedule.assertCanEdit(ctx, [id]);
        else if (!ctx.member.permissions.has('schedule.edit') || !(ctx.member.permissions.has('journal.others') || ctx.member.kind === 'individual')) {
            throw new ApiError('forbidden', 'Location rules are edited by an administrator');
        }
    }
    async row(db, kind, id) {
        const r = await db.onlineSlotRuleSet.findUnique({ where: { scope_scopeId: { scope: kind, scopeId: id } } });
        if (!r)
            return null;
        return {
            scope: r.scope,
            scopeId: r.scopeId,
            rules: r.rules ?? null,
            ownRules: r.ownRules,
            unavailable: r.unavailable ?? [],
            bufferMin: r.bufferMin,
        };
    }
    /** Правка строки правил под замком (SELECT … FOR UPDATE), журнал, сброс кеша */
    async edit(ctx, businessId, kind, id, what, fn, log = {}) {
        this.assertEdit(ctx, kind, id);
        const next = await this.prisma.$transaction(async (tx) => {
            await this.assertScope(tx, businessId, kind, id);
            await tx.onlineSlotRuleSet.upsert({
                where: { scope_scopeId: { scope: kind, scopeId: id } },
                create: { scope: kind, scopeId: id, businessId },
                update: {},
            });
            await tx.$queryRaw `SELECT scope FROM online_slot_rules WHERE scope = ${kind} AND scope_id = ${id} FOR UPDATE`;
            const cur = (await this.row(tx, kind, id));
            const patch = fn(cur);
            await tx.onlineSlotRuleSet.update({
                where: { scope_scopeId: { scope: kind, scopeId: id } },
                data: {
                    ...(patch.rules !== undefined ? { rules: patch.rules === null ? Prisma.DbNull : patch.rules } : {}),
                    ...(patch.ownRules !== undefined ? { ownRules: patch.ownRules } : {}),
                    ...(patch.unavailable !== undefined ? { unavailable: patch.unavailable } : {}),
                    ...(patch.bufferMin !== undefined ? { bufferMin: patch.bufferMin } : {}),
                    version: { increment: 1 },
                },
            });
            const actor = actorOf(ctx);
            await this.schedule.pushHistory(tx, businessId, {
                action: 'slot_rules',
                targetStaffIds: kind === 'staff' ? [id] : [],
                dates: log.dates ?? [],
                details: { what, role: actor.role, ...(log.before !== undefined ? { before: log.before } : {}), ...(log.after !== undefined ? { after: log.after } : {}) },
                actorName: actor.name,
                actorStaffId: actor.staffId,
            });
            return { ...cur, ...patch };
        });
        await this.availability.invalidate({ businessIds: [businessId], ...(kind === 'staff' ? { staffIds: [id] } : {}) });
        return next;
    }
    // ─────────── «Общее по локации» / «Персонально» (F-02-041) ───────────
    async slotMode(businessId, staffId) {
        await this.assertScope(this.prisma, businessId, 'staff', staffId);
        return (await this.row(this.prisma, 'staff', staffId))?.ownRules ? 'own' : 'location';
    }
    /** Первое «Персонально» копирует правила филиала — окна не пропадают */
    async setSlotMode(ctx, businessId, staffId, locationId, mode) {
        const location = await this.row(this.prisma, 'location', locationId);
        await this.edit(ctx, businessId, 'staff', staffId, 'own_rules', (cur) => ({
            ownRules: mode === 'own',
            ...(mode === 'own' && !cur.rules ? { rules: (location?.rules ?? [baseRule()]).map((r) => ({ ...r, id: newId('slotRule') })) } : {}),
        }), { after: mode });
    }
    async rules(businessId, kind, id) {
        await this.assertScope(this.prisma, businessId, kind, id);
        const rules = (await this.row(this.prisma, kind, id))?.rules;
        return rules && rules.length ? rules : [baseRule()];
    }
    async effectiveRule(businessId, staffId, locationId, date) {
        const own = await this.row(this.prisma, 'staff', staffId);
        await this.assertScope(this.prisma, businessId, 'staff', staffId);
        const rules = own?.ownRules ? own.rules : (await this.row(this.prisma, 'location', locationId))?.rules;
        return resolveSlotRule(rules, date);
    }
    async saveRule(ctx, businessId, kind, id, rule) {
        let saved = rule;
        await this.edit(ctx, businessId, kind, id, 'rule', (cur) => {
            const list = cur.rules && cur.rules.length ? cur.rules : [baseRule()];
            const idx = list.findIndex((r) => r.id === rule.id);
            saved = idx >= 0 ? rule : { ...rule, id: rule.id || newId('slotRule') };
            return { rules: idx >= 0 ? list.map((r, i) => (i === idx ? saved : r)) : [...list, saved] };
        });
        return saved;
    }
    async deleteRule(ctx, businessId, kind, id, ruleId) {
        await this.edit(ctx, businessId, kind, id, 'rule', (cur) => ({ rules: (cur.rules ?? []).filter((r) => r.id !== ruleId || r.isBase) }));
    }
    async toggleSlot(ctx, businessId, kind, id, ruleId, time) {
        await this.edit(ctx, businessId, kind, id, 'slot', (cur) => ({
            rules: (cur.rules && cur.rules.length ? cur.rules : [baseRule()]).map((r) => r.id !== ruleId ? r : { ...r, disabledSlots: r.disabledSlots.includes(time) ? r.disabledSlots.filter((t) => t !== time) : [...r.disabledSlots, time] }),
        }), { after: time });
    }
    async togglePart(ctx, businessId, kind, id, ruleId, times, enable) {
        await this.edit(ctx, businessId, kind, id, 'slot', (cur) => ({
            rules: (cur.rules && cur.rules.length ? cur.rules : [baseRule()]).map((r) => {
                if (r.id !== ruleId)
                    return r;
                const set = new Set(r.disabledSlots);
                for (const t of times) {
                    if (enable)
                        set.delete(t);
                    else
                        set.add(t);
                }
                return { ...r, disabledSlots: [...set] };
            }),
        }));
    }
    // ─────────── недоступные дни (F-02-042/043) ───────────
    async unavailable(businessId, kind, id) {
        await this.assertScope(this.prisma, businessId, kind, id);
        return (await this.row(this.prisma, kind, id))?.unavailable ?? [];
    }
    async addUnavailable(ctx, businessId, kind, id, range) {
        if (range.to < range.from)
            throw new ApiError('invalid_range', 'Range end before start');
        const created = { ...range, id: newId('unavailableRange') };
        await this.edit(ctx, businessId, kind, id, 'closed_days', (cur) => ({ unavailable: [...cur.unavailable, created] }), { dates: [range.from, range.to] });
        return created;
    }
    async removeUnavailable(ctx, businessId, kind, id, rangeId) {
        await this.edit(ctx, businessId, kind, id, 'closed_days', (cur) => ({ unavailable: cur.unavailable.filter((r) => r.id !== rangeId) }));
    }
    // ─────────── запас между клиентами (F-02-059) ───────────
    async buffer(businessId, kind, id) {
        await this.assertScope(this.prisma, businessId, kind, id);
        return (await this.row(this.prisma, kind, id))?.bufferMin ?? 0;
    }
    async setBuffer(ctx, businessId, kind, id, minutes) {
        const cur = await this.row(this.prisma, kind, id);
        await this.edit(ctx, businessId, kind, id, 'buffer', () => ({ bufferMin: minutes }), { before: String(cur?.bufferMin ?? 0), after: String(minutes) });
    }
    // ─────────── «Услуга доступна ограниченное время» (F-02-067) ───────────
    async serviceWindow(businessId, serviceId) {
        const svc = await this.prisma.service.findFirst({ where: { id: serviceId, businessId }, select: { onlineWindow: true } });
        if (!svc)
            throw new ApiError('not_found', 'Service not found');
        return svc.onlineWindow ? { ...svc.onlineWindow, serviceId } : null;
    }
    async setServiceWindow(businessId, serviceId, window) {
        const res = await this.prisma.service.updateMany({
            where: { id: serviceId, businessId },
            data: { onlineWindow: window ? window : Prisma.DbNull, version: { increment: 1 } },
        });
        if (!res.count)
            throw new ApiError('not_found', 'Service not found');
        await this.availability.invalidate({ businessIds: [businessId] });
    }
    // ─────────── F-02-094: свободные и занятые слоты по мастерам ───────────
    async utilization(businessId, staffIds, from, to, locationId) {
        const settings = await this.availability.settings(this.prisma, businessId);
        const rules = await this.availability.ruleSets(this.prisma, businessId);
        const staff = await this.availability.staffRows(this.prisma, { businessId, id: { in: staffIds } });
        const out = [];
        for (const s of staff) {
            let freeCount = 0;
            let busyCount = 0;
            for (let d = from, i = 0; d <= to && i < 93; d = addDays(d, 1), i++) {
                freeCount += (await this.availability.computeFree(this.prisma, businessId, { staffId: s.id, date: d, durationMin: 30, locationId }, { settings, rules })).length;
                busyCount += (await this.availability.busyMinutes(this.prisma, personKeyOf(s), d)).length;
            }
            out.push({ staffId: s.id, freeCount, busyCount });
        }
        return out;
    }
    // ─────────── зеркало для разделов, ещё живущих на моке (PLAN §7, переходный слой до этапа 21) ───────────
    async mirror(businessId) {
        const today = nowLocal().slice(0, 10);
        const from = addDays(today, -60);
        const to = addDays(today, 800);
        const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true } });
        const ids = staff.map((s) => s.id);
        const [schedules, marks, types, ruleRows, settings, services] = await Promise.all([
            this.availability.schedules(this.prisma, ids, from, to),
            this.availability.marks(this.prisma, ids, from, to),
            this.prisma.staffDayType.findMany({ where: { businessId, date: { gte: from, lte: to } } }),
            this.prisma.onlineSlotRuleSet.findMany({ where: { businessId } }),
            this.availability.settings(this.prisma, businessId),
            this.prisma.service.findMany({ where: { businessId, NOT: { onlineWindow: { equals: Prisma.DbNull } } }, select: { id: true, onlineWindow: true } }),
        ]);
        const key = (r) => `${r.scope}:${r.scopeId}`;
        return {
            staffIds: ids,
            schedules: schedules.map((s) => ({
                id: s.id,
                staffId: s.staffId,
                locationId: s.locationId,
                workplace: s.workplace,
                week: s.week,
                overrides: s.overrides,
                ...(s.openUntil ? { openUntil: s.openUntil } : {}),
            })),
            calendarMarks: marks.map((m) => ({
                id: m.id,
                staffId: m.staffId,
                date: m.date,
                from: m.from,
                to: m.to,
                kind: m.kind,
                ...(m.workplace ? { workplace: m.workplace } : {}),
                ...(m.note ? { note: m.note } : {}),
            })),
            days: types.map((t) => ({ staffId: t.staffId, date: t.date, typeId: t.typeId, ...(t.vacationUntil ? { vacationUntil: t.vacationUntil } : {}) })),
            slotRules: Object.fromEntries(ruleRows.filter((r) => r.rules).map((r) => [key(r), r.rules])),
            slotMode: Object.fromEntries(ruleRows.filter((r) => r.scope === 'staff' && r.ownRules).map((r) => [r.scopeId, 'own'])),
            unavailableDays: Object.fromEntries(ruleRows.filter((r) => r.unavailable).map((r) => [key(r), r.unavailable])),
            bufferMin: Object.fromEntries(ruleRows.filter((r) => r.bufferMin !== null).map((r) => [key(r), r.bufferMin])),
            serviceSlotWindows: Object.fromEntries(services.map((s) => [s.id, { ...s.onlineWindow, serviceId: s.id }])),
            settings,
        };
    }
};
RulesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ScheduleService,
        AvailabilityService])
], RulesService);
export { RulesService };
//# sourceMappingURL=rules.service.js.map