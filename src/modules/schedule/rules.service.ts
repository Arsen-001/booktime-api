import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { nowLocal } from '../../common/time/time.js';
import { AvailabilityService, type RuleSetRow } from '../availability/availability.service.js';
import { addDays, newSlotRule, resolveSlotRule, type ServiceSlotWindow, type SlotRule, type UnavailableRange } from '../availability/engine.js';
import { personKeyOf } from '../availability/occupy.js';
import { actorOf, ScheduleService } from './schedule.service.js';

type Tx = Prisma.TransactionClient;
type Kind = 'location' | 'staff';

const baseRule = () => newSlotRule('scr_default', { isBase: true });

/**
 * Правила онлайн-записи (F-02-041…055, F-02-059, F-02-067): правило окон по филиалу или «персонально» мастеру,
 * исключения по дням недели, ручное выключение времени, недоступные дни, запас между клиентами, окно услуги.
 * Любая правка сбрасывает кеш окон бизнеса и пишет строку «История правок» (recheck-c3).
 */
@Injectable()
export class RulesService {
  constructor(
    private readonly schedule: ScheduleService,
    private readonly availability: AvailabilityService,
  ) {}

  private get prisma() {
    return this.schedule.prisma;
  }

  /** scope принадлежит бизнесу: филиал или сотрудник этого бизнеса */
  private async assertScope(db: Tx | typeof this.prisma, businessId: string, kind: Kind, id: string): Promise<void> {
    const ok =
      kind === 'location'
        ? await db.location.findFirst({ where: { id, businessId }, select: { id: true } })
        : await db.staff.findFirst({ where: { id, businessId }, select: { id: true } });
    if (!ok) throw new ApiError('not_found', 'Scope not found');
  }

  /** Правило окон правит schedule.edit; свои правила мастер — только себе */
  private assertEdit(ctx: RequestContext, kind: Kind, id: string): void {
    if (kind === 'staff') this.schedule.assertCanEdit(ctx, [id]);
    else if (!ctx.member!.permissions.has('schedule.edit') || !(ctx.member!.permissions.has('journal.others') || ctx.member!.kind === 'individual')) {
      throw new ApiError('forbidden', 'Location rules are edited by an administrator');
    }
  }

  private async row(db: Tx | typeof this.prisma, kind: Kind, id: string): Promise<RuleSetRow | null> {
    const r = await db.onlineSlotRuleSet.findUnique({ where: { scope_scopeId: { scope: kind, scopeId: id } } });
    if (!r) return null;
    return {
      scope: r.scope,
      scopeId: r.scopeId,
      rules: (r.rules as SlotRule[] | null) ?? null,
      ownRules: r.ownRules,
      unavailable: (r.unavailable as UnavailableRange[] | null) ?? [],
      bufferMin: r.bufferMin,
    };
  }

  /** Правка строки правил под замком (SELECT … FOR UPDATE), журнал, сброс кеша */
  private async edit(
    ctx: RequestContext,
    businessId: string,
    kind: Kind,
    id: string,
    what: 'rule' | 'slot' | 'buffer' | 'closed_days' | 'own_rules',
    fn: (cur: RuleSetRow) => Partial<Omit<RuleSetRow, 'scope' | 'scopeId'>>,
    log: { before?: string; after?: string; dates?: string[] } = {},
  ): Promise<RuleSetRow> {
    this.assertEdit(ctx, kind, id);
    const next = await this.prisma.$transaction(async (tx) => {
      await this.assertScope(tx, businessId, kind, id);
      await tx.onlineSlotRuleSet.upsert({
        where: { scope_scopeId: { scope: kind, scopeId: id } },
        create: { scope: kind, scopeId: id, businessId },
        update: {},
      });
      await tx.$queryRaw`SELECT scope FROM online_slot_rules WHERE scope = ${kind} AND scope_id = ${id} FOR UPDATE`;
      const cur = (await this.row(tx, kind, id))!;
      const patch = fn(cur);
      await tx.onlineSlotRuleSet.update({
        where: { scope_scopeId: { scope: kind, scopeId: id } },
        data: {
          ...(patch.rules !== undefined ? { rules: patch.rules === null ? Prisma.DbNull : (patch.rules as unknown as Prisma.InputJsonValue) } : {}),
          ...(patch.ownRules !== undefined ? { ownRules: patch.ownRules } : {}),
          ...(patch.unavailable !== undefined ? { unavailable: patch.unavailable as unknown as Prisma.InputJsonValue } : {}),
          ...(patch.bufferMin !== undefined ? { bufferMin: patch.bufferMin } : {}),
          version: { increment: 1 },
        },
      });
      const actor = actorOf(ctx);
      await this.schedule.pushHistory(tx, businessId, {
        action: 'slot_rules',
        targetStaffIds: kind === 'staff' ? [id] : [],
        dates: log.dates ?? [],
        details: { what, role: actor.role, ...(log.before !== undefined ? { before: log.before } : {}), ...(log.after !== undefined ? { after: log.after } : {}) },
        actorName: actor.name,
        actorStaffId: actor.staffId,
      });
      return { ...cur, ...patch } as RuleSetRow;
    });
    await this.availability.invalidate({ businessIds: [businessId], ...(kind === 'staff' ? { staffIds: [id] } : {}) });
    return next;
  }

  // ─────────── «Общее по локации» / «Персонально» (F-02-041) ───────────

  async slotMode(businessId: string, staffId: string): Promise<'location' | 'own'> {
    await this.assertScope(this.prisma, businessId, 'staff', staffId);
    return (await this.row(this.prisma, 'staff', staffId))?.ownRules ? 'own' : 'location';
  }

  /** Первое «Персонально» копирует правила филиала — окна не пропадают */
  async setSlotMode(ctx: RequestContext, businessId: string, staffId: string, locationId: string, mode: 'location' | 'own') {
    const location = await this.row(this.prisma, 'location', locationId);
    await this.edit(ctx, businessId, 'staff', staffId, 'own_rules', (cur) => ({
      ownRules: mode === 'own',
      ...(mode === 'own' && !cur.rules ? { rules: (location?.rules ?? [baseRule()]).map((r) => ({ ...r, id: newId('slotRule') })) } : {}),
    }), { after: mode });
  }

  async rules(businessId: string, kind: Kind, id: string): Promise<SlotRule[]> {
    await this.assertScope(this.prisma, businessId, kind, id);
    const rules = (await this.row(this.prisma, kind, id))?.rules;
    return rules && rules.length ? rules : [baseRule()];
  }

  async effectiveRule(businessId: string, staffId: string, locationId: string, date: string): Promise<SlotRule> {
    const own = await this.row(this.prisma, 'staff', staffId);
    await this.assertScope(this.prisma, businessId, 'staff', staffId);
    const rules = own?.ownRules ? own.rules : (await this.row(this.prisma, 'location', locationId))?.rules;
    return resolveSlotRule(rules, date);
  }

  async saveRule(ctx: RequestContext, businessId: string, kind: Kind, id: string, rule: SlotRule): Promise<SlotRule> {
    let saved = rule;
    await this.edit(ctx, businessId, kind, id, 'rule', (cur) => {
      const list = cur.rules && cur.rules.length ? cur.rules : [baseRule()];
      const idx = list.findIndex((r) => r.id === rule.id);
      saved = idx >= 0 ? rule : { ...rule, id: rule.id || newId('slotRule') };
      return { rules: idx >= 0 ? list.map((r, i) => (i === idx ? saved : r)) : [...list, saved] };
    });
    return saved;
  }

  async deleteRule(ctx: RequestContext, businessId: string, kind: Kind, id: string, ruleId: string) {
    await this.edit(ctx, businessId, kind, id, 'rule', (cur) => ({ rules: (cur.rules ?? []).filter((r) => r.id !== ruleId || r.isBase) }));
  }

  async toggleSlot(ctx: RequestContext, businessId: string, kind: Kind, id: string, ruleId: string, time: string) {
    await this.edit(
      ctx,
      businessId,
      kind,
      id,
      'slot',
      (cur) => ({
        rules: (cur.rules && cur.rules.length ? cur.rules : [baseRule()]).map((r) =>
          r.id !== ruleId ? r : { ...r, disabledSlots: r.disabledSlots.includes(time) ? r.disabledSlots.filter((t) => t !== time) : [...r.disabledSlots, time] },
        ),
      }),
      { after: time },
    );
  }

  async togglePart(ctx: RequestContext, businessId: string, kind: Kind, id: string, ruleId: string, times: string[], enable: boolean) {
    await this.edit(ctx, businessId, kind, id, 'slot', (cur) => ({
      rules: (cur.rules && cur.rules.length ? cur.rules : [baseRule()]).map((r) => {
        if (r.id !== ruleId) return r;
        const set = new Set(r.disabledSlots);
        for (const t of times) {
          if (enable) set.delete(t);
          else set.add(t);
        }
        return { ...r, disabledSlots: [...set] };
      }),
    }));
  }

  // ─────────── недоступные дни (F-02-042/043) ───────────

  async unavailable(businessId: string, kind: Kind, id: string): Promise<UnavailableRange[]> {
    await this.assertScope(this.prisma, businessId, kind, id);
    return (await this.row(this.prisma, kind, id))?.unavailable ?? [];
  }

  async addUnavailable(ctx: RequestContext, businessId: string, kind: Kind, id: string, range: { from: string; to: string; note?: string }) {
    if (range.to < range.from) throw new ApiError('invalid_range', 'Range end before start');
    const created: UnavailableRange = { ...range, id: newId('unavailableRange') };
    await this.edit(ctx, businessId, kind, id, 'closed_days', (cur) => ({ unavailable: [...cur.unavailable, created] }), { dates: [range.from, range.to] });
    return created;
  }

  async removeUnavailable(ctx: RequestContext, businessId: string, kind: Kind, id: string, rangeId: string) {
    await this.edit(ctx, businessId, kind, id, 'closed_days', (cur) => ({ unavailable: cur.unavailable.filter((r) => r.id !== rangeId) }));
  }

  // ─────────── запас между клиентами (F-02-059) ───────────

  async buffer(businessId: string, kind: Kind, id: string): Promise<number> {
    await this.assertScope(this.prisma, businessId, kind, id);
    return (await this.row(this.prisma, kind, id))?.bufferMin ?? 0;
  }

  async setBuffer(ctx: RequestContext, businessId: string, kind: Kind, id: string, minutes: number) {
    const cur = await this.row(this.prisma, kind, id);
    await this.edit(ctx, businessId, kind, id, 'buffer', () => ({ bufferMin: minutes }), { before: String(cur?.bufferMin ?? 0), after: String(minutes) });
  }

  // ─────────── «Услуга доступна ограниченное время» (F-02-067) ───────────

  async serviceWindow(businessId: string, serviceId: string): Promise<ServiceSlotWindow | null> {
    const svc = await this.prisma.service.findFirst({ where: { id: serviceId, businessId }, select: { onlineWindow: true } });
    if (!svc) throw new ApiError('not_found', 'Service not found');
    return svc.onlineWindow ? ({ ...(svc.onlineWindow as object), serviceId } as ServiceSlotWindow) : null;
  }

  async setServiceWindow(businessId: string, serviceId: string, window: Omit<ServiceSlotWindow, 'serviceId'> | null) {
    const res = await this.prisma.service.updateMany({
      where: { id: serviceId, businessId },
      data: { onlineWindow: window ? (window as unknown as Prisma.InputJsonValue) : Prisma.DbNull, version: { increment: 1 } },
    });
    if (!res.count) throw new ApiError('not_found', 'Service not found');
    await this.availability.invalidate({ businessIds: [businessId] });
  }

  // ─────────── F-02-094: свободные и занятые слоты по мастерам ───────────

  async utilization(businessId: string, staffIds: string[], from: string, to: string, locationId?: string) {
    const settings = await this.availability.settings(this.prisma, businessId);
    const rules = await this.availability.ruleSets(this.prisma, businessId);
    const staff = await this.availability.staffRows(this.prisma, { businessId, id: { in: staffIds } });
    const out: { staffId: string; freeCount: number; busyCount: number }[] = [];
    for (const s of staff) {
      let freeCount = 0;
      let busyCount = 0;
      for (let d = from, i = 0; d <= to && i < 93; d = addDays(d, 1), i++) {
        freeCount += (await this.availability.computeFree(this.prisma, businessId, { staffId: s.id, date: d, durationMin: 30, locationId }, { settings, rules })).length;
        busyCount += (await this.availability.busyMinutes(this.prisma, personKeyOf(s), d)).length;
      }
      out.push({ staffId: s.id, freeCount, busyCount });
    }
    return out;
  }

  // ─────────── зеркало для разделов, ещё живущих на моке (PLAN §7, переходный слой до этапа 21) ───────────

  async mirror(businessId: string) {
    const today = nowLocal().slice(0, 10);
    const from = addDays(today, -60);
    const to = addDays(today, 800);
    const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true } });
    const ids = staff.map((s) => s.id);
    const [schedules, marks, types, ruleRows, settings, services] = await Promise.all([
      this.availability.schedules(this.prisma, ids, from, to),
      this.availability.marks(this.prisma, ids, from, to),
      this.prisma.staffDayType.findMany({ where: { businessId, date: { gte: from, lte: to } } }),
      this.prisma.onlineSlotRuleSet.findMany({ where: { businessId } }),
      this.availability.settings(this.prisma, businessId),
      this.prisma.service.findMany({ where: { businessId, NOT: { onlineWindow: { equals: Prisma.DbNull } } }, select: { id: true, onlineWindow: true } }),
    ]);
    const key = (r: { scope: string; scopeId: string }) => `${r.scope}:${r.scopeId}`;
    return {
      staffIds: ids,
      schedules: schedules.map((s) => ({
        id: s.id,
        staffId: s.staffId,
        locationId: s.locationId,
        workplace: s.workplace,
        week: s.week,
        overrides: s.overrides,
        ...(s.openUntil ? { openUntil: s.openUntil } : {}),
      })),
      calendarMarks: marks.map((m) => ({
        id: m.id,
        staffId: m.staffId,
        date: m.date,
        from: m.from,
        to: m.to,
        kind: m.kind,
        ...(m.workplace ? { workplace: m.workplace } : {}),
        ...(m.note ? { note: m.note } : {}),
      })),
      days: types.map((t) => ({ staffId: t.staffId, date: t.date, typeId: t.typeId, ...(t.vacationUntil ? { vacationUntil: t.vacationUntil } : {}) })),
      slotRules: Object.fromEntries(ruleRows.filter((r) => r.rules).map((r) => [key(r), r.rules as unknown as SlotRule[]])),
      slotMode: Object.fromEntries(ruleRows.filter((r) => r.scope === 'staff' && r.ownRules).map((r) => [r.scopeId, 'own'])),
      unavailableDays: Object.fromEntries(ruleRows.filter((r) => r.unavailable).map((r) => [key(r), r.unavailable as unknown as UnavailableRange[]])),
      bufferMin: Object.fromEntries(ruleRows.filter((r) => r.bufferMin !== null).map((r) => [key(r), r.bufferMin as number])),
      serviceSlotWindows: Object.fromEntries(services.map((s) => [s.id, { ...(s.onlineWindow as object), serviceId: s.id }])),
      settings,
    };
  }
}
