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
import dayjs from 'dayjs';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { normalizePhone } from '../../common/phone.js';
import { clientRowView } from './clients.views.js';
export const IMPORT_MAX_ROWS = 500;
function parseImportGender(v) {
    const s = v.trim().toUpperCase();
    if (s === 'M' || s === '1')
        return 'male';
    if (s === 'F' || s === '2')
        return 'female';
    return undefined;
}
/** «ДД-ММ» или «ДД-ММ-ГГГГ» → 'YYYY-MM-DD'; без года подставляется текущий (F-04-128) */
function parseImportBirthday(v) {
    const m = v.trim().match(/^(\d{2})-(\d{2})(?:-(\d{4}))?$/);
    if (!m)
        return undefined;
    const [, dd, mm, yyyy] = m;
    const year = yyyy ?? String(dayjs().year());
    const candidate = `${year}-${mm}-${dd}`;
    return dayjs(candidate, 'YYYY-MM-DD', true).isValid() ? candidate : undefined;
}
/**
 * Порт `applyImportRow` фронта (src/api/clients/importExport.ts): создаёт клиента, либо — тот же номер уже
 * в базе — прибавляет «Продано/Оплачено» к существующей карточке (F-04-129), не создаёт дубль (F-00-128).
 */
let ClientsImportExportService = class ClientsImportExportService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    async applyImportRow(ctx, businessId, headers, values) {
        const get = (target) => {
            const i = headers.indexOf(target);
            return i >= 0 ? values[i]?.trim() : undefined;
        };
        const name = get('name');
        const phoneRaw = get('phone');
        if (!name)
            return { ok: false, error: 'Не заполнено имя' };
        if (!phoneRaw)
            return { ok: false, error: 'Не заполнен телефон' };
        if (!/^\d{7,15}$/.test(phoneRaw))
            return { ok: false, error: 'Телефон должен быть числом без «+», тире и пробелов' };
        const emailRaw = get('email');
        if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw))
            return { ok: false, error: 'Неверный формат email' };
        const genderRaw = get('gender');
        const gender = genderRaw ? parseImportGender(genderRaw) : undefined;
        if (genderRaw && !gender)
            return { ok: false, error: 'Пол должен быть M/F или 1/2' };
        const birthdayRaw = get('birthday');
        const birthday = birthdayRaw ? parseImportBirthday(birthdayRaw) : undefined;
        if (birthdayRaw && !birthday)
            return { ok: false, error: 'Дата рождения должна быть ДД-ММ или ДД-ММ-ГГГГ' };
        const soldRaw = get('sold');
        const paidRaw = get('paid');
        const balanceRaw = get('balance');
        const discountRaw = get('discount');
        const card = get('card');
        const additionalPhoneRaw = get('additionalPhone');
        const comment = get('comment');
        const lastName = get('lastName');
        const normalizedImportPhone = normalizePhone(`+${phoneRaw}`);
        const existing = await this.prisma.client.findFirst({
            where: { businessId, deletedAt: null, phone: normalizedImportPhone ?? `+${phoneRaw}` },
        });
        const addSold = BigInt(Number(soldRaw) || 0) + BigInt(Number(balanceRaw) || 0);
        const addPaid = BigInt(Number(paidRaw) || 0) + BigInt(Number(balanceRaw) || 0);
        if (existing) {
            await this.prisma.client.update({
                where: { id: existing.id },
                data: {
                    importedSold: existing.importedSold + addSold,
                    paidAmount: existing.paidAmount + addPaid,
                    cardNumber: card || existing.cardNumber,
                    discountPercent: discountRaw !== undefined && discountRaw !== '' ? Number(discountRaw) : existing.discountPercent,
                    additionalPhone: additionalPhoneRaw || existing.additionalPhone,
                    note: comment ? (existing.note ? `${existing.note}\n${comment}` : comment) : existing.note,
                },
            });
            return { ok: true, created: false, clientId: existing.id };
        }
        const id = newId('client');
        await this.prisma.client.create({
            data: {
                id,
                businessId,
                phone: `+${phoneRaw}`,
                name,
                lastName: lastName || null,
                gender: gender ?? 'unknown',
                birthday: birthday ?? null,
                tags: [],
                note: comment || null,
                cardNumber: card || null,
                discountPercent: discountRaw !== undefined && discountRaw !== '' ? Number(discountRaw) : 0,
                paidAmount: addPaid,
                importedSold: addSold,
                additionalPhone: additionalPhoneRaw || null,
                source: 'import',
                createdBy: ctx.member.staffId,
                updatedBy: ctx.member.staffId,
            },
        });
        return { ok: true, created: true, clientId: id };
    }
    async runImport(ctx, businessId, authorName, mapping, rows, method) {
        if (rows.length > IMPORT_MAX_ROWS)
            throw new ApiError('too_many_rows', `Up to ${IMPORT_MAX_ROWS} rows at a time`);
        const results = [];
        let created = 0;
        let updated = 0;
        for (let i = 0; i < rows.length; i++) {
            const outcome = await this.applyImportRow(ctx, businessId, mapping, rows[i] ?? []);
            results.push({ rowIndex: i, raw: rows[i] ?? [], ok: outcome.ok, error: outcome.error, clientId: outcome.clientId, created: outcome.created });
            if (outcome.ok && outcome.created)
                created++;
            else if (outcome.ok)
                updated++;
        }
        const summary = {
            id: newId('clientImportRun'),
            at: new Date(),
            authorName,
            method,
            totalRows: rows.length,
            createdCount: created,
            updatedCount: updated,
            rejectedCount: rows.length - created - updated,
        };
        await this.prisma.$transaction(async (tx) => {
            await tx.clientImportRun.create({ data: { ...summary, businessId } });
            await this.audit.record(tx, ctx, { action: 'import', entityType: 'clientImport', entityId: businessId, businessId, after: { created, updated, rejected: summary.rejectedCount } });
        });
        return { results, summary: { ...summary, at: summary.at.toISOString() } };
    }
    async listImportRuns(businessId) {
        const rows = await this.prisma.clientImportRun.findMany({ where: { businessId }, orderBy: { at: 'desc' }, take: 50 });
        return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
    }
    // ─────────── выгрузка (F-04-130, P4: закрыта по умолчанию, право clients.export) ───────────
    async exportClients(ctx, businessId, ids, authorName, fileName) {
        const rows = await this.prisma.client.findMany({ where: { id: { in: ids }, businessId, deletedAt: null } });
        const view = rows.map(clientRowView);
        await this.prisma.$transaction(async (tx) => {
            await tx.dataExport.create({ data: { id: newId('dataExport'), businessId, area: 'clients', authorId: ctx.member.staffId, authorName, count: view.length, fileName } });
            await this.audit.record(tx, ctx, { action: 'export', entityType: 'clientExport', entityId: businessId, businessId, after: { count: view.length, fileName } });
        });
        return view;
    }
    async listExportLog(businessId) {
        const rows = await this.prisma.dataExport.findMany({ where: { businessId, area: 'clients' }, orderBy: { at: 'desc' }, take: 50 });
        return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), authorName: r.authorName, count: r.count, method: 'download' }));
    }
};
ClientsImportExportService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], ClientsImportExportService);
export { ClientsImportExportService };
//# sourceMappingURL=clients-import-export.service.js.map