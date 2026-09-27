import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

type IdeaStatus = 'considering' | 'inProgress' | 'done';

function view(row: Prisma.IdeaGetPayload<object>) {
  return {
    id: row.id,
    businessId: row.businessId,
    authorName: row.authorName,
    text: row.text,
    votes: row.votes,
    voterIds: (row.voterIds ?? []) as string[],
    status: row.status as IdeaStatus,
    createdAt: utcToLocal(row.createdAt),
    decidedAt: row.decidedAt ? utcToLocal(row.decidedAt) : undefined,
    notifiedAt: row.notifiedAt ? utcToLocal(row.notifiedAt) : undefined,
  };
}

/** Идеи бизнесов (F-00-009) — заводит кабинет, очередь и статус ведёт наша панель. */
@Injectable()
export class IdeasService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.idea.findMany({ orderBy: { votes: 'desc' }, take: 500 });
    return rows.map(view);
  }

  async create(businessId: string, authorName: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError('validation', 'Idea text required', { text: 'required' });
    const row = await this.prisma.idea.create({ data: { id: newId('idea'), businessId, authorName, text: trimmed, votes: 0, voterIds: [], status: 'considering' } });
    return view(row);
  }

  /** Один бизнес голосует один раз (voterIds — id проголосовавших бизнесов) */
  async vote(id: string, businessId: string) {
    return this.prisma.$transaction(async (tx) => {
      const idea = await tx.idea.findUnique({ where: { id } });
      if (!idea) throw new ApiError('not_found', 'Idea not found');
      const voters = (idea.voterIds ?? []) as string[];
      if (voters.includes(businessId)) return view(idea);
      const updated = await tx.idea.update({ where: { id }, data: { votes: idea.votes + 1, voterIds: [...voters, businessId] as unknown as Prisma.InputJsonValue } });
      return view(updated);
    });
  }

  async setStatus(id: string, status: IdeaStatus) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) throw new ApiError('not_found', 'Idea not found');
    const now = new Date();
    const updated = await this.prisma.idea.update({
      where: { id },
      data: { status, decidedAt: now, notifiedAt: status === 'done' && !idea.notifiedAt ? now : undefined },
    });
    return view(updated);
  }
}
