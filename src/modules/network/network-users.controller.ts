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
import { NetworkAccessService } from './network-access.service.js';
import { addNewUserBody, inviteExistingBody, networkUserOut, setPermissionsBody, setPlanReportFreqBody } from './network.schemas.js';

function out(u: { id: string; networkId: string; name: string; phone: string | null; email: string | null; permissions: unknown; lastVisitAt: Date | null; planReportFrequency: string | null; version: number }) {
  return {
    id: u.id,
    networkId: u.networkId,
    name: u.name,
    phone: u.phone ?? '',
    email: u.email ?? undefined,
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    lastVisitAt: u.lastVisitAt?.toISOString(),
    planReportFrequency: (u.planReportFrequency ?? undefined) as 'off' | 'daily' | 'weekly' | 'monthly' | undefined,
    version: u.version,
  };
}

/**
 * Пользователи сети (F-11-024…036, docs/backend/02 §15): доступ к сетевым разделам без своей строки staff.
 * Владелец сети (Network.ownerUserId) — отдельная строка «Владелец» рисуется на фронте, здесь не хранится
 * (isOwner ставит фронт по networkId, F-11-024). Оплата «первый бесплатно, дальше по 2000 ֏» (NETWORK_USER_PRICE
 * фронта) — часть подписки/биллинга (этап 18, PLAN §6 №18), здесь не списывается (Р14/Р17 — стоимость решает 08).
 */
@Injectable()
export class NetworkUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NetworkAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: RequestContext, networkId: string) {
    await this.access.require(ctx, networkId, 'users');
    const rows = await this.prisma.networkUser.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
    return rows.map(out);
  }

  /** F-11-025: пригласить существующего пользователя (у него уже есть аккаунт по номеру) */
  async inviteExisting(ctx: RequestContext, networkId: string, input: z.infer<typeof inviteExistingBody>) {
    await this.access.require(ctx, networkId, 'users');
    const user = await this.prisma.user.findUnique({ where: { phone: input.phone } });
    if (!user || user.deletedAt) throw new ApiError('not_found', 'No account with this phone yet — use "add new"');
    const existing = await this.prisma.networkUser.findUnique({ where: { networkId_userId: { networkId, userId: user.id } } });
    if (existing) throw new ApiError('conflict', 'Already a network user');
    const id = newId('networkUser');
    await this.prisma.$transaction(async (tx) => {
      await tx.networkUser.create({ data: { id, networkId, userId: user.id, name: user.name, phone: user.phone ?? input.phone, permissions: input.permissions, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'networkUser', entityId: id, networkId, after: { phone: input.phone, permissions: input.permissions } });
    });
    return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
  }

  /** F-11-026: добавить нового пользователя — заводит аккаунт по номеру (входит потом обычным кодом, этап 2) */
  async addNew(ctx: RequestContext, networkId: string, input: z.infer<typeof addNewUserBody>) {
    await this.access.require(ctx, networkId, 'users');
    const id = newId('networkUser');
    await this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { phone: input.phone } });
      if (!user) user = await tx.user.create({ data: { id: newId('user'), phone: input.phone, name: input.name, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
      const existing = await tx.networkUser.findUnique({ where: { networkId_userId: { networkId, userId: user.id } } });
      if (existing) throw new ApiError('conflict', 'Already a network user');
      await tx.networkUser.create({ data: { id, networkId, userId: user.id, name: input.name, phone: input.phone, email: input.email, permissions: input.permissions, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'networkUser', entityId: id, networkId, after: { phone: input.phone, name: input.name } });
    });
    return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
  }

  async setPermissions(ctx: RequestContext, networkId: string, id: string, permissions: string[]) {
    await this.access.require(ctx, networkId, 'users');
    const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
    if (!before) throw new ApiError('not_found', 'Network user not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.networkUser.update({ where: { id }, data: { permissions, updatedBy: ctx.session!.userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkUser', entityId: id, networkId, before: { permissions: before.permissions }, after: { permissions } });
    });
    return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
  }

  async setPlanReportFrequency(ctx: RequestContext, networkId: string, id: string, frequency: string) {
    await this.access.require(ctx, networkId, 'users');
    const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
    if (!before) throw new ApiError('not_found', 'Network user not found');
    await this.prisma.networkUser.update({ where: { id }, data: { planReportFrequency: frequency, version: { increment: 1 } } });
    return out((await this.prisma.networkUser.findUniqueOrThrow({ where: { id } })));
  }

  async remove(ctx: RequestContext, networkId: string, id: string) {
    await this.access.require(ctx, networkId, 'users');
    const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
    if (!before) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.networkUser.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'deleted', entityType: 'networkUser', entityId: id, networkId, before: { phone: before.phone, name: before.name } });
    });
  }
}

@ApiTags('network')
@Controller('v1/net/:networkId/users')
@Authed()
export class NetworkUsersController {
  constructor(private readonly svc: NetworkUsersService) {}

  @Get()
  @ZodOk(z.array(networkUserOut))
  list(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.list(ctx, n);
  }

  @Post('invite')
  @ApiOperation({ summary: 'Пригласить существующего пользователя по телефону (F-11-025)' })
  @ZodBody(inviteExistingBody)
  @ZodOk(networkUserOut)
  invite(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(inviteExistingBody)) body: z.infer<typeof inviteExistingBody>) {
    return this.svc.inviteExisting(ctx, n, body);
  }

  @Post()
  @ApiOperation({ summary: 'Добавить нового пользователя сети (F-11-026)' })
  @ZodBody(addNewUserBody)
  @ZodOk(networkUserOut)
  add(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(addNewUserBody)) body: z.infer<typeof addNewUserBody>) {
    return this.svc.addNew(ctx, n, body);
  }

  @Patch(':id/permissions')
  @ZodBody(setPermissionsBody)
  @ZodOk(networkUserOut)
  setPermissions(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(setPermissionsBody)) body: z.infer<typeof setPermissionsBody>) {
    return this.svc.setPermissions(ctx, n, id, body.permissions);
  }

  @Patch(':id/plan-report-frequency')
  @ApiOperation({ summary: 'Как часто присылать письмо о выполнении плана (F-11-030)' })
  @ZodBody(setPlanReportFreqBody)
  @ZodOk(networkUserOut)
  setFreq(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(setPlanReportFreqBody)) body: z.infer<typeof setPlanReportFreqBody>) {
    return this.svc.setPlanReportFrequency(ctx, n, id, body.frequency);
  }

  @Delete(':id')
  @HttpCode(200)
  @ZodOk(z.object({ ok: z.literal(true) }))
  async remove(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string) {
    await this.svc.remove(ctx, n, id);
    return { ok: true as const };
  }
}
