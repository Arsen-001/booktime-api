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
import { PrismaService } from '../../common/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import { isLocale, t } from '../../common/i18n/i18n.js';
import { NOTIFY_KINDS, notifyKindOf } from './kinds.js';
const AREA = 'notify-types';
const J = (v) => v;
const R = (v) => v;
/** Читает свои настройки типа для бизнеса напрямую (без DI) — использует и сервис ниже, и отправитель очереди */
export async function readStoredTypes(prisma, businessId) {
    const row = await prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
    return row?.data ?? {};
}
export async function isKindEnabled(prisma, businessId, kind) {
    const stored = await readStoredTypes(prisma, businessId);
    return stored[kind]?.enabled ?? true;
}
export async function customTemplateOf(prisma, businessId, kind, locale) {
    const stored = await readStoredTypes(prisma, businessId);
    const push = stored[kind]?.templates?.push;
    return push?.[locale] ?? push?.ru;
}
/**
 * Тип уведомления по-нашему (docs/backend/05 §3): включён/выключен + свой текст на каждый язык. Свой,
 * заметно более узкий словарь, чем Altegio-каталог из 88 типов в моке фронта — см. `kinds.ts` докстринг.
 * Хранится одной JSON-строкой на бизнес (тот же приём, что split-by-resource/online settings — F4,
 * BusinessSetting area+data), правится по одному типу за раз через merge.
 */
let NotifyTypesService = class NotifyTypesService {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    async list(businessId) {
        const stored = await readStoredTypes(this.prisma, businessId);
        return NOTIFY_KINDS.map((def) => {
            const s = stored[def.kind];
            const enabled = s?.enabled ?? true;
            return {
                id: `${businessId}:${def.kind}`,
                code: def.code,
                recipient: def.recipient,
                name: { ru: def.kind, en: def.kind },
                enabled,
                availableChannels: ['push'],
                channels: s?.channels ?? [{ channel: 'push', scenario: enabled ? 'always' : 'off' }],
                templates: s?.templates ?? {},
            };
        });
    }
    async updateType(ctx, businessId, kind, patch) {
        const def = notifyKindOf(kind);
        if (!def)
            throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
        await this.prisma.$transaction(async (tx) => {
            const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
            const data = row?.data ?? {};
            const before = { ...(data[kind] ?? {}) };
            const next = { ...before };
            if (patch.enabled !== undefined)
                next.enabled = patch.enabled;
            if (patch.channels)
                next.channels = patch.channels;
            data[kind] = next;
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: AREA } },
                create: { businessId, area: AREA, data: J(data), updatedBy: ctx.member?.staffId },
                update: { data: J(data), version: { increment: 1 }, updatedBy: ctx.member?.staffId },
            });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'notify_type', entityId: `${businessId}:${kind}`, businessId, before: R(before), after: R(next) });
        });
        return (await this.list(businessId)).find((t) => t.code === def.code);
    }
    async getTemplates(businessId, kind) {
        if (!notifyKindOf(kind))
            throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
        const stored = await readStoredTypes(this.prisma, businessId);
        return stored[kind]?.templates ?? {};
    }
    /** Патч по каналу мержится ПОВЕРХ текущего — как updateType в моке, не перетирает другие языки того же канала */
    async updateTemplates(ctx, businessId, kind, patch) {
        const def = notifyKindOf(kind);
        if (!def)
            throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
        let result = {};
        await this.prisma.$transaction(async (tx) => {
            const row = await tx.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
            const data = row?.data ?? {};
            const current = data[kind] ?? {};
            const templates = { ...(current.templates ?? {}) };
            for (const [channel, val] of Object.entries(patch)) {
                const existing = templates[channel] ?? { ru: '' };
                templates[channel] = { ...existing, ...val, ru: val.ru ?? existing.ru };
            }
            data[kind] = { ...current, templates };
            result = templates;
            await tx.businessSetting.upsert({
                where: { businessId_area: { businessId, area: AREA } },
                create: { businessId, area: AREA, data: J(data), updatedBy: ctx.member?.staffId },
                update: { data: J(data), version: { increment: 1 }, updatedBy: ctx.member?.staffId },
            });
            await this.audit.record(tx, ctx, { action: 'update', entityType: 'notify_template', entityId: `${businessId}:${kind}`, businessId, before: R({ templates: current.templates ?? {} }), after: R({ templates }) });
        });
        return result;
    }
    /** «Показать пример» (F-05-023) — рендер шаблона (свой или по умолчанию) на выдуманных данных */
    async preview(businessId, kind, localeRaw) {
        const def = notifyKindOf(kind);
        if (!def)
            throw new ApiError('not_found', `Unknown notify kind: ${kind}`);
        const locale = isLocale(localeRaw) ? localeRaw : 'ru';
        const templates = await this.getTemplates(businessId, kind);
        const sample = { service: 'Haircut', time: '18:00', place: 'Kaytsak Barbershop', client: 'Ани', staff: 'Ани' };
        const custom = templates.push?.[locale] ?? templates.push?.ru;
        return { text: custom ? renderTemplate(custom, sample) : t(locale, def.messageKey, sample) };
    }
};
NotifyTypesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], NotifyTypesService);
export { NotifyTypesService };
function renderTemplate(template, params) {
    return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
}
//# sourceMappingURL=notify-types.service.js.map