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
import { hashPassword, isWeakPassword } from '../auth/passwords.js';
import { NetworkAccessService } from './network-access.service.js';
import { addNewUserBody, addWithPasswordBody, inviteExistingBody, invitePhoneBody, networkUserOut, setPermissionsBody, setPlanReportFreqBody, updateNetworkUserBody } from './network.schemas.js';

/** F-11-036 (мок NETWORK_USER_FREE_COUNT/NETWORK_USER_PRICE): первый — бесплатно (владелец сети не считается,
 * он не строка NetworkUser вовсе), дальше 2000 ֏ — наше решение, часть биллинга сети не списывает (этап 18). */
export const NETWORK_USER_FREE_COUNT = 1;
export const NETWORK_USER_PRICE = 2000;

function out(u: { id: string; networkId: string; name: string; phone: string | null; email: string | null; permissions: unknown; lastVisitAt: Date | null; planReportFrequency: string | null; pending?: boolean; version: number }) {
  return {
    id: u.id,
    networkId: u.networkId,
    name: u.name,
    phone: u.phone ?? '',
    email: u.email ?? undefined,
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    lastVisitAt: u.lastVisitAt?.toISOString(),
    isOwner: false,
    pending: u.pending ?? false,
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

  /** F-11-024: строка «Владелец» (мок держит её прямо в списке users) — не своя таблица, `Network.ownerStaffId`
   * (этап 21 «network+reports» попытка 2: экран `UsersScreen.tsx` кладёт owner в те же `rows`, что и приглашённых). */
  async list(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'users');
    const rows = await this.prisma.networkUser.findMany({ where: { networkId }, orderBy: { createdAt: 'asc' } });
    const owner = network.ownerStaffId ? await this.prisma.staff.findFirst({ where: { id: network.ownerStaffId }, select: { name: true, phone: true, email: true } }) : null;
    const ownerRow = owner
      ? [{ id: `owner_${network.id}`, networkId, name: owner.name, phone: owner.phone ?? '', email: owner.email ?? undefined, permissions: [] as string[], lastVisitAt: undefined as string | undefined, isOwner: true as const, pending: false, planReportFrequency: undefined as string | undefined, version: 1 }]
      : [];
    return [...ownerRow, ...rows.map(out)];
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

  // ─────────── Этап 21 «network+reports», попытка 2: мок src/api/network.ts ───────────

  /** F-11-027/036: видно до добавления пользователя — считает по уже сохранённым строкам, деньги не списывает */
  async pricing(ctx: RequestContext, networkId: string) {
    const { network } = await this.access.require(ctx, networkId, 'users');
    const count = await this.prisma.networkUser.count({ where: { networkId, pending: false } });
    const now = new Date();
    const subs = network.businessIds.length ? await this.prisma.subscription.findMany({ where: { businessId: { in: network.businessIds } }, select: { status: true, paidUntil: true } }) : [];
    const hasPaidLocation = subs.some((s) => s.status === 'active' && s.paidUntil > now);
    return { freeCount: NETWORK_USER_FREE_COUNT, pricePerExtra: NETWORK_USER_PRICE, paidUsersCount: Math.max(0, count - NETWORK_USER_FREE_COUNT), hasPaidLocation };
  }

  private async assertPaidLocation(networkId: string, network: { businessIds: string[] }): Promise<void> {
    const now = new Date();
    const subs = network.businessIds.length ? await this.prisma.subscription.findMany({ where: { businessId: { in: network.businessIds } }, select: { status: true, paidUntil: true } }) : [];
    if (!subs.some((s) => s.status === 'active' && s.paidUntil > now)) throw new ApiError('validation', 'no_paid_location');
  }

  /** F-11-025 (мок `inviteNetworkUser`): единый вызов — уже зарегистрированный по телефону входит сразу,
   * незнакомый телефон заводит «ожидающую» строку (саморегистрация свяжет её позже — вне этого захода). */
  async invitePhone(ctx: RequestContext, networkId: string, phone: string) {
    const { network } = await this.access.require(ctx, networkId, 'users');
    await this.assertPaidLocation(networkId, network);
    const trimmed = phone.trim();
    const already = await this.prisma.networkUser.findFirst({ where: { networkId, phone: trimmed } });
    if (already) throw new ApiError('conflict', 'Already a network user');
    const user = await this.prisma.user.findUnique({ where: { phone: trimmed } });
    const id = newId('networkUser');
    await this.prisma.$transaction(async (tx) => {
      await tx.networkUser.create({
        data: { id, networkId, userId: user?.id, name: user?.name ?? trimmed, phone: trimmed, permissions: [], pending: !user, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'networkUser', entityId: id, networkId, after: { phone: trimmed, pending: !user } });
    });
    return out(await this.prisma.networkUser.findUniqueOrThrow({ where: { id } }));
  }

  /** F-11-026 (мок `createNetworkUser`): вход логином+паролем — та же модель, что StaffLogin администратора
   * (businessId=null/staffId=null, common/passwords.ts), User без телефона — контактный phone/email лежит на
   * самой строке NetworkUser, а не на User (тот же приём, что StaffService.setLogin для админа без телефона). */
  async addWithPassword(ctx: RequestContext, networkId: string, input: { name: string; phone?: string; login: string; password: string }) {
    const { network } = await this.access.require(ctx, networkId, 'users');
    await this.assertPaidLocation(networkId, network);
    const name = input.name.trim();
    const login = input.login.trim().toLowerCase();
    if (isWeakPassword(input.password, login)) throw new ApiError('weak_password', 'Password is too weak');
    const taken = await this.prisma.staffLogin.findUnique({ where: { login } });
    if (taken) throw new ApiError('login_taken', 'Login is taken');
    const passwordHash = await hashPassword(input.password);
    const userId = newId('user');
    const loginId = newId('staffLogin');
    const id = newId('networkUser');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: userId, phone: null, name, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
      await tx.staffLogin.create({ data: { id: loginId, login, passwordHash, userId, staffId: null, businessId: null, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId } });
      await tx.networkUser.create({
        data: { id, networkId, userId, name, phone: input.phone, permissions: [], staffLoginId: loginId, createdBy: ctx.session!.userId, updatedBy: ctx.session!.userId },
      });
      await this.audit.record(tx, ctx, { action: 'create', entityType: 'networkUser', entityId: id, networkId, after: { login } });
    });
    return out(await this.prisma.networkUser.findUniqueOrThrow({ where: { id } }));
  }

  /** мок `updateNetworkUser` — карточка (имя/телефон/почта), права и пароль отдельными вызовами */
  async update(ctx: RequestContext, networkId: string, id: string, patch: { name: string; phone?: string; email?: string }) {
    await this.access.require(ctx, networkId, 'users');
    const before = await this.prisma.networkUser.findFirst({ where: { id, networkId } });
    if (!before) throw new ApiError('not_found', 'Network user not found');
    const name = patch.name.trim();
    if (!name) throw new ApiError('validation', 'name required');
    await this.prisma.$transaction(async (tx) => {
      await tx.networkUser.update({ where: { id }, data: { name, phone: patch.phone?.trim() || null, email: patch.email?.trim() || null, updatedBy: ctx.session!.userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'networkUser', entityId: id, networkId, before: { name: before.name }, after: { name } });
    });
    return out(await this.prisma.networkUser.findUniqueOrThrow({ where: { id } }));
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

  // ─────────── Этап 21 «network+reports», попытка 2: мок src/api/network.ts ───────────

  @Get('pricing')
  @ApiOperation({ summary: 'F-11-027/036: правило оплаты, видно до добавления пользователя' })
  pricing(@Ctx() ctx: RequestContext, @Param('networkId') n: string) {
    return this.svc.pricing(ctx, n);
  }

  @Post('invite-by-phone')
  @ApiOperation({ summary: 'F-11-025 (мок inviteNetworkUser): существующий по телефону — сразу, иначе — pending' })
  @ZodBody(invitePhoneBody)
  @ZodOk(networkUserOut)
  invitePhone(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(invitePhoneBody)) body: z.infer<typeof invitePhoneBody>) {
    return this.svc.invitePhone(ctx, n, body.phone);
  }

  @Post('password')
  @ApiOperation({ summary: 'F-11-026 (мок createNetworkUser): вход логином+паролем, телефон необязателен' })
  @ZodBody(addWithPasswordBody)
  @ZodOk(networkUserOut)
  addWithPassword(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Body(new Zod(addWithPasswordBody)) body: z.infer<typeof addWithPasswordBody>) {
    return this.svc.addWithPassword(ctx, n, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'мок updateNetworkUser — карточка (имя/телефон/почта)' })
  @ZodBody(updateNetworkUserBody)
  @ZodOk(networkUserOut)
  update(@Ctx() ctx: RequestContext, @Param('networkId') n: string, @Param('id') id: string, @Body(new Zod(updateNetworkUserBody)) body: z.infer<typeof updateNetworkUserBody>) {
    return this.svc.update(ctx, n, id, body);
  }
}
