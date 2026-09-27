import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService, maskPhonesInDiff } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { auditOut, exportLogBody, exportOut, loginRowOut } from './staff.schemas.js';

type Diff = Record<string, [unknown, unknown]>;

/** diff { поле: [было, стало] } → before/after как в журнале фронта (StaffAuditEntry) */
function split(diff: Diff | null, entity: string): { before?: unknown; after?: unknown } {
  if (!diff) return {};
  // История прав (F-10-070) показывает сами наборы тонких прав
  if (entity === 'staffRights' && diff.rights) return { before: diff.rights[0] ?? undefined, after: diff.rights[1] ?? undefined };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, [a, b]] of Object.entries(diff)) {
    before[k] = a;
    after[k] = b;
  }
  return { before, after };
}

/** Журнал изменений, выгрузок и входов бизнеса (F-00-040, F-10-100…106) */
@ApiTags('staff')
@Controller('v1/biz/:businessId')
export class JournalsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('audit')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Журнал изменений (F-10-100): фильтры по сущности, объекту, действию, сотруднику. Телефоны — по праву clients.phones' })
  @ApiQuery({ name: 'entity', required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'actorStaffId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ZodOk(z.array(auditOut))
  async list(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Query('entity') entity?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('actorStaffId') actorStaffId?: string,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        businessId,
        action: { not: 'export' },
        ...(entity ? { entityType: entity } : {}),
        ...(entityId ? { entityId } : {}),
        ...(action ? { action } : {}),
        ...(actorStaffId ? { actorId: actorStaffId } : {}),
      },
      orderBy: { at: 'desc' },
      take: Math.min(Math.max(Number(limit) || 200, 1), 1000),
    });
    const phones = ctx.member!.permissions.has('clients.phones');
    return rows.map((r) => {
      const diff = phones ? (r.diff as Diff | null) : maskPhonesInDiff(r.diff as Diff | null);
      return {
        id: r.id,
        businessId,
        entity: r.entityType,
        entityId: r.entityId,
        action: r.action,
        actorStaffId: r.actorType === 'staff' && r.actorId ? r.actorId : undefined,
        actorLabel: r.actorName,
        ...split(diff, r.entityType),
        at: utcToLocal(r.at),
      };
    });
  }

  @Get('staff/:staffId/permissions/history')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'История прав сотрудника (F-10-070)' })
  @ZodOk(z.array(auditOut))
  history(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.list(ctx, businessId, 'staffRights', staffId);
  }

  @Post('exports-log')
  @HttpCode(204)
  @Biz()
  @ApiOperation({ summary: 'Отметить выгрузку/загрузку файла (пишут разделы с кнопкой «Выгрузить», F-10-102)' })
  @ZodBody(exportLogBody)
  async logExport(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(exportLogBody)) body: z.infer<typeof exportLogBody>) {
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, ctx, { action: 'export', entityType: body.reportType, entityId: businessId, businessId, after: body }),
    );
  }

  @Get('exports-log')
  @Biz('clients.export')
  @ApiOperation({ summary: 'Журнал «Операции с данными» (F-10-102/103)' })
  @ZodOk(z.array(exportOut))
  async exports(@Param('businessId') businessId: string) {
    const rows = await this.prisma.auditEvent.findMany({ where: { businessId, action: 'export' }, orderBy: { at: 'desc' }, take: 500 });
    return rows.map((r) => {
      const d = (r.diff ?? {}) as Diff;
      return {
        id: r.id,
        businessId,
        actorStaffId: r.actorType === 'staff' && r.actorId ? r.actorId : undefined,
        actorLabel: r.actorName,
        reportType: String(d.reportType?.[1] ?? r.entityType),
        isImport: Boolean(d.isImport?.[1]),
        operationType: String(d.operationType?.[1] ?? 'browserDownload'),
        at: utcToLocal(r.at),
      };
    });
  }

  @Get('logins')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Журнал входов сотрудников бизнеса (F-10-106)' })
  @ZodOk(z.array(loginRowOut))
  async logins(@Param('businessId') businessId: string) {
    const staff = await this.prisma.staff.findMany({ where: { businessId, userId: { not: null } }, select: { id: true, userId: true, name: true } });
    const byUser = new Map(staff.map((s) => [s.userId!, s]));
    if (!byUser.size) return [];
    const events = await this.prisma.loginEvent.findMany({
      where: { userId: { in: [...byUser.keys()] }, app: 'business', result: 'ok' },
      orderBy: { at: 'asc' },
      take: 1000,
    });
    const seen = new Set<string>();
    const rows = events.map((e) => {
      const s = byUser.get(e.userId!)!;
      const key = `${e.userId}|${e.device}`;
      const newDevice = !seen.has(key);
      seen.add(key);
      return { id: e.id, businessId, staffId: s.id, staffLabel: s.name, at: utcToLocal(e.at), device: e.device, ip: e.ip, newDevice };
    });
    return rows.reverse();
  }
}
