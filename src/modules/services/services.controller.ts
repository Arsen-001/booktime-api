import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import {
  activeBody,
  categoryBody,
  categoryDeleteImpactOut,
  categoryOut,
  createServiceBody,
  deleteImpactOut,
  orderBody,
  packageCreateBody,
  packageOut,
  packageSaveBody,
  restoreServiceBody,
  serviceBody,
  serviceExtraBody,
  serviceOut,
  serviceRowOut,
  staffTermBody,
  techBreakBody,
  techBreakExportRowOut,
  techBreakImportBody,
  techBreakImportResultOut,
} from './services.schemas.js';
import { ServicesService } from './services.service.js';

/** Каталог: категории, услуги, пакеты «Комплекс» — /v1/biz (docs/backend/02 §8, PLAN §6 №4) */
@ApiTags('services')
@Controller('v1/biz/:businessId')
export class ServicesController {
  constructor(private readonly svc: ServicesService) {}

  // ─────────── категории ───────────

  @Get('categories')
  @Biz('services.view')
  @ZodOk(z.array(categoryOut))
  listCategories(@Param('businessId') businessId: string) {
    return this.svc.listCategories(businessId);
  }

  @Get('categories/:id')
  @Biz('services.view')
  @ZodOk(categoryOut)
  getCategory(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getCategory(businessId, id);
  }

  @Post('categories')
  @Biz('services.edit')
  @ZodBody(categoryBody)
  @ZodOk(categoryOut)
  createCategory(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(categoryBody)) body: z.infer<typeof categoryBody>) {
    return this.svc.createCategory(ctx, businessId, body);
  }

  @Patch('categories/:id')
  @Biz('services.edit')
  @ZodBody(categoryBody)
  @ZodOk(categoryOut)
  updateCategory(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(categoryBody)) body: z.infer<typeof categoryBody>,
  ) {
    return this.svc.updateCategory(ctx, businessId, id, body);
  }

  @Get('categories/:id/delete-impact')
  @Biz('services.view')
  @ZodOk(categoryDeleteImpactOut)
  categoryDeleteImpact(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.categoryDeleteImpact(businessId, id);
  }

  @Get('categories/:id/online-name')
  @Biz('services.view')
  @ApiOperation({ summary: 'Своё имя категории для витрины (F-03-131)' })
  categoryOnlineName(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.categoryOnlineName(businessId, id);
  }

  @Delete('categories/:id')
  @Biz('services.edit')
  deleteCategory(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteCategory(ctx, businessId, id);
  }

  // ─────────── услуги — статичные пути (регистрируются раньше /services/:id) ───────────

  @Get('service-rows')
  @Biz('services.view')
  @ZodOk(z.array(serviceRowOut))
  listServiceRows(@Param('businessId') businessId: string) {
    return this.svc.listServiceRows(businessId);
  }

  @Get('services/tech-break/export')
  @Biz('services.view')
  @ApiOperation({ summary: 'Выгрузка Tech. break в Excel (F-02-063)' })
  @ZodOk(z.array(techBreakExportRowOut))
  techBreakExport(@Param('businessId') businessId: string) {
    return this.svc.techBreakExportRows(businessId);
  }

  @Post('services/tech-break/import')
  @Biz('services.edit')
  @ApiOperation({ summary: 'Загрузка Tech. break из Excel — до 500 строк за раз' })
  @ZodBody(techBreakImportBody)
  @ZodOk(techBreakImportResultOut)
  techBreakImport(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(techBreakImportBody)) body: z.infer<typeof techBreakImportBody>) {
    return this.svc.importTechBreaks(ctx, businessId, body.rows);
  }

  @Post('services/restore')
  @Biz('services.edit')
  @ApiOperation({ summary: '«Отменить» удаление (F-00-061): пересоздаёт услугу тем же id из снимка экрана' })
  @ZodBody(restoreServiceBody)
  @ZodOk(serviceOut)
  restoreService(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(restoreServiceBody)) body: z.infer<typeof restoreServiceBody>) {
    return this.svc.restoreService(ctx, businessId, body);
  }

  @Put('services/order')
  @Biz('services.edit')
  @ZodBody(orderBody)
  reorderServices(@Param('businessId') businessId: string, @Body(new Zod(orderBody)) body: z.infer<typeof orderBody>) {
    return this.svc.reorder(businessId, body.ids);
  }

  // ─────────── услуги ───────────

  @Get('services')
  @Biz('services.view')
  @ZodOk(z.array(serviceOut))
  listServices(@Param('businessId') businessId: string, @Query('kind') kind?: 'individual' | 'group') {
    return this.svc.listServices(businessId, kind);
  }

  @Get('services/:id')
  @Biz('services.view')
  @ZodOk(serviceOut)
  getService(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getService(businessId, id);
  }

  @Post('services')
  @Biz('services.edit')
  @ZodBody(createServiceBody)
  @ZodOk(serviceOut)
  createService(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createServiceBody)) body: z.infer<typeof createServiceBody>) {
    return this.svc.createService(ctx, businessId, body);
  }

  @Patch('services/:id')
  @Biz('services.edit')
  @ZodBody(serviceBody)
  @ZodOk(serviceOut)
  updateService(
    @Ctx() ctx: RequestContext,
    @Req() req: RequestWithContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(serviceBody)) body: z.infer<typeof serviceBody>,
  ) {
    return this.svc.updateService(ctx, businessId, id, body, ifMatch(req));
  }

  @Put('services/:id/active')
  @Biz('services.edit')
  @ZodBody(activeBody)
  @ZodOk(serviceOut)
  setActive(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(activeBody)) body: z.infer<typeof activeBody>) {
    return this.svc.setActive(ctx, businessId, id, body.active);
  }

  @Put('services/:id/tech-break')
  @Biz('services.edit')
  @ZodBody(techBreakBody)
  @ZodOk(serviceOut)
  setTechBreak(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(techBreakBody)) body: z.infer<typeof techBreakBody>) {
    return this.svc.setTechBreak(ctx, businessId, id, body.mode, body.min);
  }

  @Get('services/:id/delete-impact')
  @Biz('services.view')
  @ZodOk(deleteImpactOut)
  deleteImpact(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteImpact(businessId, id);
  }

  @Delete('services/:id')
  @Biz('services.edit')
  @ZodOk(serviceOut)
  deleteService(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteService(ctx, businessId, id);
  }

  // ─────────── мастера услуги (F-10-156, F-02-058, F-16-030) ───────────

  @Get('services/:id/staff')
  @Biz('services.view')
  listServiceStaff(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.listServiceStaff(businessId, id);
  }

  @Get('services/:id/assignable-staff')
  @Biz('services.view')
  listAssignableStaff(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.listAssignableStaff(businessId, id);
  }

  @Post('services/:id/staff/:staffId')
  @Biz('services.edit')
  assignStaff(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Param('staffId') staffId: string) {
    return this.svc.assignStaffToService(ctx, businessId, id, staffId);
  }

  @Delete('services/:id/staff/:staffId')
  @Biz('services.edit')
  removeStaff(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Param('staffId') staffId: string) {
    return this.svc.removeStaffFromService(ctx, businessId, id, staffId);
  }

  @Get('services/:id/staff/:staffId/term')
  @Biz('services.view')
  getStaffTerm(@Param('businessId') businessId: string, @Param('id') id: string, @Param('staffId') staffId: string) {
    return this.svc.getStaffServiceTerms(businessId, id, staffId);
  }

  @Put('services/:id/staff/:staffId/term')
  @Biz('services.edit')
  @ZodBody(staffTermBody)
  setStaffTerm(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Param('staffId') staffId: string,
    @Body(new Zod(staffTermBody)) body: z.infer<typeof staffTermBody>,
  ) {
    return this.svc.setStaffServiceTerm(businessId, id, staffId, body.price, body.durationMin);
  }

  @Get('staff/:staffId/service-groups')
  @Biz('services.view')
  @ApiOperation({ summary: 'Услуги мастера по категориям — вклад в карточку сотрудника (F-10-027)' })
  listStaffServices(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.svc.listStaffServices(businessId, staffId);
  }

  @Get('staff/:staffId/assignable-services')
  @Biz('services.view')
  listAssignableServices(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.svc.listAssignableServices(businessId, staffId);
  }

  // ─────────── языки, чек, выбор при записи (F-03-115, F-15-141, F-07-149) ───────────

  @Get('services/:id/extra')
  @Biz('services.view')
  getServiceExtra(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getServiceExtra(businessId, id);
  }

  @Put('services/:id/extra')
  @Biz('services.edit')
  @ZodBody(serviceExtraBody)
  updateServiceExtra(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(serviceExtraBody)) body: z.infer<typeof serviceExtraBody>) {
    return this.svc.updateServiceExtra(businessId, id, body);
  }

  @Get('services/:id/receipt-name')
  @Biz('services.view')
  getReceiptName(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getReceiptName(businessId, id);
  }

  @Get('services/:id/translations')
  @Biz('services.view')
  getServiceTranslations(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getServiceTranslations(businessId, id);
  }

  // ─────────── пакеты «Комплекс» (F-16-107…135) ───────────

  @Get('packages')
  @Biz('resources.manage')
  @ZodOk(z.array(packageOut))
  listPackages(@Param('businessId') businessId: string) {
    return this.svc.listPackages(businessId);
  }

  @Get('packages/:id')
  @Biz('resources.manage')
  @ZodOk(packageOut)
  getPackage(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getPackage(businessId, id);
  }

  @Post('packages')
  @Biz('resources.manage')
  @ZodBody(packageCreateBody)
  @ZodOk(packageOut)
  createPackage(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(packageCreateBody)) body: z.infer<typeof packageCreateBody>) {
    return this.svc.createPackage(ctx, businessId, body);
  }

  @Patch('packages/:id')
  @Biz('resources.manage')
  @ZodBody(packageSaveBody)
  @ZodOk(packageOut)
  savePackage(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(packageSaveBody)) body: z.infer<typeof packageSaveBody>) {
    return this.svc.savePackage(ctx, businessId, id, body);
  }

  @Get('packages/:id/future-bookings')
  @Biz('resources.manage')
  futureBookings(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.countFuturePackageBookings(businessId, id).then((count) => ({ count }));
  }

  @Delete('packages/:id')
  @Biz('resources.manage')
  deletePackage(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deletePackage(ctx, businessId, id);
  }
}
