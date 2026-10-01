import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { isLocalDate } from '../../common/time/time.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { AppStaffService } from './app-staff.service.js';
import { employeeAppAccessBody, oneOffPushBody, payoutBody } from './client.schemas.js';

/**
 * Раздел «Приложение» кабинета (F-14-116…129), стадия 21 (лейн client+online, попытка 2):
 * `src/api/client.ts::listAppStaff/setEmployeeAppAccess/getDayZReport/getAppPayrollCalculation/
 * getAppPayrollPayouts/recordPayrollPayout`.
 */
/** Дата в запросе — строго 'YYYY-MM-DD' (без неё выборка получала Invalid Date и падала 500) */
const qDate = z.string().refine(isLocalDate, 'YYYY-MM-DD');

@ApiTags('client')
@Controller('v1/biz/:businessId/app-staff')
export class AppStaffController {
  constructor(private readonly svc: AppStaffService) {}

  // client-2-fix (как listAppStaff мока): без staff.view — только своя строка
  @Get()
  @Biz()
  @ApiOperation({ summary: 'Сотрудники + доступ в приложении (F-14-116…121); без staff.view — только свой' })
  async list(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Query('includeFired') includeFired?: string) {
    const rows = await this.svc.listAppStaff(businessId, includeFired !== 'false');
    return ctx.member!.permissions.has('staff.view') ? rows : rows.filter((r) => r.staff.id === ctx.member!.staffId);
  }

  @Patch(':staffId/access')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Изменить доступ сотрудника в приложении' })
  @ZodBody(employeeAppAccessBody)
  setAccess(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(employeeAppAccessBody)) body: z.infer<typeof employeeAppAccessBody>) {
    // assertStaffManage мока: доступ владельца в приложении не меняется никем
    return this.svc.setEmployeeAppAccess({ businessId, staffId }, body, { forbidOwner: true });
  }

  // client-2-fix: Z-отчёт — finance.view (getDayZReport мока)
  @Get('z-report')
  @Biz('finance.view')
  @ApiOperation({ summary: 'Z-отчёт дня (F-14-122)' })
  zReport(@Param('businessId') businessId: string, @Query('date', new Zod(qDate)) date: string, @Query('staffId') staffId?: string) {
    return this.svc.getDayZReport(businessId, date, staffId);
  }

  @Get(':staffId/payroll-calculation')
  @Biz()
  @ApiOperation({ summary: '«Calculation» — своя выработка (F-14-127, В-10: своя всегда видна)' })
  payrollCalc(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from', new Zod(qDate)) from: string, @Query('to', new Zod(qDate)) to: string) {
    // client-2-fix (F-14-127, как мок): свой расчёт — любому; чужой — только с payroll.manage
    if (staffId !== ctx.member!.staffId && !ctx.member!.permissions.has('payroll.manage')) throw new ApiError('forbidden', 'Missing permission: payroll.manage');
    return this.svc.getPayrollCalculation(businessId, staffId, from, to);
  }

  @Get(':staffId/payroll-payouts')
  @Biz()
  @ApiOperation({ summary: '«Payouts» — заработано/выплачено/осталось (демо-копилка, F-14-127)' })
  payrollPayouts(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from', new Zod(qDate)) from: string, @Query('to', new Zod(qDate)) to: string) {
    // client-2-fix (F-14-127, как мок): свой расчёт — любому; чужой — только с payroll.manage
    if (staffId !== ctx.member!.staffId && !ctx.member!.permissions.has('payroll.manage')) throw new ApiError('forbidden', 'Missing permission: payroll.manage');
    return this.svc.getPayrollPayouts(businessId, staffId, from, to);
  }

  @Post(':staffId/payroll-payouts')
  @HttpCode(200)
  @Biz('payroll.manage')
  @ApiOperation({ summary: 'Отметить выплату сотруднику (демо-копилка, реальных денег нет)' })
  @ZodBody(payoutBody)
  recordPayout(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(payoutBody)) body: z.infer<typeof payoutBody>) {
    return this.svc.recordPayrollPayout(businessId, staffId, body.amount);
  }

  @Post('messages')
  @Biz('journal.edit')
  @ApiOperation({ summary: 'F-14-074: отправить сообщение клиенту из окна записи' })
  @ZodBody(oneOffPushBody)
  sendMessage(@Param('businessId') businessId: string, @Body(new Zod(oneOffPushBody)) body: z.infer<typeof oneOffPushBody>) {
    return this.svc.sendOneOffPush(businessId, body);
  }
}
