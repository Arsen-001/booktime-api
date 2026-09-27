import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { staffOut } from '../businesses/business.schemas.js';
import {
  accessBody,
  accessInfoBody,
  accessOut,
  addStaffBody,
  addStaffOut,
  deletedOut,
  dismissalOut,
  dismissBody,
  inviteOut,
  ipBody,
  jsonBody,
  loginBody,
  orderBody,
  patchStaffBody,
  positionBody,
  positionOut,
  positionRowOut,
  reissueOut,
  rightsBody,
  rightsOut,
  roleTemplateBody,
  scopesBody,
  staffRowOut,
  transferAccessBody,
  transferOwnerBody,
} from './staff.schemas.js';
import { StaffService } from './staff.service.js';

type B<T extends z.ZodType> = z.infer<T>;

/** Сотрудники, доступ, права, должности — /v1/biz/{b}/staff (docs/backend/02 §7) */
@ApiTags('staff')
@Controller('v1/biz/:businessId')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  // ─────────── список и добавление ───────────

  @Get('staff')
  @Biz('staff.view')
  @ApiOperation({ summary: 'Сотрудники бизнеса с порядком (и уволенные; удалённые — /staff/deleted)' })
  @ZodOk(z.array(staffRowOut))
  list(@Param('businessId') b: string) {
    return this.staff.list(b);
  }

  @Post('staff')
  @Biz('staff.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Добавить сотрудника; с доступом — приглашение с согласием (F-00-042, F-10-015…023)' })
  @ZodBody(addStaffBody)
  @ZodOk(addStaffOut)
  add(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(addStaffBody)) body: B<typeof addStaffBody>) {
    return this.staff.add(ctx, b, body);
  }

  @Put('staff/order')
  @HttpCode(204)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Порядок сотрудников (F-10-009/013)' })
  @ZodBody(orderBody)
  async reorder(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(orderBody)) body: B<typeof orderBody>) {
    await this.staff.reorder(ctx, b, body.ids);
  }

  @Get('staff/deleted')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Удалённые сотрудники — для восстановления (F-10-044)' })
  @ZodOk(z.array(deletedOut))
  deleted(@Param('businessId') b: string) {
    return this.staff.listDeleted(b);
  }

  @Post('staff/transfer-access')
  @HttpCode(204)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Перенести вход и роль на другую карточку (F-10-045)' })
  @ZodBody(transferAccessBody)
  async transferAccess(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(transferAccessBody)) body: B<typeof transferAccessBody>) {
    await this.staff.transferAccess(ctx, b, body);
  }

  @Get('positions')
  @Biz('staff.view')
  @ApiOperation({ summary: 'Должности со счётчиком сотрудников (F-10-046)' })
  @ZodOk(z.array(positionRowOut))
  positions(@Param('businessId') b: string) {
    return this.staff.positions(b);
  }

  @Post('positions')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Добавить должность; такая уже есть — вернуть её' })
  @ZodBody(positionBody)
  @ZodOk(positionOut)
  addPosition(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(positionBody)) body: B<typeof positionBody>) {
    return this.staff.addPosition(ctx, b, body);
  }

  @Patch('positions/:positionId')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Переименовать должность — и у назначенных сотрудников' })
  @ZodBody(positionBody)
  @ZodOk(positionOut)
  renamePosition(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('positionId') p: string, @Body(new Zod(positionBody)) body: B<typeof positionBody>) {
    return this.staff.renamePosition(ctx, b, p, body);
  }

  @Delete('positions/:positionId')
  @HttpCode(204)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Удалить должность; есть сотрудники — 409 in_use (F-10-049)' })
  async removePosition(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('positionId') p: string) {
    await this.staff.removePosition(ctx, b, p);
  }

  // ─────────── карточка ───────────

  @Get('staff/:staffId')
  @Biz('staff.view')
  @ZodOk(staffOut)
  get(@Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.get(b, s);
  }

  @Patch('staff/:staffId')
  @Biz()
  @ApiOperation({ summary: 'Профиль, места работы, услуги мастера. staff.manage; свой профиль — сам мастер (часть полей). If-Match: version' })
  @ZodBody(patchStaffBody)
  @ZodOk(staffOut)
  patch(@Ctx() ctx: RequestContext, @Req() req: RequestWithContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(patchStaffBody)) body: B<typeof patchStaffBody>) {
    return this.staff.patch(ctx, b, s, body, ifMatch(req));
  }

  @Post('staff/:staffId/fire')
  @HttpCode(200)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Уволить (F-10-040): вход гаснет сразу, портфолио уходит с мастером (C4)' })
  @ZodBody(dismissBody)
  @ZodOk(staffOut)
  fire(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(dismissBody)) body: B<typeof dismissBody>) {
    return this.staff.dismiss(ctx, b, s, body);
  }

  @Get('staff/:staffId/dismissal')
  @Biz('staff.view')
  @ZodOk(dismissalOut)
  dismissal(@Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.dismissal(b, s);
  }

  @Post('staff/:staffId/restore')
  @HttpCode(200)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Восстановить уволенного: 24 ч — сразу, до 30 дней — нельзя (F-10-044)' })
  @ZodOk(staffOut)
  restore(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.restore(ctx, b, s);
  }

  @Delete('staff/:staffId')
  @HttpCode(204)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Удалить (слово DELETE — на экране, F-10-155); клиенты и записи остаются бизнесу' })
  async remove(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string) {
    await this.staff.remove(ctx, b, s);
  }

  @Post('staff/:staffId/undelete')
  @HttpCode(200)
  @Biz('staff.manage')
  @ZodOk(staffOut)
  undelete(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.undelete(ctx, b, s);
  }

  // ─────────── доступ ───────────

  @Get('staff/:staffId/access')
  @Biz('staff.view')
  @ZodOk(accessOut)
  access(@Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.access(b, s);
  }

  @Put('staff/:staffId/access')
  @Biz('staff.manage')
  @ApiOperation({ summary: '«Предоставить доступ» (F-10-031); выключение гасит сессии сразу (F-00-040)' })
  @ZodBody(accessBody)
  @ZodOk(accessOut)
  setAccess(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(accessBody)) body: B<typeof accessBody>) {
    return this.staff.setAccessEnabled(ctx, b, s, body.enabled);
  }

  @Post('staff/:staffId/disable')
  @HttpCode(200)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Отключить администратора одним нажатием — сессии гаснут (F-00-040)' })
  @ZodOk(accessOut)
  disable(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.setAccessEnabled(ctx, b, s, false);
  }

  @Put('staff/:staffId/access/info')
  @Biz('staff.manage')
  @ZodBody(accessInfoBody)
  @ZodOk(accessOut)
  setAccessInfo(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(accessInfoBody)) body: B<typeof accessInfoBody>) {
    return this.staff.setAccessInfo(ctx, b, s, body.info);
  }

  @Put('staff/:staffId/role-template')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Роль-шаблон (8 шаблонов, F-10-053…061)' })
  @ZodBody(roleTemplateBody)
  @ZodOk(accessOut)
  setRoleTemplate(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(roleTemplateBody)) body: B<typeof roleTemplateBody>) {
    return this.staff.setRoleTemplate(ctx, b, s, body.roleTemplateId);
  }

  @Put('staff/:staffId/ip-restriction')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Вход только с доверенных IP (F-10-091)' })
  @ZodBody(ipBody)
  @ZodOk(ipBody)
  setIp(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(ipBody)) body: B<typeof ipBody>) {
    return this.staff.setIpRestriction(ctx, b, s, body);
  }

  @Put('staff/:staffId/login')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Логин и пароль администратора (F-00-034/038); смена пароля при первом входе' })
  @ZodBody(loginBody)
  @ZodOk(accessOut)
  setLogin(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(loginBody)) body: B<typeof loginBody>) {
    return this.staff.setLogin(ctx, b, s, body);
  }

  @Post('staff/:staffId/invite')
  @HttpCode(200)
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Новая ссылка-приглашение (прежняя перестаёт работать)' })
  @ZodOk(reissueOut)
  reissue(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.reissueInvite(ctx, b, s);
  }

  @Delete('staff/:staffId/invite')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Отозвать непринятое приглашение (F-10-020)' })
  @ZodOk(inviteOut)
  revokeInvite(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.revokeInvite(ctx, b, s);
  }

  @Post('staff/:staffId/transfer-ownership')
  @HttpCode(204)
  @Biz()
  @ApiOperation({ summary: 'Передать роль «Владелец» (F-10-149): звонящий — владелец, становится администратором' })
  @ZodBody(transferOwnerBody)
  async transferOwnership(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(transferOwnerBody)) body: B<typeof transferOwnerBody>) {
    await this.staff.transferOwnership(ctx, b, s, body.toStaffId);
  }

  // ─────────── права ───────────

  @Get('staff/:staffId/permissions')
  @Biz('staff.manage')
  @ZodOk(rightsOut)
  rights(@Param('businessId') b: string, @Param('staffId') s: string) {
    return this.staff.rights(b, s);
  }

  @Put('staff/:staffId/permissions')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Права галочками (F-00-039): действуют со следующего запроса' })
  @ZodBody(rightsBody)
  @ZodOk(rightsOut)
  setRights(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(rightsBody)) body: B<typeof rightsBody>) {
    return this.staff.setRights(ctx, b, s, body);
  }

  @Put('staff/:staffId/permissions/scopes')
  @HttpCode(204)
  @Biz('staff.manage')
  @ZodBody(scopesBody)
  async setScopes(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Body(new Zod(scopesBody)) body: B<typeof scopesBody>) {
    await this.staff.setRightScopes(ctx, b, s, body.scopes);
  }

  // ─────────── вкладки: юр. данные (только staff.manage), настройки карточки, пуши мастера ───────────

  @Get('staff/:staffId/tabs/:tab')
  @Biz()
  @ApiOperation({ summary: 'legal (staff.manage) · card-settings (staff.view) · push-prefs (сам или staff.manage)' })
  @ZodOk(z.record(z.string(), z.unknown()).nullable())
  getTab(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Param('tab') tab: string) {
    return this.staff.getJson(b, s, tabField(ctx, s, tab, 'read'));
  }

  @Put('staff/:staffId/tabs/:tab')
  @Biz()
  @ZodBody(jsonBody)
  @ZodOk(z.record(z.string(), z.unknown()))
  setTab(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('staffId') s: string, @Param('tab') tab: string, @Body(new Zod(jsonBody)) body: B<typeof jsonBody>) {
    return this.staff.setJson(ctx, b, s, tabField(ctx, s, tab, 'write'), body.value);
  }
}

function tabField(ctx: RequestContext, staffId: string, tab: string, mode: 'read' | 'write'): 'legalInfo' | 'cardSettings' | 'pushPrefs' {
  const m = ctx.member!;
  const manage = m.permissions.has('staff.manage');
  if (tab === 'legal') {
    if (!manage) throw new ApiError('forbidden', 'Missing permission: staff.manage');
    return 'legalInfo';
  }
  if (tab === 'card-settings') {
    if (!(mode === 'read' ? m.permissions.has('staff.view') : manage)) throw new ApiError('forbidden', 'Missing permission');
    return 'cardSettings';
  }
  if (tab === 'push-prefs') {
    if (!manage && m.staffId !== staffId) throw new ApiError('forbidden', 'Own push preferences only');
    return 'pushPrefs';
  }
  throw new ApiError('not_found', 'Unknown tab');
}
