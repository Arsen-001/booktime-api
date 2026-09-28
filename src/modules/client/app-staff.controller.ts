import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { AppStaffService } from './app-staff.service.js';
import { employeeAppAccessBody, payoutBody } from './client.schemas.js';

/**
 * Раздел «Приложение» кабинета (F-14-116…129), стадия 21 (лейн client+online, попытка 2):
 * `src/api/client.ts::listAppStaff/setEmployeeAppAccess/getDayZReport/getAppPayrollCalculation/
 * getAppPayrollPayouts/recordPayrollPayout`.
 */
@ApiTags('client')
@Controller('v1/biz/:businessId/app-staff')
export class AppStaffController {
  constructor(private readonly svc: AppStaffService) {}

  @Get()
  @Biz('staff.view')
  @ApiOperation({ summary: 'Сотрудники + доступ в приложении (F-14-116…121)' })
  list(@Param('businessId') businessId: string, @Query('includeFired') includeFired?: string) {
    return this.svc.listAppStaff(businessId, includeFired !== 'false');
  }

  @Patch(':staffId/access')
  @Biz('staff.manage')
  @ApiOperation({ summary: 'Изменить доступ сотрудника в приложении' })
  @ZodBody(employeeAppAccessBody)
  setAccess(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(employeeAppAccessBody)) body: z.infer<typeof employeeAppAccessBody>) {
    return this.svc.setEmployeeAppAccess({ businessId, staffId }, body);
  }

  @Get('z-report')
  @Biz('staff.view')
  @ApiOperation({ summary: 'Z-отчёт дня (F-14-122)' })
  zReport(@Param('businessId') businessId: string, @Query('date') date: string, @Query('staffId') staffId?: string) {
    return this.svc.getDayZReport(businessId, date, staffId);
  }

  @Get(':staffId/payroll-calculation')
  @Biz()
  @ApiOperation({ summary: '«Calculation» — своя выработка (F-14-127, В-10: своя всегда видна)' })
  payrollCalc(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from') from: string, @Query('to') to: string) {
    if (staffId !== ctx.member!.staffId && !ctx.member!.permissions.has('payroll.view')) throw new ApiError('forbidden', 'Missing permission: payroll.view');
    return this.svc.getPayrollCalculation(businessId, staffId, from, to);
  }

  @Get(':staffId/payroll-payouts')
  @Biz()
  @ApiOperation({ summary: '«Payouts» — заработано/выплачено/осталось (демо-копилка, F-14-127)' })
  payrollPayouts(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('staffId') staffId: string, @Query('from') from: string, @Query('to') to: string) {
    if (staffId !== ctx.member!.staffId && !ctx.member!.permissions.has('payroll.view')) throw new ApiError('forbidden', 'Missing permission: payroll.view');
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
}
