import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { ApiError } from '../../../common/errors/api-error.js';
import { PrismaService } from '../../../common/prisma.service.js';
import { bookingView } from '../../journal/journal.views.js';
import { clientRowView } from '../../clients/clients.views.js';
import { BusinessService } from '../../businesses/business.service.js';
import { resolveScopeBusinessIds } from '../loyalty.owner.js';
import type { CoreData, Id } from './core-types.js';
import * as extra from './extra-ops.js';
import * as logic from './logic.js';
import { NeedBookings, runInPort } from './shim.js';
import { loadState, saveState, SETTINGS_AREA } from './store.js';

type Db = Prisma.TransactionClient;
type LogicFn = (...args: unknown[]) => unknown;

/** Операции, которым записи уже понадобились — их грузим сразу, без перезапуска (учится на ходу) */
const needsBookings = new Set<string>();

export interface RunOptions {
  /** Бизнес запроса (из пути) — подставляется первым аргументом вместо присланного */
  businessId?: Id;
  /** Бизнесы, чей срез и ядро читаются (сеть бизнеса; для клиента — все его бизнесы) */
  scope: Id[];
  /** Для клиентских операций: только его карточки клиентов */
  appUserId?: Id;
  actor: string;
}

/**
 * Выполняет функцию перенесённого фасада лояльности (port/logic.ts) над состоянием из базы: одна транзакция,
 * замок на строки настроек бизнесов среза (по порядку id — без взаимных блокировок), чтение среза и ядра,
 * вызов, запись разницы. Даже «чтения» фасада могут писать (ленивые сгорание бонусов, бонус на день
 * рождения, откат оплаты удалённой записи, конец заморозки) — поэтому каждый вызов идёт тем же путём.
 */
@Injectable()
export class LoyaltyPortRunner {
  private readonly log = new Logger('LoyaltyPort');

  constructor(
    private readonly prisma: PrismaService,
    private readonly biz: BusinessService,
  ) {}

  scopeOf(businessId: Id): Promise<Id[]> {
    return resolveScopeBusinessIds(this.prisma, businessId);
  }

  async run(op: string, args: unknown[], opts: RunOptions): Promise<unknown> {
    const fn = (extra as unknown as Record<string, LogicFn>)[op] ?? (logic as unknown as Record<string, LogicFn>)[op];
    if (typeof fn !== 'function') throw new ApiError('not_found', `loyalty op ${op}`);
    if (opts.scope.length === 0) return this.runEmpty(fn, args);
    const withBookings = needsBookings.has(op);
    try {
      return await this.runOnce(op, fn, args, opts, withBookings);
    } catch (e) {
      if (!(e instanceof NeedBookings) || withBookings) throw e;
      needsBookings.add(op);
      return this.runOnce(op, fn, args, opts, true);
    }
  }

  /** Клиент без карточек ни в одном бизнесе — пустое состояние, без базы */
  private async runEmpty(fn: LogicFn, args: unknown[]) {
    const { emptyState } = await import('./state.js');
    const core = emptyCore();
    return runInPort({ state: emptyState(), core }, async () => fn(...args));
  }

  private async runOnce(op: string, fn: LogicFn, args: unknown[], opts: RunOptions, withBookings: boolean): Promise<unknown> {
    const scope = [...new Set(opts.scope)].sort();
    const home = opts.businessId ?? scope[0]!;
    const core = await this.loadCore(home, scope, withBookings, opts.appUserId);
    return this.prisma.$transaction(
      async (db) => {
        await lockScope(db, scope);
        const { state, snapshot } = await loadState(db, scope);
        const ctx = { state, core };
        const result = await runInPort(ctx, async () => fn(...args));
        const serviceBiz = new Map(core.services.map((s) => [s.id, s.businessId]));
        const saved = await saveState(db, snapshot, ctx.state, home, (id) => serviceBiz.get(id), opts.actor);
        if (saved.written || saved.removed) this.log.debug(`${op}: written ${saved.written}, removed ${saved.removed}`);
        return result;
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  }

  private async loadCore(home: Id, scope: Id[], withBookings: boolean, appUserId?: Id): Promise<CoreData> {
    const snap = await this.biz.core(home, scope);
    const clientWhere = appUserId ? { appUserId, deletedAt: null } : { businessId: { in: scope }, deletedAt: null };
    const clientRows = await this.prisma.client.findMany({ where: clientWhere });
    const core = {
      ...emptyCore(),
      networks: snap.networks,
      businesses: snap.businesses,
      locations: snap.locations,
      staff: snap.staff,
      serviceCategories: snap.serviceCategories,
      services: snap.services,
      resources: snap.resources,
      clients: clientRows.map((c) => ({ ...clientRowView(c), birthday: c.birthday ?? undefined })),
    } as unknown as CoreData;
    if (withBookings) {
      const rows = await this.prisma.booking.findMany({ where: { businessId: { in: scope } } });
      core.bookings = rows.map((b) => bookingView(b)) as unknown as CoreData['bookings'];
    } else {
      Object.defineProperty(core, 'bookings', {
        get() {
          throw new NeedBookings();
        },
      });
    }
    return core;
  }
}

function emptyCore(): CoreData {
  return { networks: [], businesses: [], locations: [], staff: [], serviceCategories: [], services: [], resources: [], clients: [], appUsers: [], bookings: [], groupEvents: [], schedules: [], calendarMarks: [] };
}

/** Замок среза: строка business_settings(area='loyalty-port') каждого бизнеса, по порядку id */
async function lockScope(db: Db, scope: Id[]): Promise<void> {
  await db.businessSetting.createMany({ data: scope.map((businessId) => ({ businessId, area: SETTINGS_AREA, data: {} })), skipDuplicates: true });
  await db.$queryRawUnsafe(
    `SELECT business_id FROM business_settings WHERE area = ? AND business_id IN (${scope.map(() => '?').join(',')}) ORDER BY business_id FOR UPDATE`,
    SETTINGS_AREA,
    ...scope,
  );
}
