import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/http/context.js';
import { PrismaService } from '../../common/prisma.service.js';
import { clientBookings, withVisits } from '../clients/clients.visits.js';
import { clientRowView, type ClientRowView } from '../clients/clients.views.js';
import type { LoyaltyProgramBody } from './loyalty.schemas.js';

const AREA = 'loyalty-program';
const VISIBILITY_AREA = 'loyalty';

function emptyProgram(): LoyaltyProgramBody {
  return {
    enabled: false,
    discountTiers: [],
    classRules: { bronze: {}, silver: {}, gold: {} },
    addRules: [],
    removeRules: [],
    settings: { cancelDiscountAfterDays: 360, cancelClassAfterDays: 360, discountEndWarnDays: null },
  };
}

/** F-04-121: что вызвало пересчёт — три автоматических момента + ручной + сохранение программы */
export type RecalcTrigger = 'manual' | 'programSaved' | 'statusArrived' | 'statusNoShow';

export interface RecalcChange {
  clientId: string;
  discountBefore: number;
  discountAfter: number;
  classBefore?: 'gold' | 'silver' | 'bronze';
  classAfter?: 'gold' | 'silver' | 'bronze';
  categoriesAdded: string[];
  categoriesRemoved: string[];
}

function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - new Date(`${iso}T00:00:00Z`).getTime()) / 86_400_000);
}

function evalTrigger(rule: { trigger: string; threshold?: number }, row: ClientRowView, trigger: RecalcTrigger, inactiveDays: number): boolean {
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
@Injectable()
export class LoyaltyProgramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(businessId: string): Promise<LoyaltyProgramBody> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
    return (row?.data as LoyaltyProgramBody | undefined) ?? emptyProgram();
  }

  /** В-06: «клиенту видно своё, если бизнес не выключил "показывать клиенту"» — по умолчанию включено */
  async getShowToClient(businessId: string): Promise<boolean> {
    const row = await this.prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: VISIBILITY_AREA } } });
    return (row?.data as { showToClient?: boolean } | undefined)?.showToClient ?? true;
  }

  async setShowToClient(ctx: RequestContext, businessId: string, showToClient: boolean): Promise<{ showToClient: boolean }> {
    await this.prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: VISIBILITY_AREA } },
      create: { businessId, area: VISIBILITY_AREA, data: { showToClient }, updatedBy: ctx.member!.staffId },
      update: { data: { showToClient }, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
    });
    return { showToClient };
  }

  private async row(businessId: string, clientId: string): Promise<ClientRowView | null> {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId, deletedAt: null } });
    if (!client) return null;
    const bookings = await clientBookings(this.prisma, [businessId], [clientId]);
    return withVisits([clientRowView(client)], bookings, new Map())[0]!;
  }

  /** F-04-073 и три автоматических момента (F-04-121). null — правила выключены/клиента нет/ничего не изменилось. */
  async recalcOne(ctx: RequestContext | null, businessId: string, clientId: string, trigger: RecalcTrigger, tx?: Prisma.TransactionClient): Promise<RecalcChange | null> {
    const program = await this.get(businessId);
    if (!program.enabled) return null;
    const row = await this.row(businessId, clientId);
    if (!row) return null;
    const now = new Date();
    const inactiveDays = daysSince(row.lastVisit, now);

    let discountAfter = 0;
    for (const t of program.discountTiers) {
      const value = t.basis === 'sold' ? row.sold : t.basis === 'paid' ? row.paid : row.visits;
      if (value >= t.from && t.percent > discountAfter) discountAfter = t.percent;
    }
    if (inactiveDays >= program.settings.cancelDiscountAfterDays) discountAfter = 0;

    let classAfter: 'gold' | 'silver' | 'bronze' | undefined;
    for (const cls of ['gold', 'silver', 'bronze'] as const) {
      const t = program.classRules[cls];
      const meets = (t.minSold !== undefined && row.sold >= t.minSold) || (t.minPaid !== undefined && row.paid >= t.minPaid) || (t.minVisits !== undefined && row.visits >= t.minVisits);
      if (meets) {
        classAfter = cls;
        break;
      }
    }
    if (inactiveDays >= program.settings.cancelClassAfterDays) classAfter = undefined;

    const tags = new Set(row.tags);
    const categoriesAdded: string[] = [];
    const categoriesRemoved: string[] = [];
    for (const rule of program.addRules) {
      if (tags.has(rule.category)) continue;
      if (evalTrigger(rule, row, trigger, inactiveDays)) {
        tags.add(rule.category);
        categoriesAdded.push(rule.category);
      }
    }
    for (const rule of program.removeRules) {
      if (!tags.has(rule.category)) continue;
      if (evalTrigger(rule, row, trigger, inactiveDays)) {
        tags.delete(rule.category);
        categoriesRemoved.push(rule.category);
      }
    }

    const discountBefore = row.discount;
    const classBefore = row.importanceClass;
    if (discountBefore === discountAfter && classBefore === classAfter && !categoriesAdded.length && !categoriesRemoved.length) return null;

    const write = async (t: Prisma.TransactionClient | PrismaService) => {
      await t.client.update({ where: { id: clientId }, data: { discountPercent: discountAfter, importanceClass: classAfter ?? null, tags: Array.from(tags), version: { increment: 1 } } });
      if (ctx) await this.audit.record(t, ctx, { action: 'loyaltyRecalc', entityType: 'client', entityId: clientId, businessId, before: { discount: discountBefore, importanceClass: classBefore ?? null }, after: { discount: discountAfter, importanceClass: classAfter ?? null } });
    };
    if (tx) await write(tx);
    else await this.prisma.$transaction((t) => write(t));

    return { clientId, discountBefore, discountAfter, classBefore, classAfter, categoriesAdded, categoriesRemoved };
  }

  async recalcAll(ctx: RequestContext, businessId: string, trigger: RecalcTrigger): Promise<number> {
    const ids = await this.prisma.client.findMany({ where: { businessId, deletedAt: null }, select: { id: true } });
    let changed = 0;
    for (const { id } of ids) {
      const result = await this.recalcOne(ctx, businessId, id, trigger);
      if (result) changed++;
    }
    return changed;
  }

  /** F-04-121: сохранение программы пересчитывает всех клиентов локации сразу */
  async save(ctx: RequestContext, businessId: string, program: LoyaltyProgramBody): Promise<{ program: LoyaltyProgramBody; recalculated: number }> {
    await this.prisma.$transaction(async (tx) => {
      await tx.businessSetting.upsert({
        where: { businessId_area: { businessId, area: AREA } },
        create: { businessId, area: AREA, data: program as object, updatedBy: ctx.member!.staffId },
        update: { data: program as object, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
      });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'loyaltyProgram', entityId: businessId, businessId, before: null, after: { enabled: program.enabled } });
    });
    const recalculated = await this.recalcAll(ctx, businessId, 'programSaved');
    return { program, recalculated };
  }
}
