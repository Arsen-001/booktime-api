import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { LoyaltyCatalogService } from './loyalty-catalog.service.js';
import { LoyaltyInstancesService } from './loyalty-instances.service.js';
import { LoyaltyProgramService } from './loyalty-program.service.js';
import { requireAny } from './loyalty.owner.js';
import {
  accountOpBody,
  accountTypeBody,
  accountTypePatchBody,
  applyBody,
  archiveBody,
  bonusBody,
  cardTypeBody,
  cardTypePatchBody,
  certTypeBody,
  certTypePatchBody,
  clientVisibilityBody,
  confirmCertificateBody,
  confirmMembershipBody,
  freezeMembershipBody,
  issueCardBody,
  loyaltyProgramBody,
  membershipTypeBody,
  membershipTypePatchBody,
  openAccountBody,
  promotionBody,
  promotionPatchBody,
  referralBody,
  sellCertificateBody,
  sellMembershipBody,
} from './loyalty.schemas.js';

/**
 * Лояльность — /v1/biz/:businessId/loyalty (docs/backend/02-api.md §11, PLAN §6 №11). Владелец данных — сеть
 * (F-06-002/В-09): каждый метод резолвит ownerId сам (loyalty.owner.ts), путь остаётся /v1/biz как у всех
 * разделов (PLAN §2 не просит отдельный /v1/net для этого раздела).
 */
@ApiTags('loyalty')
@Controller('v1/biz/:businessId/loyalty')
export class LoyaltyController {
  constructor(
    private readonly program: LoyaltyProgramService,
    private readonly catalog: LoyaltyCatalogService,
    private readonly instances: LoyaltyInstancesService,
  ) {}

  // ─────────── Программа локации (F-04-114…122) ───────────

  @Get('program')
  @Biz('loyalty.rules')
  @ZodOk(loyaltyProgramBody)
  getProgram(@Param('businessId') businessId: string) {
    return this.program.get(businessId);
  }

  @Put('program')
  @Biz('loyalty.rules')
  @ApiOperation({ summary: 'Сохранить программу и пересчитать всех клиентов (F-04-121)' })
  @ZodBody(loyaltyProgramBody)
  saveProgram(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(loyaltyProgramBody)) body: z.infer<typeof loyaltyProgramBody>) {
    return this.program.save(ctx, businessId, body);
  }

  @Post('program/recalculate')
  @HttpCode(200)
  @Biz('loyalty.rules')
  @ApiOperation({ summary: 'Ручной пересчёт правил (F-04-073)' })
  recalculate(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.program.recalcAll(ctx, businessId, 'manual').then((recalculated) => ({ recalculated }));
  }

  @Post('clients/:clientId/program/recalculate')
  @HttpCode(200)
  @Biz('loyalty.rules')
  @ApiOperation({ summary: 'Пересчёт одного клиента (F-04-073)' })
  recalculateOne(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.program.recalcOne(ctx, businessId, clientId, 'manual');
  }

  // ─────────── Видимость клиенту (В-06) ───────────

  @Get('client-visibility')
  @Biz('loyalty.manage')
  getClientVisibility(@Param('businessId') businessId: string) {
    return this.program.getShowToClient(businessId).then((showToClient) => ({ showToClient }));
  }

  @Put('client-visibility')
  @Biz('loyalty.manage')
  @ZodBody(clientVisibilityBody)
  setClientVisibility(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(clientVisibilityBody)) body: z.infer<typeof clientVisibilityBody>) {
    return this.program.setShowToClient(ctx, businessId, body.showToClient);
  }

  // ─────────── Типы карт (F-06-020…030) ───────────

  @Get('card-types')
  @Biz('loyalty.manage')
  listCardTypes(@Ctx() ctx: RequestContext) {
    return this.catalog.listCardTypes(ctx);
  }

  @Post('card-types')
  @Biz('loyalty.manage')
  @ZodBody(cardTypeBody)
  createCardType(@Ctx() ctx: RequestContext, @Body(new Zod(cardTypeBody)) body: z.infer<typeof cardTypeBody>) {
    return this.catalog.createCardType(ctx, body);
  }

  @Patch('card-types/:id')
  @Biz('loyalty.manage')
  @ZodBody(cardTypePatchBody)
  updateCardType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(cardTypePatchBody)) body: z.infer<typeof cardTypePatchBody>) {
    return this.catalog.updateCardType(ctx, id, body);
  }

  @Put('card-types/:id/archive')
  @Biz('loyalty.manage')
  @ApiOperation({ summary: 'В-40: «В архив» вместо удаления' })
  @ZodBody(archiveBody)
  archiveCardType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(archiveBody)) body: z.infer<typeof archiveBody>) {
    return this.catalog.archiveCardType(ctx, id, body.archived);
  }

  @Delete('card-types/:id')
  @Biz('loyalty.manage')
  @ApiOperation({ summary: 'В-40: отказывает (has_issued_cards), если есть выданные карты' })
  async deleteCardType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteCardType(ctx, id);
  }

  // ─────────── Карты клиентов (F-06-051…060) ───────────

  @Get('clients/:clientId/cards')
  @Biz('loyalty.manage')
  listClientCards(@Ctx() ctx: RequestContext, @Param('clientId') clientId: string) {
    return this.instances.listClientCards(ctx, clientId);
  }

  @Post('clients/:clientId/cards')
  @Biz('loyalty.manage')
  @ApiOperation({ summary: 'Выдать карту (F-14-102) — номер генерируется, если не введён' })
  @ZodBody(issueCardBody)
  issueCard(@Ctx() ctx: RequestContext, @Param('clientId') clientId: string, @Body(new Zod(issueCardBody)) body: z.infer<typeof issueCardBody>) {
    return this.instances.issueCard(ctx, clientId, body.cardTypeId, body.number);
  }

  @Post('cards/:cardId/bonuses')
  @Biz()
  @ApiOperation({ summary: 'Ручное начисление/списание бонусов — loyalty.manage либо в окне записи journal.edit' })
  @ZodBody(bonusBody)
  adjustBonus(@Ctx() ctx: RequestContext, @Param('cardId') cardId: string, @Body(new Zod(bonusBody)) body: z.infer<typeof bonusBody>) {
    requireAny(ctx, ['loyalty.manage', 'journal.edit']);
    return this.instances.adjustBonus(ctx, cardId, body.kind, body.amount, body.note);
  }

  // ─────────── Акции (F-06-031…050) ───────────

  @Get('promotions')
  @Biz('loyalty.manage')
  listPromotions(@Ctx() ctx: RequestContext) {
    return this.catalog.listPromotions(ctx);
  }

  @Post('promotions')
  @Biz('loyalty.manage')
  @ApiOperation({ summary: 'Мастер из 5 шагов фронта — одна форма, один POST' })
  @ZodBody(promotionBody)
  createPromotion(@Ctx() ctx: RequestContext, @Body(new Zod(promotionBody)) body: z.infer<typeof promotionBody>) {
    return this.catalog.createPromotion(ctx, body);
  }

  @Patch('promotions/:id')
  @Biz('loyalty.manage')
  @ZodBody(promotionPatchBody)
  updatePromotion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(promotionPatchBody)) body: z.infer<typeof promotionPatchBody>) {
    return this.catalog.updatePromotion(ctx, id, body);
  }

  @Delete('promotions/:id')
  @Biz('loyalty.manage')
  async deletePromotion(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deletePromotion(ctx, id);
  }

  // ─────────── Применение при оплате визита (F-06-061…075) ───────────

  @Post('bookings/:bookingId/apply')
  @Biz('finance.edit')
  @ApiOperation({ summary: 'Строки оплаты «лояльностью» — списывает бонусы/сертификат/абонемент/счёт' })
  @ZodBody(applyBody)
  applyToBooking(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(applyBody)) body: z.infer<typeof applyBody>) {
    return this.instances.applyToBooking(ctx, businessId, bookingId, body.lines);
  }

  // ─────────── Транзакции (F-06-076/077) ───────────

  @Get('transactions')
  @Biz('loyalty.manage')
  listTx(@Ctx() ctx: RequestContext, @Query('clientId') clientId?: string) {
    return this.instances.listTx(ctx, clientId);
  }

  // ─────────── Рефералы (F-06-081…085) ───────────

  @Get('referral')
  @Biz('loyalty.manage')
  getReferral(@Ctx() ctx: RequestContext) {
    return this.catalog.getReferral(ctx);
  }

  @Put('referral')
  @Biz('loyalty.manage')
  @ZodBody(referralBody)
  setReferral(@Ctx() ctx: RequestContext, @Body(new Zod(referralBody)) body: z.infer<typeof referralBody>) {
    return this.catalog.setReferral(ctx, body);
  }

  // ─────────── Типы сертификатов (F-06-086…104) ───────────

  @Get('certificate-types')
  @Biz('loyalty.manage')
  listCertTypes(@Ctx() ctx: RequestContext) {
    return this.catalog.listCertTypes(ctx);
  }

  @Post('certificate-types')
  @Biz('loyalty.manage')
  @ZodBody(certTypeBody)
  createCertType(@Ctx() ctx: RequestContext, @Body(new Zod(certTypeBody)) body: z.infer<typeof certTypeBody>) {
    return this.catalog.createCertType(ctx, body);
  }

  @Patch('certificate-types/:id')
  @Biz('loyalty.manage')
  @ZodBody(certTypePatchBody)
  updateCertType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(certTypePatchBody)) body: z.infer<typeof certTypePatchBody>) {
    return this.catalog.updateCertType(ctx, id, body);
  }

  @Put('certificate-types/:id/archive')
  @Biz('loyalty.manage')
  @ZodBody(archiveBody)
  archiveCertType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(archiveBody)) body: z.infer<typeof archiveBody>) {
    return this.catalog.archiveCertType(ctx, id, body.archived);
  }

  @Delete('certificate-types/:id')
  @Biz('loyalty.manage')
  async deleteCertType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteCertType(ctx, id);
  }

  // ─────────── Сертификаты — продажа/подтверждение/возврат (F-06-086…104, В-17) ───────────

  @Post('certificates')
  @Biz()
  @ZodBody(sellCertificateBody)
  sellCertificate(@Ctx() ctx: RequestContext, @Body(new Zod(sellCertificateBody)) body: z.infer<typeof sellCertificateBody>) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.sellCertificate(ctx, body.typeId, body);
  }

  @Get('certificate-requests')
  @Biz()
  @ApiOperation({ summary: 'В-17: заявки клиентов «ждут подтверждения»' })
  listCertificateRequests(@Ctx() ctx: RequestContext) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.listPendingCertificates(ctx);
  }

  @Post('certificates/:id/confirm')
  @HttpCode(200)
  @Biz()
  @ApiOperation({ summary: 'В-17: «Подтвердить оплату» заявки из приложения' })
  @ZodBody(confirmCertificateBody)
  confirmCertificate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(confirmCertificateBody)) body: z.infer<typeof confirmCertificateBody>) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.confirmCertificate(ctx, id, body.clientId);
  }

  @Post('certificates/:id/reject')
  @HttpCode(200)
  @Biz()
  rejectCertificate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.rejectCertificate(ctx, id);
  }

  @Post('certificates/:id/refund')
  @HttpCode(200)
  @Biz()
  refundCertificate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.refundCertificate(ctx, id);
  }

  // ─────────── Типы абонементов (F-06-105…134) ───────────

  @Get('membership-types')
  @Biz('loyalty.manage')
  listMembershipTypes(@Ctx() ctx: RequestContext) {
    return this.catalog.listMembershipTypes(ctx);
  }

  @Post('membership-types')
  @Biz('loyalty.manage')
  @ZodBody(membershipTypeBody)
  createMembershipType(@Ctx() ctx: RequestContext, @Body(new Zod(membershipTypeBody)) body: z.infer<typeof membershipTypeBody>) {
    return this.catalog.createMembershipType(ctx, body);
  }

  @Patch('membership-types/:id')
  @Biz('loyalty.manage')
  @ZodBody(membershipTypePatchBody)
  updateMembershipType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(membershipTypePatchBody)) body: z.infer<typeof membershipTypePatchBody>) {
    return this.catalog.updateMembershipType(ctx, id, body);
  }

  @Put('membership-types/:id/archive')
  @Biz('loyalty.manage')
  @ZodBody(archiveBody)
  archiveMembershipType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(archiveBody)) body: z.infer<typeof archiveBody>) {
    return this.catalog.archiveMembershipType(ctx, id, body.archived);
  }

  @Delete('membership-types/:id')
  @Biz('loyalty.manage')
  async deleteMembershipType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteMembershipType(ctx, id);
  }

  // ─────────── Абонементы — продажа/заморозка/возврат (F-06-105…134, В-17) ───────────

  @Get('membership-requests')
  @Biz()
  @ApiOperation({ summary: 'В-17: заявки клиентов «ждут подтверждения»' })
  listMembershipRequests(@Ctx() ctx: RequestContext) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.listPendingMemberships(ctx);
  }

  @Post('memberships')
  @Biz()
  @ZodBody(sellMembershipBody)
  sellMembership(@Ctx() ctx: RequestContext, @Body(new Zod(sellMembershipBody)) body: z.infer<typeof sellMembershipBody>) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.sellMembership(ctx, body.typeId, body);
  }

  @Post('memberships/:id/confirm')
  @HttpCode(200)
  @Biz()
  @ZodBody(confirmMembershipBody)
  confirmMembership(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(confirmMembershipBody)) body: z.infer<typeof confirmMembershipBody>) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.confirmMembership(ctx, id, body.clientId);
  }

  @Post('memberships/:id/reject')
  @HttpCode(200)
  @Biz()
  rejectMembership(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.rejectMembership(ctx, id);
  }

  @Post('memberships/:id/freeze')
  @HttpCode(200)
  @Biz()
  @ZodBody(freezeMembershipBody)
  freezeMembership(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(freezeMembershipBody)) body: z.infer<typeof freezeMembershipBody>) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.freezeMembership(ctx, id, true, body.toAt);
  }

  @Post('memberships/:id/unfreeze')
  @HttpCode(200)
  @Biz()
  unfreezeMembership(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.freezeMembership(ctx, id, false);
  }

  @Post('memberships/:id/refund')
  @HttpCode(200)
  @Biz()
  refundMembership(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAny(ctx, ['loyalty.manage', 'finance.edit']);
    return this.instances.refundMembership(ctx, id);
  }

  // ─────────── Типы счетов клиентов и счета (F-06-135…146) ───────────

  @Get('account-types')
  @Biz('finance.edit')
  listAccountTypes(@Ctx() ctx: RequestContext) {
    return this.catalog.listAccountTypes(ctx);
  }

  @Post('account-types')
  @Biz('finance.edit')
  @ZodBody(accountTypeBody)
  createAccountType(@Ctx() ctx: RequestContext, @Body(new Zod(accountTypeBody)) body: z.infer<typeof accountTypeBody>) {
    return this.catalog.createAccountType(ctx, body);
  }

  @Patch('account-types/:id')
  @Biz('finance.edit')
  @ZodBody(accountTypePatchBody)
  updateAccountType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(accountTypePatchBody)) body: z.infer<typeof accountTypePatchBody>) {
    return this.catalog.updateAccountType(ctx, id, body);
  }

  @Put('account-types/:id/archive')
  @Biz('finance.edit')
  @ZodBody(archiveBody)
  archiveAccountType(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(archiveBody)) body: z.infer<typeof archiveBody>) {
    return this.catalog.archiveAccountType(ctx, id, body.archived);
  }

  @Delete('account-types/:id')
  @Biz('finance.edit')
  async deleteAccountType(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.catalog.deleteAccountType(ctx, id);
  }

  @Get('clients/:clientId/accounts')
  @Biz('finance.edit')
  listClientAccounts(@Ctx() ctx: RequestContext, @Param('clientId') clientId: string) {
    return this.instances.listClientAccounts(ctx, clientId);
  }

  @Post('clients/:clientId/accounts')
  @Biz('finance.edit')
  openAccount(@Ctx() ctx: RequestContext, @Param('clientId') clientId: string, @Body(new Zod(openAccountBody)) body: z.infer<typeof openAccountBody>) {
    return this.instances.openAccount(ctx, body.typeId, clientId);
  }

  @Post('accounts/:id/topup')
  @HttpCode(200)
  @Biz('finance.edit')
  @ZodBody(accountOpBody)
  topupAccount(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(accountOpBody)) body: z.infer<typeof accountOpBody>) {
    return this.instances.accountOp(ctx, id, 'topup', body.amount, body.note, body.bookingId);
  }

  @Post('accounts/:id/refund')
  @HttpCode(200)
  @Biz('finance.edit')
  @ZodBody(accountOpBody)
  refundAccount(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(accountOpBody)) body: z.infer<typeof accountOpBody>) {
    return this.instances.accountOp(ctx, id, 'refund', body.amount, body.note, body.bookingId);
  }
}
