import { randomBytes } from 'node:crypto';
import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '../../generated/prisma/client.js';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { ApiError } from '../../common/errors/api-error.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { nowLocal, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { NetworkAccessService } from './network-access.service.js';

// ─────────── схемы ───────────

const planEmailSchedule = z.enum(['none', 'daily', 'weekly', 'monthly']);
const planEmailBody = z.object({ schedule: planEmailSchedule });
const routeBody = z.object({
  name: z.string().trim().min(1).max(120),
  userIds: z.array(z.string().max(32)).max(500),
  businessIds: z.array(z.string().max(32)).min(1).max(500),
  historyStorage: z.enum(['network', 'networkAndNotified', 'locationOnly']),
});
const ruleBody = z.object({ kind: z.enum(['phone', 'sip']), identifier: z.string().trim().regex(/^\d+$/).max(32), routeId: z.string().min(1).max(32) });

const exportBody = z.object({ scope: z.enum(['found', 'all']), count: z.number().int().min(0).max(1_000_000), authorName: z.string().max(160), kind: z.enum(['clients', 'records', 'staff']).optional() });
interface ExportEntry {
  id: string;
  networkId: string;
  at: string;
  authorName: string;
  kind: 'clients' | 'records' | 'staff';
  count: number;
  expiresAt: string;
}
interface TelRoute {
  id: string;
  networkId: string;
  name: string;
  isDefault: boolean;
  userIds: string[];
  businessIds: string[];
  historyStorage: 'network' | 'networkAndNotified' | 'locationOnly';
  createdAt: string;
}
interface TelRule {
  id: string;
  networkId: string;
  kind: 'phone' | 'sip';
  identifier: string;
  routeId: string;
}
interface Telephony {
  token: string;
  connected: boolean;
  routes: TelRoute[];
  rules: TelRule[];
}

/**
 * Настройки сети одной строкой на область (`NetworkSetting`, этап 21 «сдача», попытка 4):
 * - `planEmailSchedule` — расписание письма «Выполнение плана» (F-12-081);
 * - `telephony` — телефония сети (F-11-146…152). Р19: чужой сервис — сервер хранит «подключено», токен, маршруты
 *   и правила; настоящего обмена звонками нет, поэтому истории звонков тоже нет (пустой список, а не выдумка).
 */
@Injectable()
export class NetworkSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NetworkAccessService,
  ) {}

  private async read<T>(networkId: string, area: string): Promise<T | undefined> {
    const row = await this.prisma.networkSetting.findUnique({ where: { networkId_area: { networkId, area } } });
    return row ? (row.data as unknown as T) : undefined;
  }

  private async write(networkId: string, area: string, data: unknown, by?: string): Promise<void> {
    const json = data as Prisma.InputJsonValue;
    await this.prisma.networkSetting.upsert({
      where: { networkId_area: { networkId, area } },
      create: { networkId, area, data: json, updatedBy: by },
      update: { data: json, updatedBy: by },
    });
  }

  async getPlanEmail(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'analytics');
    return (await this.read<{ schedule: string }>(networkId, 'planEmailSchedule'))?.schedule ?? 'none';
  }

  async setPlanEmail(ctx: RequestContext, networkId: string, schedule: z.infer<typeof planEmailSchedule>) {
    await this.access.require(ctx, networkId, 'analytics');
    await this.write(networkId, 'planEmailSchedule', { schedule }, ctx.session?.userId);
    return schedule;
  }

  /** Состояние телефонии; первый заход — токен и маршрут «По умолчанию» (все филиалы, как мок) */
  private async telephony(ctx: RequestContext, networkId: string): Promise<Telephony> {
    const { network } = await this.access.require(ctx, networkId, 'telephony');
    const saved = await this.read<Telephony>(networkId, 'telephony');
    if (saved) return saved;
    const fresh: Telephony = {
      token: `NET-${randomBytes(12).toString('hex').toUpperCase()}`,
      connected: false,
      routes: [
        {
          id: newId('networkTelRoute'),
          networkId,
          name: 'По умолчанию',
          isDefault: true,
          userIds: [],
          businessIds: [...network.businessIds],
          historyStorage: 'network',
          createdAt: nowLocal(),
        },
      ],
      rules: [],
    };
    await this.write(networkId, 'telephony', fresh, ctx.session?.userId);
    return fresh;
  }

  async status(ctx: RequestContext, networkId: string) {
    const t = await this.telephony(ctx, networkId);
    return { networkId, token: t.token, connected: t.connected };
  }

  async connect(ctx: RequestContext, networkId: string) {
    const t = await this.telephony(ctx, networkId);
    await this.write(networkId, 'telephony', { ...t, connected: true }, ctx.session?.userId);
    return { ok: true };
  }

  async routes(ctx: RequestContext, networkId: string) {
    return (await this.telephony(ctx, networkId)).routes;
  }

  async saveRoute(ctx: RequestContext, networkId: string, input: z.infer<typeof routeBody>, id?: string) {
    const t = await this.telephony(ctx, networkId);
    let saved: TelRoute;
    if (id) {
      const existing = t.routes.find((r) => r.id === id);
      if (!existing) throw new ApiError('not_found', 'Route not found');
      saved = { ...existing, name: input.name, userIds: input.userIds, businessIds: input.businessIds, historyStorage: input.historyStorage };
      t.routes = t.routes.map((r) => (r.id === id ? saved : r));
    } else {
      saved = { id: newId('networkTelRoute'), networkId, name: input.name, isDefault: false, userIds: input.userIds, businessIds: input.businessIds, historyStorage: input.historyStorage, createdAt: nowLocal() };
      t.routes = [...t.routes, saved];
    }
    await this.write(networkId, 'telephony', t, ctx.session?.userId);
    return saved;
  }

  async rules(ctx: RequestContext, networkId: string) {
    return (await this.telephony(ctx, networkId)).rules;
  }

  async addRule(ctx: RequestContext, networkId: string, input: z.infer<typeof ruleBody>) {
    const t = await this.telephony(ctx, networkId);
    if (t.rules.some((r) => r.identifier === input.identifier)) throw new ApiError('validation', 'identifier_taken');
    if (!t.routes.some((r) => r.id === input.routeId)) throw new ApiError('validation', 'route_required');
    const created: TelRule = { id: newId('networkTelRule'), networkId, kind: input.kind, identifier: input.identifier, routeId: input.routeId };
    t.rules = [...t.rules, created];
    await this.write(networkId, 'telephony', t, ctx.session?.userId);
    return created;
  }

  async deleteRule(ctx: RequestContext, networkId: string, id: string) {
    const t = await this.telephony(ctx, networkId);
    t.rules = t.rules.filter((r) => r.id !== id);
    await this.write(networkId, 'telephony', t, ctx.session?.userId);
    return { ok: true };
  }

  /** F-11-011: своей кнопки удаления локации нет — заявка команде платформы; храним факт и время запроса */
  async requestDeletion(ctx: RequestContext, networkId: string, businessId: string) {
    const { network } = await this.access.require(ctx, networkId);
    if (!network.businessIds.includes(businessId)) throw new ApiError('not_found', 'Location is not in the network');
    const all = (await this.read<Record<string, string>>(networkId, 'locationDeletions')) ?? {};
    all[businessId] = nowLocal();
    await this.write(networkId, 'locationDeletions', all, ctx.session?.userId);
    return { businessId, at: all[businessId] };
  }

  async deletionRequests(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId);
    return (await this.read<Record<string, string>>(networkId, 'locationDeletions')) ?? {};
  }

  /**
   * F-11-044/076: выгрузка сети — ссылка на месяц «письмом» (почта — заглушка, Р14) + строка журнала выгрузок.
   * «Вся база» клиентов считается здесь (один телефон = один человек), «найденные» — сколько прислал экран.
   */
  async exportLog(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'clients');
    return (await this.read<ExportEntry[]>(networkId, 'exportLog')) ?? [];
  }

  async addExport(ctx: RequestContext, networkId: string, input: z.infer<typeof exportBody>) {
    const { network } = await this.access.require(ctx, networkId, 'clients');
    const kind = input.kind ?? 'clients';
    let count = input.count;
    if (input.scope === 'all' && kind === 'clients') {
      const phones = await this.prisma.client.findMany({ where: { businessId: { in: network.businessIds }, deletedAt: null }, select: { phone: true }, distinct: ['phone'] });
      count = phones.length;
    }
    const at = nowLocal();
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const entry: ExportEntry = { id: newId('networkExport'), networkId, at, authorName: input.authorName, kind, count, expiresAt: `${utcToLocalDate(expires)}T00:00` };
    const log = (await this.read<ExportEntry[]>(networkId, 'exportLog')) ?? [];
    await this.write(networkId, 'exportLog', [entry, ...log].slice(0, 100), ctx.session?.userId);
    return entry;
  }

  /** Р19: звонки идут через чужую АТС, обмена нет — сервер звонков не знает */
  async calls(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'telephony');
    return [] as unknown[];
  }

  /**
   * F-11-023 (этап 21, лейн network): журнал «Изменения данных» сети — переиспользует `audit_events` (этап 1,
   * `AuditService.record`, уже пишет `entityType:'network'`/`networkId` из `NetworkService`/структурных правок
   * сети), а не заводит вторую копию, как держал мок (`pushAudit` в браузере, до 200 строк). Мок знает только 4
   * действия (`created`/`renamed`/`deleted`/`restored`) — остальные события сети (добавление/вывод филиала и т.п.)
   * есть в `audit_events`, но вне контракта экрана; отфильтрованы, а не подогнаны под чужой тип.
   */
  async auditLog(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'settings');
    const rows = await this.prisma.auditEvent.findMany({
      where: { networkId, entityType: 'network', action: { in: ['create', 'update', 'deleted', 'restored'] } },
      orderBy: { at: 'desc' },
      take: 200,
    });
    const ACTION_MAP: Record<string, 'created' | 'renamed' | 'deleted' | 'restored'> = { create: 'created', update: 'renamed', deleted: 'deleted', restored: 'restored' };
    return rows.map((r) => {
      const diff = r.diff as Record<string, [unknown, unknown]> | null;
      const detail = diff?.name?.[1] != null ? String(diff.name[1]) : undefined;
      return { id: r.id, networkId, action: ACTION_MAP[r.action]!, authorName: r.actorName, at: utcToLocal(r.at), detail };
    });
  }
}

@ApiTags('network')
@Controller('v1/net/:networkId')
@Authed()
export class NetworkSettingsController {
  constructor(private readonly svc: NetworkSettingsService) {}

  @Get('plan-email-schedule')
  @ApiOperation({ summary: 'Расписание письма «Выполнение плана» (F-12-081)' })
  getPlanEmail(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.getPlanEmail(ctx, n).then((schedule) => ({ schedule }));
  }

  @Put('plan-email-schedule')
  @ZodBody(planEmailBody)
  setPlanEmail(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(planEmailBody)) body: z.infer<typeof planEmailBody>) {
    return this.svc.setPlanEmail(ctx, n, body.schedule).then((schedule) => ({ schedule }));
  }

  @Get('telephony')
  @ApiOperation({ summary: 'Телефония сети: токен и «подключено» (F-11-146, Р19)' })
  telephony(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.status(ctx, n);
  }

  @Post('telephony/connect')
  connect(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.connect(ctx, n);
  }

  @Get('telephony/routes')
  routes(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.routes(ctx, n);
  }

  @Post('telephony/routes')
  @ZodBody(routeBody)
  createRoute(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(routeBody)) body: z.infer<typeof routeBody>) {
    return this.svc.saveRoute(ctx, n, body);
  }

  @Patch('telephony/routes/:id')
  @ZodBody(routeBody)
  updateRoute(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(routeBody)) body: z.infer<typeof routeBody>) {
    return this.svc.saveRoute(ctx, n, body, id);
  }

  @Get('telephony/rules')
  rules(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.rules(ctx, n);
  }

  @Post('telephony/rules')
  @ZodBody(ruleBody)
  addRule(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(ruleBody)) body: z.infer<typeof ruleBody>) {
    return this.svc.addRule(ctx, n, body);
  }

  @Delete('telephony/rules/:id')
  deleteRule(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    return this.svc.deleteRule(ctx, n, id);
  }

  @Get('location-deletions')
  @ApiOperation({ summary: 'Заявки на удаление локаций сети: businessId → когда (F-11-011)' })
  deletionRequests(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.deletionRequests(ctx, n);
  }

  @Post('location-deletions/:businessId')
  requestDeletion(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('businessId') b: string) {
    return this.svc.requestDeletion(ctx, n, b);
  }

  @Get('exports')
  @ApiOperation({ summary: 'Журнал выгрузок сети (F-11-044/076)' })
  exports(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.exportLog(ctx, n);
  }

  @Post('exports')
  @ZodBody(exportBody)
  addExport(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(exportBody)) body: z.infer<typeof exportBody>) {
    return this.svc.addExport(ctx, n, body);
  }

  @Get('telephony/calls')
  @ApiOperation({ summary: 'История звонков сети — пусто: чужая АТС, обмена нет (Р19)' })
  calls(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.calls(ctx, n);
  }

  @Get('audit-log')
  @ApiOperation({ summary: 'Журнал «Изменения данных» сети (F-11-023)' })
  auditLog(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.auditLog(ctx, n);
  }
}
