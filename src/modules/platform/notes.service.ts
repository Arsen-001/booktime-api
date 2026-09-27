import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';

/** LocalizedText фронта: ru обязателен, остальные языки и лишние ключи — как придут */
type LocalizedText = { ru: string; [lang: string]: unknown };

export interface WaveItem {
  id: string;
  wave: 1 | 2 | 3;
  fids: string[];
  title: LocalizedText;
  status: 'todo' | 'building' | 'passed';
  note?: string;
}
export interface PrelaunchItem {
  id: string;
  order: number;
  title: LocalizedText;
  hint: LocalizedText;
  status: 'open' | 'decided' | 'done';
  decision: string;
  note: string;
  updatedAt?: string;
}
export interface PaybackInputs {
  monthlyCosts: number;
  individualPrice: number;
  salonPerMaster: number;
  avgMasters: number;
  discountShare: number;
  discountPercent: number;
  targetNet: number;
  usdRate: number;
  eurRate: number;
}
export interface NameCandidate {
  id: string;
  name: string;
  spelling: { ru: string; hy: string; en: string };
  checks: { ru: 'unknown' | 'ok' | 'bad'; hy: 'unknown' | 'ok' | 'bad'; en: 'unknown' | 'ok' | 'bad' };
  domain: string;
  domainStatus: 'unknown' | 'free' | 'taken' | 'bought';
  note: string;
}
export interface BrandState {
  chosenId?: string;
  decidedAt?: string;
}
export interface LaunchNotesDoc {
  waveItems: WaveItem[];
  prelaunchItems: PrelaunchItem[];
  paybackInputs: PaybackInputs;
  nameCandidates: NameCandidate[];
  brand: BrandState;
}

const DEFAULT_DOC: LaunchNotesDoc = {
  waveItems: [],
  prelaunchItems: [],
  paybackInputs: { monthlyCosts: 800_000, individualPrice: 5000, salonPerMaster: 4000, avgMasters: 4, discountShare: 30, discountPercent: 15, targetNet: 500_000, usdRate: 363, eurRate: 430 },
  nameCandidates: [],
  brand: {},
};

/**
 * Заметки основателя — план запуска, окупаемость, имя (01 §8, F-00-203…208, docs/backend/02 §19: «…/notes,
 * одним документом»). Рабочий документ, не продуктовая функция конечных пользователей — см. PROGRESS.md.
 */
@Injectable()
export class PlatformNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async getDoc(): Promise<LaunchNotesDoc> {
    const row = await this.prisma.platformNotes.findUnique({ where: { id: 'singleton' } });
    if (!row) return DEFAULT_DOC;
    return { ...DEFAULT_DOC, ...(row.data as Partial<LaunchNotesDoc>) };
  }

  async saveDoc(patch: Partial<LaunchNotesDoc>): Promise<LaunchNotesDoc> {
    const current = await this.getDoc();
    const next: LaunchNotesDoc = { ...current, ...patch };
    const data = next as unknown as Prisma.InputJsonValue;
    await this.prisma.platformNotes.upsert({ where: { id: 'singleton' }, update: { data }, create: { id: 'singleton', data } });
    return next;
  }

  /** «Сейчас платят» (F-00-206) — из реальных подписок, не вводим руками: Subscription.status === 'active' */
  async getPayingNow() {
    const subs = await this.prisma.subscription.findMany({ where: { status: 'active' }, select: { businessId: true } });
    const businesses = await this.prisma.business.findMany({ where: { id: { in: subs.map((s) => s.businessId) } }, select: { kind: true } });
    let salons = 0;
    let individuals = 0;
    for (const b of businesses) {
      if (b.kind === 'individual') individuals += 1;
      else salons += 1;
    }
    return { salons, individuals };
  }
}
