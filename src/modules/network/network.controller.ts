import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { networkOut } from '../businesses/business.schemas.js';
import { networkView } from '../businesses/views.js';

const createBody = z.object({ name: z.string().max(160), businessIds: z.array(z.string().max(32)).min(1).max(50), mainBusinessId: z.string().max(32).optional() });
const patchBody = z.object({ name: z.string().max(160).optional(), mainBusinessId: z.string().max(32).optional() });
const addBody = z.object({ businessId: z.string().max(32) });

/**
 * Сеть и её филиалы (docs/backend/02 §15, F-11-001…023; этап 3 — устройство сети, остальное — этап 15).
 * Сеть создаёт владелец из СВОИХ бизнесов; владелец сети получает в каждом филиале роль network (все права).
 */
@Injectable()
export class NetworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Бизнес, в котором вошедший — владелец (строка staff role=owner) */
  private async ownerRow(userId: string, businessId: string) {
    return this.prisma.staff.findFirst({ where: { businessId, userId, role: 'owner', status: 'active', deletedAt: null } });
  }

  async own(ctx: RequestContext, networkId: string) {
    const n = await this.prisma.network.findUnique({ where: { id: networkId }, include: { businesses: { select: { id: true }, where: { leftAt: null }, orderBy: { createdAt: 'asc' } } } });
    if (!n || n.ownerUserId !== ctx.session!.userId) throw new ApiError('forbidden', 'Network is not accessible');
    return n;
  }

  async view(networkId: string) {
    const n = await this.prisma.network.findUniqueOrThrow({ where: { id: networkId }, include: { businesses: { select: { id: true }, where: { leftAt: null }, orderBy: { createdAt: 'asc' } } } });
    return { ...networkView(n, n.businesses.map((b) => b.id)), deleted: Boolean(n.deletedAt) };
  }

  async create(ctx: RequestContext, input: z.infer<typeof createBody>) {
    const userId = ctx.session!.userId;
    const name = input.name.trim();
    if (!name) throw new ApiError('validation', 'name required');
    const rows: { id: string }[] = [];
    for (const b of input.businessIds) {
      const row = await this.ownerRow(userId, b);
      if (!row) throw new ApiError('forbidden', 'Only own businesses join a network');
      const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: b } });
      if (biz.networkId) throw new ApiError('conflict', 'Business is already in a network');
      rows.push(row);
    }
    const id = newId('network');
    await this.prisma.$transaction(async (tx) => {
      await tx.network.create({
        data: { id, name, ownerUserId: userId, ownerStaffId: rows[0]!.id, mainBusinessId: input.mainBusinessId ?? input.businessIds[0], createdBy: userId, updatedBy: userId },
      });
      await tx.business.updateMany({ where: { id: { in: input.businessIds } }, data: { networkId: id } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'network', entityId: id, networkId: id, after: { name, businessIds: input.businessIds } });
    });
    return this.view(id);
  }

  async patch(ctx: RequestContext, networkId: string, input: z.infer<typeof patchBody>) {
    const n = await this.own(ctx, networkId);
    if (input.mainBusinessId && !n.businesses.some((b) => b.id === input.mainBusinessId)) throw new ApiError('validation', 'Main location must be in the network');
    if (input.name !== undefined && !input.name.trim()) throw new ApiError('validation', 'name required');
    await this.prisma.$transaction(async (tx) => {
      await tx.network.update({
        where: { id: networkId },
        data: { ...(input.name ? { name: input.name.trim() } : {}), ...(input.mainBusinessId ? { mainBusinessId: input.mainBusinessId } : {}), updatedBy: ctx.session!.userId, version: { increment: 1 } },
      });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'network', entityId: networkId, networkId, before: { name: n.name, mainBusinessId: n.mainBusinessId }, after: { name: input.name ?? n.name, mainBusinessId: input.mainBusinessId ?? n.mainBusinessId } });
    });
    return this.view(networkId);
  }

  async addBusiness(ctx: RequestContext, networkId: string, businessId: string) {
    const n = await this.own(ctx, networkId);
    if (n.businesses.some((b) => b.id === businessId)) return this.view(networkId);
    const biz = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!biz || !(await this.ownerRow(ctx.session!.userId, businessId))) throw new ApiError('forbidden', 'Only own businesses join a network');
    if (biz.networkId) throw new ApiError('conflict', 'Business is already in a network');
    await this.prisma.$transaction(async (tx) => {
      await tx.business.update({ where: { id: businessId }, data: { networkId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'locationAdded', entityType: 'network', entityId: networkId, networkId, businessId, after: { businessId } });
    });
    return this.view(networkId);
  }

  /** Выход филиала из сети (F-11-013): счета клиентов и история остаются в бизнесе */
  async removeBusiness(ctx: RequestContext, networkId: string, businessId: string) {
    const n = await this.own(ctx, networkId);
    if (!n.businesses.some((b) => b.id === businessId)) return this.view(networkId);
    const rest = n.businesses.filter((b) => b.id !== businessId).map((b) => b.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.business.update({ where: { id: businessId }, data: { networkId: null, version: { increment: 1 } } });
      if (n.mainBusinessId === businessId) await tx.network.update({ where: { id: networkId }, data: { mainBusinessId: rest[0] ?? null } });
      await this.audit.record(tx, ctx, { action: 'locationRemoved', entityType: 'network', entityId: networkId, networkId, businessId, before: { businessId } });
    });
    return this.view(networkId);
  }

  async setDeleted(ctx: RequestContext, networkId: string, deleted: boolean) {
    await this.own(ctx, networkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.network.update({ where: { id: networkId }, data: { deletedAt: deleted ? new Date() : null, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: deleted ? 'deleted' : 'restored', entityType: 'network', entityId: networkId, networkId });
    });
    return this.view(networkId);
  }
}

const netOut = networkOut.extend({ deleted: z.boolean() });

@ApiTags('network')
@Controller('v1/net')
@Authed()
export class NetworkController {
  constructor(private readonly net: NetworkService) {}

  @Post()
  @ApiOperation({ summary: 'Создать сеть из своих бизнесов (F-11-001, F-11-006)' })
  @ZodBody(createBody)
  @ZodOk(netOut)
  create(@Ctx() ctx: RequestContext, @Body(new Zod(createBody)) body: z.infer<typeof createBody>) {
    return this.net.create(ctx, body);
  }

  @Get(':networkId')
  @ZodOk(netOut)
  async get(@Ctx() ctx: RequestContext, @Param('networkId') id: string) {
    await this.net.own(ctx, id);
    return this.net.view(id);
  }

  @Patch(':networkId')
  @ApiOperation({ summary: 'Название, главная локация (F-11-017)' })
  @ZodBody(patchBody)
  @ZodOk(netOut)
  patch(@Ctx() ctx: RequestContext, @Param('networkId') id: string, @Body(new Zod(patchBody)) body: z.infer<typeof patchBody>) {
    return this.net.patch(ctx, id, body);
  }

  @Post(':networkId/businesses')
  @HttpCode(200)
  @ApiOperation({ summary: 'Добавить свой бизнес филиалом (F-11-014)' })
  @ZodBody(addBody)
  @ZodOk(netOut)
  add(@Ctx() ctx: RequestContext, @Param('networkId') id: string, @Body(new Zod(addBody)) body: z.infer<typeof addBody>) {
    return this.net.addBusiness(ctx, id, body.businessId);
  }

  @Delete(':networkId/businesses/:businessId')
  @ApiOperation({ summary: 'Выход филиала из сети (F-11-013)' })
  @ZodOk(netOut)
  remove(@Ctx() ctx: RequestContext, @Param('networkId') id: string, @Param('businessId') b: string) {
    return this.net.removeBusiness(ctx, id, b);
  }

  @Delete(':networkId')
  @ApiOperation({ summary: 'Удалить сеть (мягко, F-11-019)' })
  @ZodOk(netOut)
  del(@Ctx() ctx: RequestContext, @Param('networkId') id: string) {
    return this.net.setDeleted(ctx, id, true);
  }

  @Post(':networkId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Восстановить сеть (F-11-020)' })
  @ZodOk(netOut)
  restore(@Ctx() ctx: RequestContext, @Param('networkId') id: string) {
    return this.net.setDeleted(ctx, id, false);
  }
}
