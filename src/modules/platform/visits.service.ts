import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';

type VisitStatus = 'connected' | 'thinking' | 'refused';
type CallbackState = 'overdue' | 'today' | 'later' | 'none';
type HistoryEvent = { id: string; at: string; kind: 'created' | 'status' | 'callback' | 'callbackDone' | 'note' | 'connected'; status?: VisitStatus; date?: string; text?: string };

export interface VisitInput {
  placeName: string;
  contactName?: string;
  phone?: string;
  district?: string;
  address?: string;
  sphereId?: string;
  status: VisitStatus;
  visitedAt: string;
  callbackDate?: string;
  refusalReason?: string;
  note?: string;
  currentTool?: string;
  willingToPay?: number;
  responsibleId: string;
}

function todayLocal(): string {
  return utcToLocal(new Date()).slice(0, 10);
}

function callbackState(v: { status: string; callbackDate?: string }, today: string): CallbackState {
  if (v.status !== 'thinking' || !v.callbackDate) return 'none';
  if (v.callbackDate < today) return 'overdue';
  if (v.callbackDate === today) return 'today';
  return 'later';
}

const CALLBACK_RANK: Record<CallbackState, number> = { overdue: 0, today: 1, later: 2, none: 3 };

/** Просроченные → сегодня → позже → без даты; внутри — по дате перезвона, потом свежие визиты выше */
function sortForWork<T extends { status: string; callbackDate?: string; createdAt: string }>(rows: T[], today: string): T[] {
  return [...rows].sort((a, b) => {
    const ra = CALLBACK_RANK[callbackState(a, today)];
    const rb = CALLBACK_RANK[callbackState(b, today)];
    if (ra !== rb) return ra - rb;
    if (a.callbackDate && b.callbackDate && a.callbackDate !== b.callbackDate) return a.callbackDate.localeCompare(b.callbackDate);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function view(row: Prisma.SalesVisitGetPayload<object>) {
  return {
    id: row.id,
    placeName: row.placeName,
    contactName: row.contactName ?? undefined,
    phone: row.phone ?? undefined,
    district: row.district ?? undefined,
    address: row.address ?? undefined,
    sphereId: row.sphereId ?? undefined,
    status: row.status as VisitStatus,
    visitedAt: row.visitedAt,
    callbackDate: row.callbackDate ?? undefined,
    refusalReason: row.refusalReason ?? undefined,
    note: row.note ?? undefined,
    currentTool: row.currentTool ?? undefined,
    willingToPay: row.willingToPay !== null ? Number(row.willingToPay) : undefined,
    responsibleId: row.responsibleId,
    businessId: row.businessId ?? undefined,
    promoCodeId: row.promoCodeId ?? undefined,
    history: (row.history ?? []) as HistoryEvent[],
    createdAt: utcToLocal(row.createdAt),
    updatedAt: utcToLocal(row.updatedAt),
  };
}

/**
 * Визиты нашей команды (F-00-177) — CRM обхода. Привязка к настоящему бизнесу (businessId) появляется только
 * когда салон подключён «Подключить салон за 10 минут» (F-00-176) — этот поток (connect-drafts, docs 02 §19
 * ConnectDraft) не входит в этот проход (см. PROGRESS.md); визит без businessId полноценно работает сам по себе.
 */
@Injectable()
export class VisitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: { status?: VisitStatus; district?: string }) {
    const rows = await this.prisma.salesVisit.findMany({ where: { status: filter.status, district: filter.district }, take: 1000 });
    return sortForWork(rows.map(view), todayLocal());
  }

  async counts(): Promise<Record<VisitStatus | 'all', number>> {
    const rows = await this.prisma.salesVisit.groupBy({ by: ['status'], _count: { _all: true } });
    const counts: Record<VisitStatus | 'all', number> = { all: 0, connected: 0, thinking: 0, refused: 0 };
    for (const r of rows) {
      counts[r.status as VisitStatus] = r._count._all;
      counts.all += r._count._all;
    }
    return counts;
  }

  async listCallbacksToday() {
    const today = todayLocal();
    const rows = await this.prisma.salesVisit.findMany({ where: { status: 'thinking', callbackDate: { lte: today } }, take: 500 });
    return sortForWork(rows.map(view), today).map((v) => ({
      visitId: v.id,
      placeName: v.placeName,
      contactName: v.contactName,
      phone: v.phone,
      callbackDate: v.callbackDate ?? today,
      overdueDays: Math.max(0, Math.round((Date.parse(today) - Date.parse(v.callbackDate ?? today)) / 86_400_000)),
    }));
  }

  private clean(input: Partial<VisitInput>): Partial<VisitInput> {
    const out = { ...input };
    if (input.status && input.status !== 'thinking') out.callbackDate = undefined;
    if (input.status && input.status !== 'refused') out.refusalReason = undefined;
    return out;
  }

  async create(input: VisitInput) {
    const placeName = input.placeName.trim();
    if (!placeName) throw new ApiError('validation', 'Place name required', { placeName: 'required' });
    const cleaned = { ...input, ...this.clean(input), placeName };
    const now = new Date();
    const history: HistoryEvent[] = [{ id: newId('salesVisitEvent'), at: utcToLocal(now), kind: 'created', status: cleaned.status }];
    const row = await this.prisma.salesVisit.create({
      data: {
        id: newId('salesVisit'),
        placeName: cleaned.placeName,
        contactName: cleaned.contactName ?? null,
        phone: cleaned.phone ?? null,
        district: cleaned.district ?? null,
        address: cleaned.address ?? null,
        sphereId: cleaned.sphereId ?? null,
        status: cleaned.status,
        visitedAt: cleaned.visitedAt,
        callbackDate: cleaned.callbackDate ?? null,
        refusalReason: cleaned.refusalReason ?? null,
        note: cleaned.note ?? null,
        currentTool: cleaned.currentTool ?? null,
        willingToPay: cleaned.willingToPay !== undefined ? BigInt(cleaned.willingToPay) : null,
        responsibleId: cleaned.responsibleId,
        history: history as unknown as Prisma.InputJsonValue,
      },
    });
    return view(row);
  }

  async update(id: string, patch: Partial<VisitInput>) {
    const visit = await this.prisma.salesVisit.findUnique({ where: { id } });
    if (!visit) throw new ApiError('not_found', 'Visit not found');
    const cleaned = this.clean(patch);
    const now = new Date();
    const history = [...((visit.history ?? []) as HistoryEvent[])];
    if (patch.status && patch.status !== visit.status) history.push({ id: newId('salesVisitEvent'), at: utcToLocal(now), kind: 'status', status: patch.status });
    if (cleaned.callbackDate && cleaned.callbackDate !== visit.callbackDate) history.push({ id: newId('salesVisitEvent'), at: utcToLocal(now), kind: 'callback', date: cleaned.callbackDate });
    const data: Prisma.SalesVisitUpdateInput = {
      history: history as unknown as Prisma.InputJsonValue,
      ...(cleaned.placeName !== undefined ? { placeName: cleaned.placeName.trim() } : {}),
      ...(cleaned.contactName !== undefined ? { contactName: cleaned.contactName } : {}),
      ...(cleaned.phone !== undefined ? { phone: cleaned.phone } : {}),
      ...(cleaned.district !== undefined ? { district: cleaned.district } : {}),
      ...(cleaned.address !== undefined ? { address: cleaned.address } : {}),
      ...(cleaned.sphereId !== undefined ? { sphereId: cleaned.sphereId } : {}),
      ...(cleaned.status !== undefined ? { status: cleaned.status } : {}),
      ...(cleaned.visitedAt !== undefined ? { visitedAt: cleaned.visitedAt } : {}),
      ...(cleaned.note !== undefined ? { note: cleaned.note } : {}),
      ...(cleaned.currentTool !== undefined ? { currentTool: cleaned.currentTool } : {}),
      ...(cleaned.willingToPay !== undefined ? { willingToPay: BigInt(cleaned.willingToPay) } : {}),
      ...(cleaned.responsibleId !== undefined ? { responsibleId: cleaned.responsibleId } : {}),
      // cleanInput снимает поле, если статус больше не 'thinking'/'refused' — patch содержал 'status' явно,
      // а undefined из cleanInput значит «очистить», не «не трогать»
      callbackDate: 'callbackDate' in patch || (patch.status && patch.status !== 'thinking') ? (cleaned.callbackDate ?? null) : undefined,
      refusalReason: 'refusalReason' in patch || (patch.status && patch.status !== 'refused') ? (cleaned.refusalReason ?? null) : undefined,
    };
    const updated = await this.prisma.salesVisit.update({ where: { id }, data });
    return view(updated);
  }

  async completeCallback(id: string, note?: string) {
    const visit = await this.prisma.salesVisit.findUnique({ where: { id } });
    if (!visit) throw new ApiError('not_found', 'Visit not found');
    const now = new Date();
    const history = [...((visit.history ?? []) as HistoryEvent[]), { id: newId('salesVisitEvent'), at: utcToLocal(now), kind: 'callbackDone' as const }];
    const updated = await this.prisma.salesVisit.update({ where: { id }, data: { callbackDate: null, note: note ?? visit.note, history: history as unknown as Prisma.InputJsonValue } });
    return view(updated);
  }
}
