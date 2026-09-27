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
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { ownerOf } from './loyalty.owner.js';
const arr = (v) => (Array.isArray(v) ? v : []);
/**
 * Каталог лояльности сети/бизнеса — типы карт, акции, типы сертификатов/абонементов/счетов, реферальная
 * программа (docs/backend/02-api.md §11). Владелец — `ownerId` (сеть или сам бизнес, F-06-002/В-09).
 */
let LoyaltyCatalogService = class LoyaltyCatalogService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    // ─────────────────────────── Типы карт (F-06-020…030) ───────────────────────────
    async listCardTypes(ctx) {
        const ownerId = ownerOf(ctx);
        const rows = await this.prisma.loyaltyCardType.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { cards: true } } } });
        return rows.map((r) => this.cardTypeView(r, r._count.cards));
    }
    cardTypeView(r, issuedCount) {
        return {
            id: r.id,
            ownerId: r.ownerId,
            businessId: r.businessId,
            name: r.name,
            networkWide: r.networkWide,
            paymentLimitPercent: r.paymentLimitPercent,
            paymentLimitFixed: moneyToJson(r.paymentLimitFixed),
            cashbackVisibleInApp: r.cashbackVisibleInApp,
            burnDays: r.burnDays,
            archived: r.archived,
            issuedCount,
            version: r.version,
        };
    }
    async createCardType(ctx, body) {
        const id = newId('loyaltyCardType');
        const ownerId = ownerOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            await tx.loyaltyCardType.create({
                data: { id, ownerId, businessId: ctx.member.businessId, name: body.name.trim(), networkWide: body.networkWide, paymentLimitPercent: body.paymentLimitPercent, paymentLimitFixed: BigInt(body.paymentLimitFixed), cashbackVisibleInApp: body.cashbackVisibleInApp, burnDays: body.burnDays, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'loyaltyCardType', entityId: id, businessId: ctx.member.businessId, networkId: ctx.member.networkId, after: { name: body.name } });
        });
        return this.cardTypeView({ ...body, id, ownerId, businessId: ctx.member.businessId, paymentLimitFixed: BigInt(body.paymentLimitFixed), archived: false, version: 1 }, 0);
    }
    async updateCardType(ctx, id, patch) {
        const row = await this.prisma.loyaltyCardType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Card type not found');
        const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
        if (patch.name !== undefined)
            data.name = patch.name.trim();
        if (patch.networkWide !== undefined)
            data.networkWide = patch.networkWide;
        if (patch.paymentLimitPercent !== undefined)
            data.paymentLimitPercent = patch.paymentLimitPercent;
        if (patch.paymentLimitFixed !== undefined)
            data.paymentLimitFixed = BigInt(patch.paymentLimitFixed);
        if (patch.cashbackVisibleInApp !== undefined)
            data.cashbackVisibleInApp = patch.cashbackVisibleInApp;
        if (patch.burnDays !== undefined)
            data.burnDays = patch.burnDays;
        await this.prisma.$transaction(async (tx) => {
            await tx.loyaltyCardType.update({ where: { id }, data });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'loyaltyCardType', entityId: id, businessId: ctx.member.businessId, before: { name: row.name }, after: { name: patch.name ?? row.name } });
        });
        const count = await this.prisma.loyaltyCard.count({ where: { cardTypeId: id } });
        const updated = await this.prisma.loyaltyCardType.findUniqueOrThrow({ where: { id } });
        return this.cardTypeView(updated, count);
    }
    /** В-40: «В архив» — не выдаётся/не продаётся, выданные карты работают */
    async archiveCardType(ctx, id, archived) {
        const row = await this.prisma.loyaltyCardType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Card type not found');
        await this.prisma.loyaltyCardType.update({ where: { id }, data: { archived, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
        const count = await this.prisma.loyaltyCard.count({ where: { cardTypeId: id } });
        return this.cardTypeView({ ...row, archived }, count);
    }
    /** В-40: жёсткое удаление отказывает, если хоть одна карта выдана */
    async deleteCardType(ctx, id) {
        const row = await this.prisma.loyaltyCardType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Card type not found');
        const issued = await this.prisma.loyaltyCard.count({ where: { cardTypeId: id } });
        if (issued > 0)
            throw new ApiError('has_issued_cards', 'Card type has issued cards; archive instead');
        await this.prisma.$transaction(async (tx) => {
            await tx.loyaltyCardType.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'loyaltyCardType', entityId: id, businessId: ctx.member.businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Акции (F-06-031…050) ───────────────────────────
    promotionView(r) {
        return {
            id: r.id,
            ownerId: r.ownerId,
            businessId: r.businessId,
            name: r.name,
            kind: r.kind,
            cardTypeIds: arr(r.cardTypeIds),
            valueType: r.valueType,
            value: r.value,
            thresholds: r.thresholds ? r.thresholds : undefined,
            active: r.active,
            version: r.version,
        };
    }
    async listPromotions(ctx) {
        const rows = await this.prisma.promotion.findMany({ where: { ownerId: ownerOf(ctx) }, orderBy: { createdAt: 'asc' } });
        return rows.map((r) => this.promotionView(r));
    }
    /** Мастер из 5 шагов фронта сведён в один POST (02-api.md §11) — вся форма приходит одним телом */
    async createPromotion(ctx, body) {
        const id = newId('promotion');
        const ownerId = ownerOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            await tx.promotion.create({
                data: { id, ownerId, businessId: ctx.member.businessId, name: body.name.trim(), kind: body.kind, cardTypeIds: body.cardTypeIds, valueType: body.valueType, value: body.value, thresholds: body.thresholds ?? undefined, serviceScope: body.serviceScope ?? undefined, active: body.active, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId },
            });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'promotion', entityId: id, businessId: ctx.member.businessId, networkId: ctx.member.networkId, after: { name: body.name, kind: body.kind } });
        });
        return this.promotionView({ id, ownerId, businessId: ctx.member.businessId, name: body.name, kind: body.kind, cardTypeIds: body.cardTypeIds, valueType: body.valueType, value: body.value, thresholds: body.thresholds ?? null, active: body.active, version: 1 });
    }
    async updatePromotion(ctx, id, patch) {
        const row = await this.prisma.promotion.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Promotion not found');
        const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
        if (patch.name !== undefined)
            data.name = patch.name.trim();
        if (patch.kind !== undefined)
            data.kind = patch.kind;
        if (patch.cardTypeIds !== undefined)
            data.cardTypeIds = patch.cardTypeIds;
        if (patch.valueType !== undefined)
            data.valueType = patch.valueType;
        if (patch.value !== undefined)
            data.value = patch.value;
        if (patch.thresholds !== undefined)
            data.thresholds = patch.thresholds;
        if (patch.serviceScope !== undefined)
            data.serviceScope = patch.serviceScope;
        if (patch.active !== undefined)
            data.active = patch.active;
        await this.prisma.promotion.update({ where: { id }, data });
        const updated = await this.prisma.promotion.findUniqueOrThrow({ where: { id } });
        return this.promotionView(updated);
    }
    async deletePromotion(ctx, id) {
        const row = await this.prisma.promotion.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Promotion not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.promotion.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'promotion', entityId: id, businessId: ctx.member.businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Реферальная программа (F-06-081…085) ───────────────────────────
    async getReferral(ctx) {
        const row = await this.prisma.referralProgram.findUnique({ where: { ownerId: ownerOf(ctx) } });
        return { ownerId: ownerOf(ctx), enabled: row?.enabled ?? false, giverReward: moneyToJson(row?.giverReward ?? 0n), receiverReward: moneyToJson(row?.receiverReward ?? 0n), version: row?.version ?? 0 };
    }
    async setReferral(ctx, body) {
        const ownerId = ownerOf(ctx);
        await this.prisma.referralProgram.upsert({
            where: { ownerId },
            create: { ownerId, enabled: body.enabled, giverReward: BigInt(body.giverReward), receiverReward: BigInt(body.receiverReward), updatedBy: ctx.member.staffId },
            update: { enabled: body.enabled, giverReward: BigInt(body.giverReward), receiverReward: BigInt(body.receiverReward), updatedBy: ctx.member.staffId, version: { increment: 1 } },
        });
        return this.getReferral(ctx);
    }
    // ─────────────────────────── Типы сертификатов (F-06-086…104) ───────────────────────────
    certTypeView(r, issuedCount) {
        return { id: r.id, ownerId: r.ownerId, businessId: r.businessId, name: r.name, faceValue: moneyToJson(r.faceValue), validDays: r.validDays, networkWide: r.networkWide, archived: r.archived, issuedCount, version: r.version };
    }
    async listCertTypes(ctx) {
        const rows = await this.prisma.certificateType.findMany({ where: { ownerId: ownerOf(ctx) }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { certificates: true } } } });
        return rows.map((r) => this.certTypeView(r, r._count.certificates));
    }
    async createCertType(ctx, body) {
        const id = newId('certificateType');
        const ownerId = ownerOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            await tx.certificateType.create({ data: { id, ownerId, businessId: ctx.member.businessId, name: body.name.trim(), faceValue: BigInt(body.faceValue), validDays: body.validDays, networkWide: body.networkWide, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'certificateType', entityId: id, businessId: ctx.member.businessId, networkId: ctx.member.networkId, after: { name: body.name } });
        });
        return this.certTypeView({ id, ownerId, businessId: ctx.member.businessId, name: body.name, faceValue: BigInt(body.faceValue), validDays: body.validDays, networkWide: body.networkWide, archived: false, version: 1 }, 0);
    }
    async updateCertType(ctx, id, patch) {
        const row = await this.prisma.certificateType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Certificate type not found');
        const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
        if (patch.name !== undefined)
            data.name = patch.name.trim();
        if (patch.faceValue !== undefined)
            data.faceValue = BigInt(patch.faceValue);
        if (patch.validDays !== undefined)
            data.validDays = patch.validDays;
        if (patch.networkWide !== undefined)
            data.networkWide = patch.networkWide;
        await this.prisma.certificateType.update({ where: { id }, data });
        const count = await this.prisma.certificate.count({ where: { typeId: id } });
        const updated = await this.prisma.certificateType.findUniqueOrThrow({ where: { id } });
        return this.certTypeView(updated, count);
    }
    async archiveCertType(ctx, id, archived) {
        const row = await this.prisma.certificateType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Certificate type not found');
        await this.prisma.certificateType.update({ where: { id }, data: { archived, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
        const count = await this.prisma.certificate.count({ where: { typeId: id } });
        return this.certTypeView({ ...row, archived }, count);
    }
    async deleteCertType(ctx, id) {
        const row = await this.prisma.certificateType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Certificate type not found');
        const issued = await this.prisma.certificate.count({ where: { typeId: id } });
        if (issued > 0)
            throw new ApiError('has_issued_cards', 'Certificate type has sold certificates; archive instead');
        await this.prisma.$transaction(async (tx) => {
            await tx.certificateType.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'certificateType', entityId: id, businessId: ctx.member.businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Типы абонементов (F-06-105…134) ───────────────────────────
    membershipTypeView(r, issuedCount) {
        return { id: r.id, ownerId: r.ownerId, businessId: r.businessId, name: r.name, totalVisits: r.totalVisits, price: moneyToJson(r.price), validDays: r.validDays, serviceIds: arr(r.serviceIds), networkWide: r.networkWide, archived: r.archived, issuedCount, version: r.version };
    }
    async listMembershipTypes(ctx) {
        const rows = await this.prisma.membershipType.findMany({ where: { ownerId: ownerOf(ctx) }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { sales: true } } } });
        return rows.map((r) => this.membershipTypeView(r, r._count.sales));
    }
    async createMembershipType(ctx, body) {
        const id = newId('membershipType');
        const ownerId = ownerOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            await tx.membershipType.create({ data: { id, ownerId, businessId: ctx.member.businessId, name: body.name.trim(), totalVisits: body.totalVisits, price: BigInt(body.price), validDays: body.validDays, serviceIds: body.serviceIds, networkWide: body.networkWide, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'membershipType', entityId: id, businessId: ctx.member.businessId, networkId: ctx.member.networkId, after: { name: body.name } });
        });
        return this.membershipTypeView({ id, ownerId, businessId: ctx.member.businessId, name: body.name, totalVisits: body.totalVisits, price: BigInt(body.price), validDays: body.validDays, serviceIds: body.serviceIds, networkWide: body.networkWide, archived: false, version: 1 }, 0);
    }
    async updateMembershipType(ctx, id, patch) {
        const row = await this.prisma.membershipType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Membership type not found');
        const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
        if (patch.name !== undefined)
            data.name = patch.name.trim();
        if (patch.totalVisits !== undefined)
            data.totalVisits = patch.totalVisits;
        if (patch.price !== undefined)
            data.price = BigInt(patch.price);
        if (patch.validDays !== undefined)
            data.validDays = patch.validDays;
        if (patch.serviceIds !== undefined)
            data.serviceIds = patch.serviceIds;
        if (patch.networkWide !== undefined)
            data.networkWide = patch.networkWide;
        await this.prisma.membershipType.update({ where: { id }, data });
        const count = await this.prisma.membershipSale.count({ where: { typeId: id } });
        const updated = await this.prisma.membershipType.findUniqueOrThrow({ where: { id } });
        return this.membershipTypeView(updated, count);
    }
    async archiveMembershipType(ctx, id, archived) {
        const row = await this.prisma.membershipType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Membership type not found');
        await this.prisma.membershipType.update({ where: { id }, data: { archived, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
        const count = await this.prisma.membershipSale.count({ where: { typeId: id } });
        return this.membershipTypeView({ ...row, archived }, count);
    }
    async deleteMembershipType(ctx, id) {
        const row = await this.prisma.membershipType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Membership type not found');
        const issued = await this.prisma.membershipSale.count({ where: { typeId: id } });
        if (issued > 0)
            throw new ApiError('has_issued_cards', 'Membership type has sold memberships; archive instead');
        await this.prisma.$transaction(async (tx) => {
            await tx.membershipType.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'membershipType', entityId: id, businessId: ctx.member.businessId, before: { name: row.name }, after: null });
        });
    }
    // ─────────────────────────── Типы счетов клиентов (F-06-135…146) ───────────────────────────
    accountTypeView(r) {
        return { id: r.id, ownerId: r.ownerId, businessId: r.businessId, name: r.name, networkWide: r.networkWide, archived: r.archived, version: r.version };
    }
    async listAccountTypes(ctx) {
        const rows = await this.prisma.clientAccountType.findMany({ where: { ownerId: ownerOf(ctx) }, orderBy: { createdAt: 'asc' } });
        return rows.map((r) => this.accountTypeView(r));
    }
    async createAccountType(ctx, body) {
        const id = newId('clientAccountType');
        const ownerId = ownerOf(ctx);
        await this.prisma.$transaction(async (tx) => {
            await tx.clientAccountType.create({ data: { id, ownerId, businessId: ctx.member.businessId, name: body.name.trim(), networkWide: body.networkWide, createdBy: ctx.member.staffId, updatedBy: ctx.member.staffId } });
            await this.audit.record(tx, ctx, { action: 'create', entityType: 'clientAccountType', entityId: id, businessId: ctx.member.businessId, networkId: ctx.member.networkId, after: { name: body.name } });
        });
        return this.accountTypeView({ id, ownerId, businessId: ctx.member.businessId, name: body.name, networkWide: body.networkWide, archived: false, version: 1 });
    }
    async updateAccountType(ctx, id, patch) {
        const row = await this.prisma.clientAccountType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Account type not found');
        const data = { updatedBy: ctx.member.staffId, version: { increment: 1 } };
        if (patch.name !== undefined)
            data.name = patch.name.trim();
        if (patch.networkWide !== undefined)
            data.networkWide = patch.networkWide;
        await this.prisma.clientAccountType.update({ where: { id }, data });
        const updated = await this.prisma.clientAccountType.findUniqueOrThrow({ where: { id } });
        return this.accountTypeView(updated);
    }
    async archiveAccountType(ctx, id, archived) {
        const row = await this.prisma.clientAccountType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Account type not found');
        await this.prisma.clientAccountType.update({ where: { id }, data: { archived, updatedBy: ctx.member.staffId, version: { increment: 1 } } });
        return this.accountTypeView({ ...row, archived });
    }
    async deleteAccountType(ctx, id) {
        const row = await this.prisma.clientAccountType.findFirst({ where: { id, ownerId: ownerOf(ctx) } });
        if (!row)
            throw new ApiError('not_found', 'Account type not found');
        const issued = await this.prisma.clientAccount.count({ where: { typeId: id } });
        if (issued > 0)
            throw new ApiError('has_issued_cards', 'Account type has open accounts; archive instead');
        await this.prisma.$transaction(async (tx) => {
            await tx.clientAccountType.delete({ where: { id } });
            await this.audit.record(tx, ctx, { action: 'delete', entityType: 'clientAccountType', entityId: id, businessId: ctx.member.businessId, before: { name: row.name }, after: null });
        });
    }
};
LoyaltyCatalogService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], LoyaltyCatalogService);
export { LoyaltyCatalogService };
//# sourceMappingURL=loyalty-catalog.service.js.map