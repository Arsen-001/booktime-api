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
function view(row) {
    return {
        id: row.id,
        businessId: row.businessId,
        authorName: row.authorName,
        text: row.text,
        votes: row.votes,
        voterIds: (row.voterIds ?? []),
        status: row.status,
        createdAt: utcToLocal(row.createdAt),
        decidedAt: row.decidedAt ? utcToLocal(row.decidedAt) : undefined,
        notifiedAt: row.notifiedAt ? utcToLocal(row.notifiedAt) : undefined,
    };
}
/** Идеи бизнесов (F-00-009) — заводит кабинет, очередь и статус ведёт наша панель. */
let IdeasService = class IdeasService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list() {
        const rows = await this.prisma.idea.findMany({ orderBy: { votes: 'desc' }, take: 500 });
        return rows.map(view);
    }
    async create(businessId, authorName, text) {
        const trimmed = text.trim();
        if (!trimmed)
            throw new ApiError('validation', 'Idea text required', { text: 'required' });
        const row = await this.prisma.idea.create({ data: { id: newId('idea'), businessId, authorName, text: trimmed, votes: 0, voterIds: [], status: 'considering' } });
        return view(row);
    }
    /** Один бизнес голосует один раз (voterIds — id проголосовавших бизнесов) */
    async vote(id, businessId) {
        return this.prisma.$transaction(async (tx) => {
            const idea = await tx.idea.findUnique({ where: { id } });
            if (!idea)
                throw new ApiError('not_found', 'Idea not found');
            const voters = (idea.voterIds ?? []);
            if (voters.includes(businessId))
                return view(idea);
            const updated = await tx.idea.update({ where: { id }, data: { votes: idea.votes + 1, voterIds: [...voters, businessId] } });
            return view(updated);
        });
    }
    async setStatus(id, status) {
        const idea = await this.prisma.idea.findUnique({ where: { id } });
        if (!idea)
            throw new ApiError('not_found', 'Idea not found');
        const now = new Date();
        const updated = await this.prisma.idea.update({
            where: { id },
            data: { status, decidedAt: now, notifiedAt: status === 'done' && !idea.notifiedAt ? now : undefined },
        });
        return view(updated);
    }
};
IdeasService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], IdeasService);
export { IdeasService };
//# sourceMappingURL=ideas.service.js.map