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
import { AuditService } from '../../common/audit/audit.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { clientBookings, withVisits } from '../clients/clients.visits.js';
import { clientRowView } from '../clients/clients.views.js';
const AREA = 'loyalty-program';
const VISIBILITY_AREA = 'loyalty';
function emptyProgram() {
    return {
        enabled: false,
        discountTiers: [],
        classRules: { bronze: {}, silver: {}, gold: {} },
        addRules: [],
        removeRules: [],
        settings: { cancelDiscountAfterDays: 360, cancelClassAfterDays: 360, discountEndWarnDays: null },
    };
}
function daysSince(iso, now) {
    if (!iso)
        return Number.POSITIVE_INFINITY;
    return Math.floor((now.getTime() - new Date(`${iso}T00:00:00Z`).getTime()) / 86_400_000);
}
function evalTrigger(rule, row, trigger, inactiveDays) {
    switch (rule.trigger) {
        case 'sold':
            return row.sold >= (rule.threshold ?? 0);
        case 'paid':
            return row.paid >= (rule.threshold ?? 0);
        case 'visits':
            return row.visits >= (rule.threshold ?? 0);
        case 'inactiveDays':
            return inactiveDays >= (rule.threshold ?? 0);
        case 'statusArrived':
            return trigger === 'statusArrived';
        case 'statusNoShow':
            return trigger === 'statusNoShow';
        default:
            return false;
    }
}
/**
 * Программа лояльности локации: автоскидка / класс важности / категории по тратам-визитам (F-04-114…122).
 * Отдельный, старый движок — не сетевая лояльность раздела 06 (card-types/promotions и т.д.), поэтому живёт
 * в business_settings, а не в новых таблицах loyalty_* (docs/backend/01 §5, порт src/api/clients/loyalty.ts).
 */
let LoyaltyProgramService = class LoyaltyProgramService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    async get(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
        return row?.data ?? emptyProgram();
    }
    /** В-06: «клиенту видно своё, если бизнес не выключил "показывать клиенту"» — по умолчанию включено */
    async getShowToClient(businessId) {
        const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: VISIBILITY_AREA } } });
        return row?.data?.showToClient ?? true;
    }
    async setShowToClient(ctx, businessId, showToClient) {
        await this.prisma.businessSetting.upsert({
            where: { businessId_area: { businessId, area: VISIBILITY_AREA } },
            create: { businessId, area: VISIBILITY_AREA, data: { showToClient }, updatedBy: ctx.member.staffId },
            update: { data: { showToClient }, updatedBy: ctx.member.staffId, version: { increment: 1 } },
        });
        return { showToClient };
    }
    async row(businessId, clientId) {
        const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId, deletedAt: null } });
        if (!client)
            return null;
        const bookings = await clientBookings(this.prisma, [businessId], [clientId]);
        return withVisits([clientRowView(client)], bookings, new Map())[0];
    }
    /** F-04-073 и три автоматических момента (F-04-121). null — правила выключены/клиента нет/ничего не изменилось. */
    async recalcOne(ctx, businessId, clientId, trigger, tx) {
        const program = await this.get(businessId);
        if (!program.enabled)
            return null;
        const row = await this.row(businessId, clientId);
        if (!row)
            return null;
        const now = new Date();
        const inactiveDays = daysSince(row.lastVisit, now);
        let discountAfter = 0;
        for (const t of program.discountTiers) {
            const value = t.basis === 'sold' ? row.sold : t.basis === 'paid' ? row.paid : row.visits;
            if (value >= t.from && t.percent > discountAfter)
                discountAfter = t.percent;
        }
        if (inactiveDays >= program.settings.cancelDiscountAfterDays)
            discountAfter = 0;
        let classAfter;
        for (const cls of ['gold', 'silver', 'bronze']) {
            const t = program.classRules[cls];
            const meets = (t.minSold !== undefined && row.sold >= t.minSold) || (t.minPaid !== undefined && row.paid >= t.minPaid) || (t.minVisits !== undefined && row.visits >= t.minVisits);
            if (meets) {
                classAfter = cls;
                break;
            }
        }
        if (inactiveDays >= program.settings.cancelClassAfterDays)
            classAfter = undefined;
        const tags = new Set(row.tags);
        const categoriesAdded = [];
        const categoriesRemoved = [];
        for (const rule of program.addRules) {
            if (tags.has(rule.category))
                continue;
            if (evalTrigger(rule, row, trigger, inactiveDays)) {
                tags.add(rule.category);
                categoriesAdded.push(rule.category);
            }
        }
        for (const rule of program.removeRules) {
            if (!tags.has(rule.category))
                continue;
            if (evalTrigger(rule, row, trigger, inactiveDays)) {
                tags.delete(rule.category);
                categoriesRemoved.push(rule.category);
            }
        }
        const discountBefore = row.discount;
        const classBefore = row.importanceClass;
        if (discountBefore === discountAfter && classBefore === classAfter && !categoriesAdded.length && !categoriesRemoved.length)
            return null;
        const write = async (t) => {
            await t.client.update({ where: { id: clientId }, data: { discountPercent: discountAfter, importanceClass: classAfter ?? null, tags: Array.from(tags), version: { increment: 1 } } });
            if (ctx)
                await this.audit.record(t, ctx, { action: 'loyaltyRecalc', entityType: 'client', entityId: clientId, businessId, before: { discount: discountBefore, importanceClass: classBefore ?? null }, after: { discount: discountAfter, importanceClass: classAfter ?? null } });
        };
        if (tx)
            await write(tx);
        else
            await this.prisma.$transaction((t) => write(t));
        return { clientId, discountBefore, discountAfter, classBefore, classAfter, categoriesAdded, categoriesRemoved };
    }
    async recalcAll(ctx, businessId, trigger) {
        const ids = await this.prisma.client.findMany({ where: { businessId, deletedAt: null }, select: { id: true } });
        let changed = 0;
        for (const { id } of ids) {
            const result = await this.recalcOne(ctx, businessId, id, trigger);
            if (result)
                changed++;
        }
        return changed;
    }
    /** F-04-121: сохранение программы пересчитывает всех клиентов локации сразу */
    async save(ctx, businessId, program) {
        await this.prisma.$transaction(async (tx) => {
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: AREA } },
                create: { businessId, area: AREA, data: program, updatedBy: ctx.member.staffId },
                update: { data: program, updatedBy: ctx.member.staffId, version: { increment: 1 } },
            });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'loyaltyProgram', entityId: businessId, businessId, before: null, after: { enabled: program.enabled } });
        });
        const recalculated = await this.recalcAll(ctx, businessId, 'programSaved');
        return { program, recalculated };
    }
};
LoyaltyProgramService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], LoyaltyProgramService);
export { LoyaltyProgramService };
//# sourceMappingURL=loyalty-program.service.js.map