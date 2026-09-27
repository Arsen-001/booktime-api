import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import {
  billingAddressBody,
  brandBody,
  categoryBody,
  changeLogQuery,
  contactsBody,
  galleryBody,
  helpBody,
  legalBody,
  onboardingBody,
  prefsBody,
  sphereBody,
  systemBody,
} from './settings.schemas.js';
import { SettingsService } from './settings.service.js';

/** Настройки компании — /v1/biz/{b}/company/…, обращения, личные настройки (docs/backend/02 §18) */
@ApiTags('settings')
@Controller('v1/biz/:businessId')
export class SettingsController {
  constructor(private readonly s: SettingsService) {}

  @Get('company/legal')
  @Biz()
  legal(@Param('businessId') b: string) {
    return this.s.legal(b);
  }

  @Put('company/legal')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Реквизиты (F-15-112): ՀՎՀՀ — 8 цифр (bad_tax_id)' })
  @ZodBody(legalBody)
  saveLegal(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(legalBody)) body: z.infer<typeof legalBody>) {
    return this.s.saveLegal(ctx, b, body);
  }

  @Put('company/billing-address')
  @Biz('billing.manage')
  @ZodBody(billingAddressBody)
  billingAddress(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(billingAddressBody)) body: z.infer<typeof billingAddressBody>) {
    return this.s.saveBillingAddress(ctx, b, body.billingAddress);
  }

  @Get('company/system')
  @Biz()
  system(@Param('businessId') b: string) {
    return this.s.system(b);
  }

  @Put('company/system')
  @Biz('settings.manage')
  @ZodBody(systemBody)
  saveSystem(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(systemBody)) body: z.infer<typeof systemBody>) {
    return this.s.saveSystem(ctx, b, body);
  }

  @Get('company/brand')
  @Biz()
  brand(@Param('businessId') b: string) {
    return this.s.brand(b);
  }

  @Put('company/brand')
  @Biz('settings.manage')
  @ZodBody(brandBody)
  saveBrand(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(brandBody)) body: z.infer<typeof brandBody>) {
    return this.s.saveBrand(ctx, b, body);
  }

  @Get('company/contacts')
  @Biz()
  contacts(@Param('businessId') b: string) {
    return this.s.contacts(b);
  }

  @Put('company/contacts')
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Контакты (F-15-104…110): Telegram — https://t.me/username (bad_telegram_url)' })
  @ZodBody(contactsBody)
  saveContacts(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(contactsBody)) body: z.infer<typeof contactsBody>) {
    return this.s.saveContacts(ctx, b, body);
  }

  @Get('company/gallery')
  @Biz()
  gallery(@Param('businessId') b: string) {
    return this.s.gallery(b);
  }

  @Put('company/gallery')
  @Biz('settings.manage')
  @ZodBody(galleryBody)
  saveGallery(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(galleryBody)) body: z.infer<typeof galleryBody>) {
    return this.s.saveGallery(ctx, b, body.photos);
  }

  @Get('company/profile')
  @Biz()
  profile(@Param('businessId') b: string) {
    return this.s.companyProfile(b);
  }

  @Get('company/change-log')
  @Biz('settings.manage')
  changeLog(@Param('businessId') b: string, @Query(new Zod(changeLogQuery)) q: z.infer<typeof changeLogQuery>) {
    return this.s.changeLog(b, q.section);
  }

  @Get('record-categories')
  @Biz()
  categories(@Param('businessId') b: string) {
    return this.s.categories(b);
  }

  @Post('record-categories')
  @Biz('settings.manage')
  @ZodBody(categoryBody)
  addCategory(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(categoryBody)) body: z.infer<typeof categoryBody>) {
    return this.s.saveCategory(ctx, b, undefined, body);
  }

  @Patch('record-categories/:id')
  @Biz('settings.manage')
  @ZodBody(categoryBody)
  editCategory(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('id') id: string, @Body(new Zod(categoryBody)) body: z.infer<typeof categoryBody>) {
    return this.s.saveCategory(ctx, b, id, body);
  }

  @Delete('record-categories/:id')
  @Biz('settings.manage')
  @HttpCode(204)
  async deleteCategory(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Param('id') id: string) {
    await this.s.deleteCategory(ctx, b, id);
  }

  @Get('onboarding')
  @Biz()
  onboarding(@Param('businessId') b: string) {
    return this.s.onboarding(b);
  }

  @Put('onboarding')
  @Biz()
  @ApiOperation({ summary: 'Цели анкеты (F-15-007), тур просмотрен (F-15-021)' })
  @ZodBody(onboardingBody)
  saveOnboarding(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(onboardingBody)) body: z.infer<typeof onboardingBody>) {
    return this.s.saveOnboarding(ctx, b, body);
  }

  @Get('onboarding/checklist')
  @Biz()
  checklist(@Param('businessId') b: string) {
    return this.s.checklist(b);
  }

  @Get('help-requests')
  @Biz()
  help(@Param('businessId') b: string) {
    return this.s.requests(b, 'help');
  }

  @Post('help-requests')
  @Biz()
  @ZodBody(helpBody)
  createHelp(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(helpBody)) body: z.infer<typeof helpBody>) {
    return this.s.createRequest(ctx, b, 'help', body);
  }

  @Get('mobile-app-requests')
  @Biz()
  appRequests(@Param('businessId') b: string) {
    return this.s.requests(b, 'mobileApp');
  }

  @Post('mobile-app-requests')
  @Biz('settings.manage')
  @ApiOperation({ summary: '«Хочу своё приложение» (В-29: позже, платно) — только заявка' })
  createAppRequest(@Ctx() ctx: RequestContext, @Param('businessId') b: string) {
    return this.s.createRequest(ctx, b, 'mobileApp', {});
  }

  @Get('sphere-requests')
  @Biz()
  spheres(@Param('businessId') b: string) {
    return this.s.sphereRequests(b);
  }

  @Get('sphere-requests/:id')
  @Biz()
  sphere(@Param('businessId') b: string, @Param('id') id: string) {
    return this.s.sphereRequest(b, id);
  }

  @Post('sphere-requests')
  @Biz()
  @ZodBody(sphereBody)
  createSphere(@Ctx() ctx: RequestContext, @Param('businessId') b: string, @Body(new Zod(sphereBody)) body: z.infer<typeof sphereBody>) {
    return this.s.createSphereRequest(ctx, b, body);
  }

  @Get('me/prefs')
  @Biz()
  prefs(@Ctx() ctx: RequestContext) {
    return this.s.prefs(ctx.member!.staffId);
  }

  @Put('me/prefs')
  @Biz()
  @ApiOperation({ summary: 'Личные: уведомления (F-15-150), стартовая страница (F-15-157)' })
  @ZodBody(prefsBody)
  savePrefs(@Ctx() ctx: RequestContext, @Body(new Zod(prefsBody)) body: z.infer<typeof prefsBody>) {
    return this.s.savePrefs(ctx.member!.staffId, body);
  }
}
