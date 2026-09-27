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
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { updateVersioned } from '../../common/http/version.js';
import { newId } from '../../common/ids/ids.js';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';
import { PHONE_PREFIX, normalizePhone } from '../../common/phone.js';
import { emptyContext, matchesFilters, matchesPick, matchesSearch, sortClientRows } from './clients.filters.js';
import { clientRowView, maskClientPhones } from './clients.views.js';
import { getClientsBizSettings } from './clients-settings.helper.js';
import { bookingIndex, clientBookings, withVisits } from './clients.visits.js';
const QUICK_PICKS = ['new', 'repeat', 'lost', 'subscriptionEnding', 'noShow', 'chatLeads'];
/**
 * Поля обезличивания клиента (F-04-211, P11) — общие для запроса самого клиента и для автоматики этапа 20
 * (B6: бизнес ушёл, 90 дней после выгрузки истекли). Комментарии/файлы стираются отдельно (не поле).
 *
 * Этап 20, найдено и исправлено: `phone` — `VarChar(20)`, а полный id (`cl_<ULID>`, до 29 символов) внутри
 * `purged:${id}` в него не помещался — `purgeClientData` падал `P2000 LengthMismatch` при первом же реальном
 * вызове (стадия 5 никогда не проверяла это на настоящей MySQL). Берём хвост id — короче колонки, отличим друг
 * от друга внутри одного бизнеса, и не похож на настоящий номер, поиском больше не найдётся.
 */
function purgedClientFields(id) {
    return {
        name: 'Удалённый клиент',
        phone: `x${id.slice(-14)}`,
        email: null,
        note: null,
        tags: [],
        birthday: null,
        additionalPhone: null,
        nationalId: null,
        adConsent: Prisma.DbNull,
        customFieldValues: Prisma.DbNull,
        purgedAt: new Date(),
    };
}
/**
 * Проверка номера (F-04-049): армянский — строго 8 местных цифр после +374; другой код страны (F-04-047)
 * принимаем как есть, не короче 6 местных цифр. Тот же приём, что `validatePhone` фронта (src/api/clients/shared.ts).
 */
export function validateClientPhone(raw) {
    if (raw.startsWith(PHONE_PREFIX) || !raw.startsWith('+')) {
        const armenian = normalizePhone(raw);
        if (!armenian)
            throw new ApiError('invalid_phone', 'Full phone number required');
        return armenian;
    }
    const digitsAfterCode = raw.replace(/^\+\d{1,3}/, '').replace(/\D/g, '');
    if (digitsAfterCode.length < 6)
        throw new ApiError('invalid_phone', 'Full phone number required');
    return raw;
}
export function validateNationalId(value) {
    if (!value)
        return undefined;
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 12)
        throw new ApiError('invalid_national_id', 'National id must be 12 digits');
    return digits;
}
let ClientsService = class ClientsService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    // ─────────── бизнесы сети (F-00-050) ───────────
    /** Свой бизнес, либо (сеть) бизнесы своей сети, чьи филиалы попадают в выбранные locationIds */
    async businessIdsFor(businessId, locationIds) {
        if (!locationIds?.length)
            return [businessId];
        const self = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
        const candidates = self?.networkId
            ? await this.prisma.business.findMany({ where: { networkId: self.networkId, leftAt: null }, select: { id: true } })
            : [{ id: businessId }];
        const locations = await this.prisma.location.findMany({ where: { businessId: { in: candidates.map((c) => c.id) }, deletedAt: null }, select: { businessId: true, id: true } });
        const matched = candidates.filter((c) => locations.some((l) => l.businessId === c.id && locationIds.includes(l.id))).map((c) => c.id);
        return matched.length ? matched : [businessId];
    }
    async rowsFor(businessIds) {
        return (await this.rowsWithIndex(businessIds)).rows;
    }
    /** Строки клиентов с визитами и деньгами из записей (этап 7) + индекс записей для фильтров */
    async rowsWithIndex(businessIds) {
        const clients = await this.prisma.client.findMany({ where: { businessId: { in: businessIds }, deletedAt: null }, orderBy: { createdAt: 'desc' } });
        const bookings = await clientBookings(this.prisma, businessIds);
        const rows = withVisits(clients.map(clientRowView), bookings, new Map());
        return { rows, index: bookingIndex(bookings) };
    }
    today() {
        return dayjs().format('YYYY-MM-DD');
    }
    async lostAfterDays(businessId) {
        return (await getClientsBizSettings(this.prisma, businessId)).lostAfterDays;
    }
    // ─────────── список / поиск (F-04-001…035, K8) ───────────
    async search(ctx, businessId, input) {
        const businessIds = await this.businessIdsFor(businessId, input.locationIds);
        const ctxFilter = emptyContext(await this.lostAfterDays(businessId), this.today());
        const loaded = await this.rowsWithIndex(businessIds);
        ctxFilter.bookings = loaded.index;
        let base = loaded.rows;
        // F-04-199: без права seeAllClients (тонкое право раздела) мастер видит только клиентов с визитом к себе
        if (input.onlyStaffId) {
            const mine = new Set(loaded.index.filter((b) => b.staffId === input.onlyStaffId).map((b) => b.clientId));
            base = base.filter((r) => mine.has(r.id));
        }
        const mask = !ctx.member.permissions.has('clients.phones');
        const pickCounts = Object.fromEntries(QUICK_PICKS.map((p) => [p, base.filter((r) => matchesPick(r, p, ctxFilter)).length]));
        let found = base;
        if (input.search?.trim())
            found = found.filter((r) => matchesSearch(r, input.search));
        if (input.pick)
            found = found.filter((r) => matchesPick(r, input.pick, ctxFilter));
        if (input.filters)
            found = found.filter((r) => matchesFilters(r, input.filters, ctxFilter));
        found = sortClientRows(found, input.sort ?? { columnId: 'lastVisit', dir: 'desc' });
        const pageSize = Math.max(1, input.pageSize);
        const lastPage = Math.max(1, Math.ceil(found.length / pageSize));
        const revealIndex = input.revealId ? found.findIndex((r) => r.id === input.revealId) : -1;
        const page = revealIndex >= 0 ? Math.floor(revealIndex / pageSize) + 1 : Math.min(Math.max(1, input.page), lastPage);
        const rows = found.slice((page - 1) * pageSize, page * pageSize).map((r) => (mask ? maskClientPhones(r) : r));
        return { rows, total: found.length, baseTotal: base.length, ids: found.map((r) => r.id), pickCounts, page };
    }
    async listRows(ctx, businessId) {
        const rows = await this.rowsFor([businessId]);
        return ctx.member.permissions.has('clients.phones') ? rows : rows.map(maskClientPhones);
    }
    async countMatching(businessId, input) {
        const businessIds = await this.businessIdsFor(businessId, input.locationIds);
        const ctxFilter = emptyContext(await this.lostAfterDays(businessId), this.today());
        const loaded = await this.rowsWithIndex(businessIds);
        ctxFilter.bookings = loaded.index;
        const base = loaded.rows;
        if (!input.filters)
            return base.length;
        return base.filter((r) => matchesFilters(r, input.filters, ctxFilter)).length;
    }
    // ─────────── карточка (F-04-044…074) ───────────
    async findDuplicate(businessId, phone, excludeId) {
        return this.prisma.client.findFirst({ where: { businessId, phone, deletedAt: null, id: excludeId ? { not: excludeId } : undefined } });
    }
    async createClient(ctx, businessId, input) {
        const name = input.name.trim();
        if (!name)
            throw new ApiError('name_required', 'Name required');
        const normalized = validateClientPhone(input.phone);
        const dup = await this.findDuplicate(businessId, normalized);
        if (dup)
            throw new ApiError('duplicate_phone', 'Client with this phone already exists', { existingClientId: dup.id });
        const id = newId('client');
        await this.prisma.$transaction(async (tx) => {
            await tx.client.create({
                data: {
                    id,
                    businessId,
                    phone: normalized,
                    name,
                    lastName: input.lastName?.trim() || null,
                    middleName: input.middleName?.trim() || null,
                    gender: input.gender ?? 'unknown',
                    birthday: input.birthday || null,
                    email: input.email?.trim() || null,
                    note: input.note?.trim() || null,
                    tags: input.tags ?? [],
                    additionalPhone: input.additionalPhone ? validateClientPhone(input.additionalPhone) : null,
                    avatarUrl: input.avatar ?? null,
                    discountPercent: input.discountPercent ?? 0,
                    importanceClass: input.importanceClass ?? null,
                    cardNumber: input.cardNumber?.trim() || null,
                    paidAmount: BigInt(input.paidAmount ?? 0),
                    importedSold: BigInt(input.importedSold ?? 0),
                    nationalId: validateNationalId(input.nationalId) ?? null,
                    birthdayGreetingOptOut: input.birthdayGreetingOptOut ?? null,
                    locale: input.locale ?? null,
                    preferredContact: input.preferredContact ?? null,
                    blocked: input.blocked ?? null,
                    customFieldValues: input.customFieldValues && Object.keys(input.customFieldValues).length ? input.customFieldValues : Prisma.DbNull,
                    source: 'manual',
                    createdBy: ctx.member.staffId,
                    updatedBy: ctx.member.staffId,
                },
            });
            await this.audit.record(tx, ctx, { action: 'created', entityType: 'client', entityId: id, businessId, after: { name, phone: normalized } });
        });
        return this.prisma.client.findUniqueOrThrow({ where: { id } }).then(clientRowView);
    }
    async getRow(ctx, businessId, id, businessIds, onlyStaffId) {
        const allowed = businessIds?.length ? [businessId, ...businessIds] : [businessId];
        const client = await this.prisma.client.findFirst({ where: { id, businessId: { in: allowed }, deletedAt: null } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        // F-04-199: без права «все клиенты» карточку открывают только клиенту с визитом к этому мастеру
        const bookings = await clientBookings(this.prisma, allowed, [client.id]);
        if (onlyStaffId && !bookings.some((b) => b.staffId === onlyStaffId))
            throw new ApiError('not_found', 'Client not found');
        const row = withVisits([clientRowView(client)], bookings, new Map())[0];
        return ctx.member.permissions.has('clients.phones') ? row : maskClientPhones(row);
    }
    async updateClient(ctx, businessId, id, input, version) {
        const before = await this.prisma.client.findFirst({ where: { id, businessId, deletedAt: null } });
        if (!before)
            throw new ApiError('not_found', 'Client not found');
        const name = input.name.trim();
        if (!name)
            throw new ApiError('name_required', 'Name required');
        const normalized = validateClientPhone(input.phone);
        if (normalized !== before.phone && !ctx.member.permissions.has('clients.phones')) {
            throw new ApiError('forbidden', 'Missing permission: clients.phones');
        }
        const dup = await this.findDuplicate(businessId, normalized, id);
        if (dup)
            throw new ApiError('duplicate_phone', 'Client with this phone already exists', { existingClientId: dup.id });
        const data = {
            name,
            phone: normalized,
            lastName: input.lastName?.trim() || null,
            middleName: input.middleName?.trim() || null,
            gender: input.gender ?? 'unknown',
            birthday: input.birthday || null,
            email: input.email?.trim() || null,
            note: input.note?.trim() || null,
            tags: input.tags ?? [],
            additionalPhone: input.additionalPhone ? validateClientPhone(input.additionalPhone) : null,
            avatarUrl: input.avatar ?? before.avatarUrl,
            discountPercent: input.discountPercent ?? before.discountPercent,
            importanceClass: input.importanceClass ?? null,
            cardNumber: input.cardNumber?.trim() || null,
            // «Оплачено» в форме — оплаты визитов + внесённое сверх них; экран шлёт только добавку (extraPaidFromTotal)
            paidAmount: input.paidAmount !== undefined ? BigInt(input.paidAmount) : before.paidAmount,
            nationalId: validateNationalId(input.nationalId) ?? before.nationalId,
            birthdayGreetingOptOut: input.birthdayGreetingOptOut ?? null,
            locale: input.locale ?? before.locale,
            preferredContact: input.preferredContact ?? before.preferredContact,
            blocked: input.blocked ?? null,
            updatedBy: ctx.member.staffId,
        };
        if (input.customFieldValues) {
            const prev = before.customFieldValues ?? {};
            data.customFieldValues = { ...prev, ...input.customFieldValues };
        }
        await this.prisma.$transaction(async (tx) => {
            await updateVersioned(tx.client, { id, businessId }, version, data);
            // Снимок всех полей формы клиента — diffOf сам оставит только реально изменившиеся (F-04-137 summary)
            const beforeSnapshot = {
                name: before.name,
                lastName: before.lastName,
                middleName: before.middleName,
                phone: before.phone,
                additionalPhone: before.additionalPhone,
                email: before.email,
                birthday: before.birthday,
                gender: before.gender,
                importanceClass: before.importanceClass,
                cardNumber: before.cardNumber,
                discountPercent: before.discountPercent,
                blocked: before.blocked,
                note: before.note,
                tags: before.tags,
                nationalId: before.nationalId,
                locale: before.locale,
                preferredContact: before.preferredContact,
            };
            const afterSnapshot = {
                name,
                lastName: input.lastName,
                middleName: input.middleName,
                phone: normalized,
                additionalPhone: input.additionalPhone,
                email: input.email,
                birthday: input.birthday,
                gender: input.gender ?? 'unknown',
                importanceClass: input.importanceClass,
                cardNumber: input.cardNumber,
                discountPercent: input.discountPercent ?? before.discountPercent,
                blocked: input.blocked,
                note: input.note,
                tags: input.tags ?? [],
                nationalId: input.nationalId,
                locale: input.locale,
                preferredContact: input.preferredContact,
            };
            await this.audit.record(tx, ctx, { action: 'updated', entityType: 'client', entityId: id, businessId, before: beforeSnapshot, after: afterSnapshot });
        });
        return this.getRow(ctx, businessId, id);
    }
    async updateNote(businessId, id, note) {
        const client = await this.prisma.client.findFirst({ where: { id, businessId } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        await this.prisma.client.update({ where: { id }, data: { note: note.trim() || null, version: { increment: 1 } } });
    }
    /** Мягкое удаление (F-04-074, A12): история остаётся у карточки, номер свободен для новой */
    async deleteClientTx(tx, ctx, businessId, id) {
        const client = await tx.client.findFirst({ where: { id, businessId, deletedAt: null } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        await tx.client.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: ctx.member.staffId, version: { increment: 1 } } });
        await this.audit.record(tx, ctx, { action: 'deleted', entityType: 'client', entityId: id, businessId, before: { name: client.name } });
    }
    async deleteClient(ctx, businessId, id) {
        await this.prisma.$transaction((tx) => this.deleteClientTx(tx, ctx, businessId, id));
    }
    /** F-04-211: обезличивание по требованию клиента (P11, GDPR) — телефон и личные данные стёрты навсегда */
    async purgeClientData(ctx, businessId, id) {
        const client = await this.prisma.client.findFirst({ where: { id, businessId } });
        if (!client)
            throw new ApiError('not_found', 'Client not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.client.update({ where: { id }, data: { ...purgedClientFields(id), deletedAt: client.deletedAt ?? new Date(), version: { increment: 1 } } });
            // P11 (docs/backend/03 §3): «заметки/файлы/комментарии стираются» — не только поле note на карточке
            await tx.clientComment.deleteMany({ where: { clientId: id } });
            await tx.clientFile.deleteMany({ where: { clientId: id } });
            await this.audit.record(tx, ctx, { action: 'purged', entityType: 'client', entityId: id, businessId, before: { name: client.name }, after: { name: 'Удалённый клиент' } });
        });
    }
    /**
     * Этап 20 (B6, F-00-183): бизнес ушёл, 90 дней после выгрузки истекли — обезличиваем всех его клиентов сами,
     * без действия сотрудника (доступ к кабинету к этому моменту не гарантирован). Идемпотентно: `purgedAt` на
     * клиенте — тот же флаг «уже сделано», что и у ручного запроса F-04-211, так что повторный прогон job-а
     * трогает только новые/ещё не обезличенные строки.
     */
    async purgeAllClientsForBusiness(businessId) {
        const clients = await this.prisma.client.findMany({ where: { businessId, purgedAt: null }, select: { id: true, name: true } });
        for (const c of clients) {
            await this.prisma.$transaction(async (tx) => {
                await tx.client.update({ where: { id: c.id }, data: { ...purgedClientFields(c.id), deletedAt: new Date(), version: { increment: 1 } } });
                await tx.clientComment.deleteMany({ where: { clientId: c.id } });
                await tx.clientFile.deleteMany({ where: { clientId: c.id } });
                await this.audit.record(tx, null, { action: 'purged', entityType: 'client', entityId: c.id, businessId, before: { name: c.name }, after: { name: 'Удалённый клиент' } });
            });
        }
        return clients.length;
    }
    /** Только номер — для проверки «есть ли приложение» (getAppActivity), без права clients.phones */
    async getPhone(businessId, id) {
        const client = await this.prisma.client.findFirst({ where: { id, businessId }, select: { phone: true } });
        return client?.phone;
    }
    async getCustomFieldValues(businessId, id) {
        const client = await this.prisma.client.findFirst({ where: { id, businessId } });
        return client?.customFieldValues ?? {};
    }
    // ─────────── журнал изменений карточки (⭐ F-00-040 → F-04-137) ───────────
    // Единый журнал — audit_events (01 §11), не своя таблица (тот же приём, что у ресурсов этапа 4).
    async changeLog(businessId, clientId) {
        const events = await this.prisma.auditEvent.findMany({
            where: { businessId, entityType: 'client', entityId: clientId ?? undefined },
            orderBy: { at: 'desc' },
            take: 500,
        });
        // Имя — текущим значением карточки (JOIN, не diff): карточка не удаляется физически (мягкое удаление, A12),
        // поэтому «имя на момент записи» = живое имя строки, и обезличивание (purge) само переименовывает старые
        // строки журнала — как во фронте (F-04-211 «стирает имя и из прошлых записей»), без отдельной правки истории.
        const ids = [...new Set(events.map((e) => e.entityId))];
        const clients = ids.length ? await this.prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
        const nameOf = new Map(clients.map((c) => [c.id, c.name]));
        return events.map((e) => {
            const diff = e.diff ?? null;
            const summary = e.action === 'merged' ? diff?.mergedInto?.[1] ?? '' : e.action === 'updated' && diff ? Object.keys(diff).join(',') : '';
            return {
                id: e.id,
                clientId: e.entityId,
                clientName: nameOf.get(e.entityId) ?? e.actorName,
                action: e.action,
                authorId: e.actorId ?? undefined,
                authorName: e.actorName,
                summary,
                at: e.at.toISOString(),
            };
        });
    }
    // ─────────── категории (F-04-109/110) ───────────
    async listCategories(businessId) {
        const [categories, clients] = await Promise.all([
            this.prisma.clientCategory.findMany({ where: { businessId } }),
            this.prisma.client.findMany({ where: { businessId, deletedAt: null }, select: { tags: true } }),
        ]);
        const counts = new Map();
        clients.forEach((c) => (Array.isArray(c.tags) ? c.tags : []).forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
        const names = new Set([...categories.map((c) => c.name), ...counts.keys()]);
        const colorOf = (name) => categories.find((c) => c.name === name)?.color ?? String(2 + [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % 7);
        return Array.from(names)
            .map((name) => ({ name, color: colorOf(name), count: counts.get(name) ?? 0 }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }
    async listCategoryOptions(businessId) {
        return (await this.listCategories(businessId)).map((c) => c.name);
    }
    async createCategory(businessId, name, color) {
        const trimmed = name.trim();
        if (!trimmed)
            throw new ApiError('empty_category', 'Category name required');
        const existing = await this.listCategoryOptions(businessId);
        if (existing.some((n) => n.toLowerCase() === trimmed.toLowerCase()))
            throw new ApiError('duplicate_category', 'Category already exists');
        await this.prisma.clientCategory.create({ data: { businessId, name: trimmed, color } });
    }
    async updateCategory(businessId, name, next) {
        const trimmed = next.name.trim();
        if (!trimmed)
            throw new ApiError('empty_category', 'Category name required');
        await this.prisma.$transaction(async (tx) => {
            if (trimmed.toLowerCase() !== name.toLowerCase()) {
                const existing = await this.listCategoryOptions(businessId);
                if (existing.some((n) => n.toLowerCase() === trimmed.toLowerCase()))
                    throw new ApiError('duplicate_category', 'Category already exists');
                const clients = await tx.client.findMany({ where: { businessId, deletedAt: null } });
                for (const c of clients) {
                    const tags = Array.isArray(c.tags) ? c.tags : [];
                    if (tags.includes(name))
                        await tx.client.update({ where: { id: c.id }, data: { tags: tags.map((t) => (t === name ? trimmed : t)) } });
                }
            }
            await tx.clientCategory.deleteMany({ where: { businessId, name } });
            await tx.clientCategory.upsert({ where: { businessId_name: { businessId, name: trimmed } }, create: { businessId, name: trimmed, color: next.color }, update: { color: next.color } });
        });
    }
    async deleteCategory(businessId, name) {
        await this.prisma.$transaction(async (tx) => {
            const clients = await tx.client.findMany({ where: { businessId, deletedAt: null } });
            for (const c of clients) {
                const tags = Array.isArray(c.tags) ? c.tags : [];
                if (tags.includes(name))
                    await tx.client.update({ where: { id: c.id }, data: { tags: tags.filter((t) => t !== name) } });
            }
            await tx.clientCategory.deleteMany({ where: { businessId, name } });
        });
    }
    async bulkAddCategory(businessId, clientIds, category, color) {
        const trimmed = category.trim();
        if (!trimmed)
            throw new ApiError('empty_category', 'Category name required');
        await this.prisma.$transaction(async (tx) => {
            const clients = await tx.client.findMany({ where: { id: { in: clientIds }, businessId } });
            for (const c of clients) {
                const tags = Array.isArray(c.tags) ? c.tags : [];
                if (!tags.includes(trimmed))
                    await tx.client.update({ where: { id: c.id }, data: { tags: [...tags, trimmed] } });
            }
            if (color)
                await tx.clientCategory.upsert({ where: { businessId_name: { businessId, name: trimmed } }, create: { businessId, name: trimmed, color }, update: { color } });
        });
    }
    // ─────────── дубли: объединение и массовое удаление (F-04-135…137, F-04-042) ───────────
    async mergeClients(ctx, businessId, keepId, duplicateId) {
        if (keepId === duplicateId)
            throw new ApiError('same_client', 'Pick two different clients');
        await this.prisma.$transaction(async (tx) => {
            const keep = await tx.client.findFirst({ where: { id: keepId, businessId, deletedAt: null } });
            const dup = await tx.client.findFirst({ where: { id: duplicateId, businessId, deletedAt: null } });
            if (!keep || !dup)
                throw new ApiError('not_found', 'Client not found');
            // Визиты, события и заявки дубля переезжают на оставшуюся карточку (этап 7), суммы и неявки складываются
            await tx.booking.updateMany({ where: { clientId: duplicateId }, data: { clientId: keepId } });
            await tx.bookingEvent.updateMany({ where: { clientId: duplicateId }, data: { clientId: keepId } });
            await tx.waitlistEntry.updateMany({ where: { clientId: duplicateId }, data: { clientId: keepId } });
            await tx.client.update({
                where: { id: keepId },
                data: { importedSold: keep.importedSold + dup.importedSold, paidAmount: keep.paidAmount + dup.paidAmount, noShowCount: keep.noShowCount + dup.noShowCount },
            });
            await tx.client.update({ where: { id: duplicateId }, data: { deletedAt: new Date(), deletedBy: ctx.member.staffId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'merged', entityType: 'client', entityId: duplicateId, businessId, before: { name: dup.name }, after: { mergedInto: keep.name } });
        });
    }
    async bulkDeleteClients(ctx, businessId, clientIds) {
        await this.prisma.$transaction(async (tx) => {
            for (const id of clientIds) {
                const client = await tx.client.findFirst({ where: { id, businessId, deletedAt: null } });
                if (!client)
                    continue;
                await tx.client.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: ctx.member.staffId, version: { increment: 1 } } });
                await this.audit.record(tx, ctx, { action: 'deleted', entityType: 'client', entityId: id, businessId, before: { name: client.name } });
            }
        });
    }
};
ClientsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], ClientsService);
export { ClientsService };
//# sourceMappingURL=clients.service.js.map