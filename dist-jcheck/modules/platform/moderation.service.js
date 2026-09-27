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
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { grantCoins, spendCoins } from '../billing/coins.js';
function view(row, businessName, reasonLabel) {
    return {
        id: row.id,
        kind: row.kind,
        businessId: row.businessId,
        staffId: row.staffId ?? undefined,
        serviceId: row.serviceId ?? undefined,
        refId: row.refId,
        label: row.label ?? undefined,
        text: row.text ?? undefined,
        imageUrl: row.imageUrl ?? undefined,
        tone: row.tone ?? undefined,
        paidCoins: row.paidCoins ?? undefined,
        status: row.status,
        source: row.source,
        reasonId: row.reasonId ?? undefined,
        reasonNote: row.reasonNote ?? undefined,
        targetItemId: row.targetItemId ?? undefined,
        submittedAt: utcToLocal(row.submittedAt),
        decidedAt: row.decidedAt ? utcToLocal(row.decidedAt) : undefined,
        history: (row.history ?? []),
        businessName,
        reasonLabel,
    };
}
/**
 * Очередь проверки (docs/backend/06 §1, F-00-168…171/179). refId — ключ вызывающей стороны (каталог сам решает,
 * что он значит); подключение публичных выборок к moderation_status — отдельный проход (P7, не в этом этапе:
 * ничего снаружи модуля сейчас isVisibleToClients не читает — тот же честный разрыв, что уже отмечен в
 * docs/backend/07-mock-only.md, только теперь у него есть настоящая серверная реализация, которую можно позвать).
 */
let ModerationService = class ModerationService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(filter) {
        const rows = await this.prisma.moderationItem.findMany({
            where: { status: filter.status, kind: filter.kind },
            orderBy: { submittedAt: filter.status === 'pending' ? 'asc' : 'desc' },
            take: 500,
        });
        const bizIds = [...new Set(rows.map((r) => r.businessId))];
        const reasonIds = [...new Set(rows.map((r) => r.reasonId).filter((x) => Boolean(x)))];
        const [businesses, reasons] = await Promise.all([
            this.prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } }),
            this.prisma.rejectReason.findMany({ where: { id: { in: reasonIds } } }),
        ]);
        const bizName = new Map(businesses.map((b) => [b.id, b.name]));
        const reasonLabel = new Map(reasons.map((r) => [r.id, r.label]));
        return rows.map((r) => view(r, bizName.get(r.businessId) ?? '', r.reasonId ? reasonLabel.get(r.reasonId) : undefined));
    }
    async counts() {
        const rows = await this.prisma.moderationItem.groupBy({ by: ['status'], _count: { _all: true } });
        const counts = { pending: 0, approved: 0, rejected: 0, auto: 0 };
        for (const r of rows)
            counts[r.status] = r._count._all;
        return counts;
    }
    async listReasons(includeInactive = false) {
        const rows = await this.prisma.rejectReason.findMany({ where: includeInactive ? undefined : { active: true }, orderBy: { order: 'asc' } });
        return rows.map((r) => ({ id: r.id, label: r.label, active: r.active, order: r.order }));
    }
    async saveReason(input) {
        const data = { label: input.label, active: input.active ?? true, order: input.order ?? 0 };
        const row = input.id
            ? await this.prisma.rejectReason.update({ where: { id: input.id }, data }).catch(() => {
                throw new ApiError('not_found', 'Reason not found');
            })
            : await this.prisma.rejectReason.create({ data: { id: newId('rejectReason'), ...data } });
        return { id: row.id, label: row.label, active: row.active, order: row.order };
    }
    async hideReason(id) {
        const n = await this.prisma.rejectReason.updateMany({ where: { id }, data: { active: false } });
        if (!n.count)
            throw new ApiError('not_found', 'Reason not found');
    }
    /** F-00-169: шаблон/визит — без очереди; повтор проходит без очереди, только если исходник сам approved/auto */
    async statusFor(source, targetItemId) {
        if (source === 'template' || source === 'visit')
            return 'auto';
        if (source === 'reuse' && targetItemId) {
            const target = await this.prisma.moderationItem.findUnique({ where: { id: targetItemId }, select: { status: true } });
            if (target && (target.status === 'approved' || target.status === 'auto'))
                return 'auto';
        }
        return 'pending';
    }
    async submit(input) {
        const source = input.source ?? 'user';
        const status = await this.statusFor(source, input.targetItemId);
        const now = new Date();
        const history = [{ id: newId('moderationEvent'), at: utcToLocal(now), kind: 'submitted' }];
        if (status === 'auto')
            history.push({ id: newId('moderationEvent'), at: utcToLocal(now), kind: 'auto' });
        const row = await this.prisma.moderationItem.create({
            data: {
                id: newId('moderationItem'),
                kind: input.kind,
                businessId: input.businessId,
                staffId: input.staffId ?? null,
                serviceId: input.serviceId ?? null,
                refId: input.refId,
                label: input.label ?? null,
                text: input.text ?? null,
                imageUrl: input.imageUrl ?? null,
                paidCoins: input.paidCoins ?? null,
                status,
                source,
                targetItemId: input.targetItemId ?? null,
                submittedAt: now,
                decidedAt: status === 'auto' ? now : null,
                history: history,
            },
        });
        return view(row);
    }
    async approve(id) {
        return this.prisma.$transaction(async (tx) => {
            const item = await tx.moderationItem.findUnique({ where: { id } });
            if (!item)
                throw new ApiError('not_found', 'Moderation item not found');
            if (item.status !== 'pending')
                throw new ApiError('conflict', 'Not pending');
            const now = new Date();
            const history = [...(item.history ?? []), { id: newId('moderationEvent'), at: utcToLocal(now), kind: 'approved' }];
            const updated = await tx.moderationItem.update({ where: { id }, data: { status: 'approved', decidedAt: now, history: history } });
            return view(updated);
        });
    }
    async reject(id, reasonId, note, by) {
        return this.prisma.$transaction(async (tx) => {
            const item = await tx.moderationItem.findUnique({ where: { id } });
            if (!item)
                throw new ApiError('not_found', 'Moderation item not found');
            if (item.status !== 'pending')
                throw new ApiError('conflict', 'Not pending');
            const reason = await tx.rejectReason.findUnique({ where: { id: reasonId } });
            if (!reason)
                throw new ApiError('validation', 'Unknown reason', { reasonId: 'not_found' });
            const now = new Date();
            const history = [...(item.history ?? []), { id: newId('moderationEvent'), at: utcToLocal(now), kind: 'rejected', note }];
            if (item.paidCoins) {
                await grantCoins(tx, { businessId: item.businessId, amount: item.paidCoins, reason: 'moderationReject', area: 'moderation', refId: item.id, by }, 'refund');
                history.push({ id: newId('moderationEvent'), at: utcToLocal(now), kind: 'refund', coins: item.paidCoins });
            }
            const updated = await tx.moderationItem.update({
                where: { id },
                data: { status: 'rejected', reasonId, reasonNote: note ?? null, decidedAt: now, history: history },
            });
            return view(updated);
        });
    }
    /** «Отменить» в тосте после решения (10 с окно F-00-… общий Undo — здесь прямой повторный вызов панели) */
    async reopen(id, by) {
        return this.prisma.$transaction(async (tx) => {
            const item = await tx.moderationItem.findUnique({ where: { id } });
            if (!item)
                throw new ApiError('not_found', 'Moderation item not found');
            const now = new Date();
            const history = [...(item.history ?? []), { id: newId('moderationEvent'), at: utcToLocal(now), kind: 'reopened' }];
            // Отличие от мока (честно): списание возврата обратно проверяет баланс (402), а не уходит в минус молча.
            if (item.status === 'rejected' && item.paidCoins) {
                await spendCoins(tx, { businessId: item.businessId, amount: item.paidCoins, reason: 'manual', area: 'moderation', refId: item.id, by });
            }
            const updated = await tx.moderationItem.update({
                where: { id },
                data: { status: 'pending', reasonId: null, reasonNote: null, decidedAt: null, history: history },
            });
            return view(updated);
        });
    }
    /** null, не undefined: `res.json(undefined)` в Express уходит невалидной строкой "undefined", не пустым телом */
    async getStatus(refId) {
        const row = await this.prisma.moderationItem.findFirst({ where: { refId }, orderBy: { submittedAt: 'desc' } });
        return row ? view(row) : null;
    }
    /** Нет записи в очереди — материал старый (до проверки) и виден; иначе — только approved/auto (F-00-168) */
    async isVisibleToClients(refId) {
        const row = await this.prisma.moderationItem.findFirst({ where: { refId }, orderBy: { submittedAt: 'desc' }, select: { status: true } });
        return !row || row.status === 'approved' || row.status === 'auto';
    }
};
ModerationService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], ModerationService);
export { ModerationService };
//# sourceMappingURL=moderation.service.js.map