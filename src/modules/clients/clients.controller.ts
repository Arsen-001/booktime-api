import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { attachmentDisposition, MAX_DOCUMENT_BYTES } from '../uploads/document.js';
import { requestBase } from '../uploads/uploads.controller.js';
import { z } from 'zod';
import type { RequestContext, RequestWithContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { ifMatch } from '../../common/http/version.js';
import {
  addCommentBody,
  addCustomFieldDefBody,
  addFileBody,
  adConsentBody,
  autoSaveChatLeadsBody,
  bookingWindowFavoriteBody,
  bulkCategoryBody,
  bulkIdsBody,
  bulkTextBody,
  bookingWindowMessageBody,
  consentFormBody,
  messageLogQuery,
  categoryUpsertBody,
  changeLogEntryOut,
  clientListPageOut,
  clientRowOut,
  columnsPrefsOut,
  categoryOut,
  commentOut,
  countMatchingBody,
  createClientBody,
  exportClientsBody,
  exportLogEntryOut,
  fileOut,
  fineRightsBody,
  importRowResultOut,
  importRunOut,
  lostAfterDaysBody,
  mergeBody,
  runImportBody,
  searchBody,
  setColumnsBody,
  showFullNameBody,
  showLoyaltySearchBody,
  togglePinBody,
  updateClientBody,
} from './clients.schemas.js';
import { ClientsService } from './clients.service.js';
import { ClientsExtrasService } from './clients-extras.service.js';
import { ClientsImportExportService } from './clients-import-export.service.js';
import { ClientsBroadcastService } from './clients-broadcast.service.js';

const noteBody = z.object({ note: z.string().max(2000) });

/** Клиенты / CRM — /v1/biz (docs/backend/01 §5, 02 §6, PLAN §6 №5) */
@ApiTags('clients')
@Controller('v1/biz/:businessId')
export class ClientsController {
  constructor(
    private readonly svc: ClientsService,
    private readonly extras: ClientsExtrasService,
    private readonly importExport: ClientsImportExportService,
    private readonly broadcast: ClientsBroadcastService,
  ) {}

  // ─────────── список / поиск (K8: фильтр и подсчёт — на сервере) ───────────

  @Post('clients/search')
  @Biz('clients.view')
  @ZodBody(searchBody)
  @ZodOk(clientListPageOut)
  search(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(searchBody)) body: z.infer<typeof searchBody>) {
    return this.svc.search(ctx, businessId, body);
  }

  @Get('clients')
  @Biz('clients.view')
  @ZodOk(z.array(clientRowOut))
  @ApiOperation({ summary: 'Все клиенты бизнеса строками (окно записи, импорт, объединение)' })
  listRows(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.svc.listRows(ctx, businessId);
  }

  @Post('clients/count-matching')
  @Biz('clients.view')
  @ZodBody(countMatchingBody)
  countMatching(@Param('businessId') businessId: string, @Body(new Zod(countMatchingBody)) body: z.infer<typeof countMatchingBody>) {
    return this.svc.countMatching(businessId, body).then((count) => ({ count }));
  }

  // ─────────── колонки (F-04-004/005, регистрируются раньше /clients/:id) ───────────

  @Get('clients/columns')
  @Biz('clients.view')
  @ZodOk(columnsPrefsOut)
  getColumns(@Param('businessId') businessId: string, @Query('staffId') staffId?: string) {
    return this.extras.getColumnsPrefs(businessId, staffId);
  }

  @Put('clients/columns')
  @Biz('clients.view')
  @ZodBody(setColumnsBody)
  @ZodOk(columnsPrefsOut)
  setColumns(@Param('businessId') businessId: string, @Body(new Zod(setColumnsBody)) body: z.infer<typeof setColumnsBody>) {
    return this.extras.setVisibleColumns(businessId, body.staffId, body.visible);
  }

  @Put('clients/columns/pin')
  @Biz('clients.view')
  @ZodBody(togglePinBody)
  @ZodOk(columnsPrefsOut)
  togglePin(@Param('businessId') businessId: string, @Body(new Zod(togglePinBody)) body: z.infer<typeof togglePinBody>) {
    return this.extras.togglePinnedColumn(businessId, body.staffId, body.id);
  }

  // ─────────── категории (F-04-109/110) ───────────

  @Get('client-categories')
  @Biz('clients.view')
  @ZodOk(z.array(categoryOut))
  listCategories(@Param('businessId') businessId: string) {
    return this.svc.listCategories(businessId);
  }

  @Get('client-categories/options')
  @Biz('clients.view')
  listCategoryOptions(@Param('businessId') businessId: string) {
    return this.svc.listCategoryOptions(businessId);
  }

  @Post('client-categories')
  @Biz('settings.manage')
  @ZodBody(categoryUpsertBody)
  createCategory(@Param('businessId') businessId: string, @Body(new Zod(categoryUpsertBody)) body: z.infer<typeof categoryUpsertBody>) {
    return this.svc.createCategory(businessId, body.name, body.color);
  }

  @Patch('client-categories/:name')
  @Biz('settings.manage')
  @ZodBody(categoryUpsertBody)
  updateCategory(@Param('businessId') businessId: string, @Param('name') name: string, @Body(new Zod(categoryUpsertBody)) body: z.infer<typeof categoryUpsertBody>) {
    return this.svc.updateCategory(businessId, decodeURIComponent(name), body);
  }

  @Delete('client-categories/:name')
  @Biz('settings.manage')
  deleteCategory(@Param('businessId') businessId: string, @Param('name') name: string) {
    return this.svc.deleteCategory(businessId, decodeURIComponent(name));
  }

  @Get('clients/changelog')
  @Biz('clients.view')
  @ZodOk(z.array(changeLogEntryOut))
  changeLogAll(@Param('businessId') businessId: string) {
    return this.svc.changeLog(businessId);
  }

  @Get('clients/settings')
  @Biz('clients.view')
  getSettings(@Param('businessId') businessId: string) {
    return this.extras.getSettings(businessId);
  }

  @Get('clients/import-runs')
  @Biz('settings.manage')
  @ZodOk(z.array(importRunOut))
  listImportRuns(@Param('businessId') businessId: string) {
    return this.importExport.listImportRuns(businessId);
  }

  @Get('clients/export-log')
  @Biz('clients.export')
  @ZodOk(z.array(exportLogEntryOut))
  listExportLog(@Param('businessId') businessId: string) {
    return this.importExport.listExportLog(businessId);
  }

  // ─────────── карточка (F-04-044…074) ───────────

  @Post('clients')
  @Biz('clients.edit')
  @ZodBody(createClientBody)
  @ZodOk(clientRowOut)
  createClient(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createClientBody)) body: z.infer<typeof createClientBody>) {
    return this.svc.createClient(ctx, businessId, body);
  }

  @Get('clients/:id')
  @Biz('clients.view')
  @ZodOk(clientRowOut)
  getRow(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Query('locationIds') locationIds?: string,
    @Query('onlyStaffId') onlyStaffId?: string,
  ) {
    return this.svc.getRow(ctx, businessId, id, locationIds ? locationIds.split(',') : undefined, onlyStaffId);
  }

  @Patch('clients/:id')
  @Biz('clients.edit')
  @ZodBody(updateClientBody)
  @ZodOk(clientRowOut)
  updateClient(
    @Ctx() ctx: RequestContext,
    @Req() req: RequestWithContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(updateClientBody)) body: z.infer<typeof updateClientBody>,
  ) {
    return this.svc.updateClient(ctx, businessId, id, body, ifMatch(req));
  }

  @Patch('clients/:id/note')
  @Biz('clients.edit')
  @ZodBody(noteBody)
  updateNote(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(noteBody)) body: z.infer<typeof noteBody>) {
    return this.svc.updateNote(businessId, id, body.note);
  }

  @Delete('clients/:id')
  @Biz('clients.delete')
  deleteClient(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.deleteClient(ctx, businessId, id);
  }

  @Post('clients/:id/anonymize')
  @Biz('clients.delete')
  @ApiOperation({ summary: 'P11: обезличивание по требованию клиента (GDPR) — навсегда, право как у удаления' })
  purge(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.purgeClientData(ctx, businessId, id);
  }

  @Get('clients/:id/fields')
  @Biz('clients.view')
  getCustomFieldValues(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.getCustomFieldValues(businessId, id);
  }

  @Get('clients/:id/changelog')
  @Biz('clients.view')
  @ZodOk(z.array(changeLogEntryOut))
  changeLogOne(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.svc.changeLog(businessId, id);
  }

  // ─────────── дубли: объединение и массовое удаление (F-04-135…137, F-04-042) ───────────

  @Post('clients/merge')
  @Biz('clients.edit')
  @ZodBody(mergeBody)
  merge(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(mergeBody)) body: z.infer<typeof mergeBody>) {
    return this.svc.mergeClients(ctx, businessId, body.keepId, body.duplicateId);
  }

  @Post('clients/bulk-delete')
  @Biz('clients.delete')
  @ZodBody(bulkIdsBody)
  bulkDelete(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(bulkIdsBody)) body: z.infer<typeof bulkIdsBody>) {
    return this.svc.bulkDeleteClients(ctx, businessId, body.clientIds);
  }

  @Post('clients/bulk-category')
  @Biz('clients.edit')
  @ZodBody(bulkCategoryBody)
  bulkCategory(@Param('businessId') businessId: string, @Body(new Zod(bulkCategoryBody)) body: z.infer<typeof bulkCategoryBody>) {
    return this.svc.bulkAddCategory(businessId, body.clientIds, body.category, body.color);
  }

  // ─────────── комментарии (F-04-070) ───────────

  @Get('clients/:id/comments')
  @Biz('clients.view')
  @ZodOk(z.array(commentOut))
  listComments(@Param('id') id: string) {
    return this.extras.listComments(id);
  }

  @Post('clients/:id/comments')
  @Biz('clients.edit')
  @ZodBody(addCommentBody)
  @ZodOk(commentOut)
  addComment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(addCommentBody)) body: z.infer<typeof addCommentBody>) {
    return this.extras.addComment(ctx, id, body.text);
  }

  @Delete('clients/:id/comments/:commentId')
  @Biz('clients.edit')
  deleteComment(@Param('id') id: string, @Param('commentId') commentId: string) {
    return this.extras.deleteComment(id, commentId);
  }

  // ─────────── файлы (F-04-086) ───────────

  @Get('clients/:id/files')
  @Biz('clients.view')
  @ZodOk(z.array(fileOut))
  listFiles(@Param('businessId') businessId: string, @Param('id') id: string, @Req() req: Request) {
    return this.extras.listFiles(businessId, id, requestBase(req));
  }

  @Post('clients/:id/files')
  @Biz('clients.edit')
  @ZodBody(addFileBody)
  @ZodOk(fileOut)
  @ApiOperation({ summary: 'Документ data: URL в JSON (прежние сборки сайта); новый сайт — POST …/files/upload файлом' })
  addFile(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Body(new Zod(addFileBody)) body: z.infer<typeof addFileBody>,
    @Req() req: Request,
  ) {
    return this.extras.addFile(ctx, businessId, id, body, requestBase(req));
  }

  @Post('clients/:id/files/upload')
  @Biz('clients.edit')
  @RateLimit({ bucket: 'uploads', limit: 60, windowSec: 600, by: 'session' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 4, parts: 6 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, name: { type: 'string', description: 'Имя файла (по умолчанию — из multipart)' } } },
  })
  @ZodOk(fileOut)
  @ApiOperation({
    summary:
      'Документ клиента файлом (04.10.2026): PDF / JPEG / PNG / GIF / WebP / Word / Excel / текст до 10 МБ, тип по сигнатуре, ' +
      'без перекодирования, в закрытое хранилище. Ошибки: file_required 422, file_too_large 413, unsupported_file 415, bad_ext 422, upload_quota 422',
  })
  uploadFile(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() body: { name?: unknown } | undefined,
    @Req() req: Request,
  ) {
    return this.extras.uploadFile(ctx, businessId, id, file, typeof body?.name === 'string' ? body.name : undefined, requestBase(req));
  }

  @Get('clients/:id/files/:fileId/content')
  @Biz('clients.view')
  @ApiOperation({
    summary:
      'Скачать документ клиента (cookie сессии, право clients.view): Content-Disposition: attachment, nosniff, без кэша. ' +
      'Работает и для старых строк с data: URL',
  })
  async fileContent(
    @Param('businessId') businessId: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    const f = await this.extras.fileContent(businessId, id, fileId);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.body.length));
    res.setHeader('Content-Disposition', attachmentDisposition(f.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Сайт (booktime.am) показывает фото визита <img> с api.booktime.am — тот же сайт (site), чужим нельзя
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.status(200).end(f.body);
  }

  @Delete('clients/:id/files/:fileId')
  @Biz('clients.edit')
  deleteFile(@Param('businessId') businessId: string, @Param('id') id: string, @Param('fileId') fileId: string) {
    return this.extras.deleteFile(businessId, id, fileId);
  }

  // ─────────── приложение клиента (F-04-072, F-00-130) ───────────

  @Get('clients/:id/app')
  @Biz('clients.view')
  async getAppActivity(@Param('businessId') businessId: string, @Param('id') id: string) {
    const phone = await this.svc.getPhone(businessId, id);
    if (!phone) return null;
    return this.extras.getAppActivity(phone);
  }

  @Get('clients/:id/invited-at')
  @Biz('clients.view')
  getInvitedAt(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.extras.getInvitedAt(businessId, id);
  }

  @Post('clients/:id/invite')
  @Biz('clients.view')
  @ApiOperation({ summary: 'Приглашение из CRM в приложение (F-00-130) — ссылка для WhatsApp мастера, само сообщение шлёт этап 10' })
  invite(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.extras.inviteToApp(businessId, id);
  }

  // ─────────── согласие на рекламу (F-04-153/227) ───────────

  @Post('clients/:id/consent')
  @Biz('clients.edit')
  @ZodBody(adConsentBody)
  recordConsent(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(adConsentBody)) body: z.infer<typeof adConsentBody>) {
    return this.extras.recordAdConsent(businessId, id, body.given, body.method);
  }

  /**
   * F-04-154: анкета клиента (имя, день рождения, согласие на рекламу). Экран открывается в кабинете бизнеса
   * (мастер даёт клиенту планшет) — поэтому под сессией бизнеса, а не публичный маршрут по одному clientId
   * (решение этапа 21: публичная запись в чужие данные без токена небезопасна, см. PROGRESS «Вопросы владельцу»).
   */
  @Post('clients/:id/consent-form')
  @Biz('clients.view')
  @ZodBody(consentFormBody)
  @ApiOperation({ summary: 'Анкета клиента по ссылке мастера: имя/ДР/согласие (F-04-154)' })
  submitConsentForm(@Param('businessId') businessId: string, @Param('id') id: string, @Body(new Zod(consentFormBody)) body: z.infer<typeof consentFormBody>) {
    return this.extras.submitConsentFormFor(businessId, id, body);
  }

  // ─────────── рассылки CRM, журнал сообщений (F-04-038…040, F-04-100) ───────────

  @Post('clients/bulk/audience')
  @Biz('clients.view')
  @ZodBody(bulkIdsBody)
  @ApiOperation({ summary: 'Кому уйдёт рассылка из выбранных: sms / push (F-04-227)' })
  bulkAudience(@Param('businessId') businessId: string, @Body(new Zod(bulkIdsBody)) body: z.infer<typeof bulkIdsBody>) {
    return this.broadcast.audience(businessId, body.clientIds);
  }

  @Post('clients/bulk/sms')
  @Biz('notify.mailings')
  @ZodBody(bulkTextBody)
  @ApiOperation({ summary: 'SMS группе клиентов через провайдера бизнеса (F-04-038, В-08)' })
  async bulkSms(@Param('businessId') businessId: string, @Body(new Zod(bulkTextBody)) body: z.infer<typeof bulkTextBody>) {
    return { sent: await this.broadcast.sendMessage(businessId, body.clientIds, body.text) };
  }

  @Post('clients/bulk/push')
  @Biz('notify.mailings')
  @ZodBody(bulkTextBody)
  @ApiOperation({ summary: 'Пуш группе клиентов с приложением, недельный лимит (F-04-039/040)' })
  async bulkPush(@Param('businessId') businessId: string, @Body(new Zod(bulkTextBody)) body: z.infer<typeof bulkTextBody>) {
    return { sent: await this.broadcast.sendPush(businessId, body.clientIds, body.text) };
  }

  @Get('client-messages')
  @Biz('clients.view')
  @ApiOperation({ summary: 'Журнал сообщений CRM за период (F-04-038 «видно в отчёте»)' })
  messageLog(@Param('businessId') businessId: string, @Query(new Zod(messageLogQuery)) q: z.infer<typeof messageLogQuery>) {
    return this.broadcast.listLog(businessId, q.from, q.to);
  }

  @Get('clients/:id/messages')
  @Biz('clients.view')
  @ApiOperation({ summary: 'История сообщений клиенту (F-04-100)' })
  clientMessages(@Param('businessId') businessId: string, @Param('id') id: string) {
    return this.broadcast.listClientLogFor(businessId, id);
  }

  @Post('clients/booking-window-message')
  @Biz('clients.view')
  @ZodBody(bookingWindowMessageBody)
  @ApiOperation({ summary: 'Разовое сообщение клиенту из окна записи: пуш или WhatsApp мастера (F-04-100)' })
  async bookingWindowMessage(@Param('businessId') businessId: string, @Body(new Zod(bookingWindowMessageBody)) body: z.infer<typeof bookingWindowMessageBody>) {
    await this.broadcast.sendBookingWindowMessage(businessId, body.clientId, body.text, body.channel);
    return { ok: true };
  }

  // ─────────── доп. поля (F-04-060, 139…145) ───────────

  @Get('client-fields')
  @Biz('clients.view')
  listCustomFieldDefs(@Param('businessId') businessId: string) {
    return this.extras.listCustomFieldDefs(businessId);
  }

  @Post('client-fields')
  @Biz('settings.manage')
  @ZodBody(addCustomFieldDefBody)
  addCustomFieldDef(@Param('businessId') businessId: string, @Body(new Zod(addCustomFieldDefBody)) body: z.infer<typeof addCustomFieldDefBody>) {
    return this.extras.addCustomFieldDef(businessId, body);
  }

  @Delete('client-fields/:fieldId')
  @Biz('settings.manage')
  deleteCustomFieldDef(@Param('businessId') businessId: string, @Param('fieldId') fieldId: string) {
    return this.extras.deleteCustomFieldDef(businessId, fieldId);
  }

  // ─────────── настройки базы (arch-a1 №2) ───────────

  @Put('clients/settings/show-full-name')
  @Biz('settings.manage')
  @ZodBody(showFullNameBody)
  setShowFullName(@Param('businessId') businessId: string, @Body(new Zod(showFullNameBody)) body: z.infer<typeof showFullNameBody>) {
    return this.extras.setShowFullNameFields(businessId, body.value);
  }

  @Put('clients/settings/show-loyalty-search')
  @Biz('settings.manage')
  @ZodBody(showLoyaltySearchBody)
  setShowLoyaltySearch(@Param('businessId') businessId: string, @Body(new Zod(showLoyaltySearchBody)) body: z.infer<typeof showLoyaltySearchBody>) {
    return this.extras.setShowLoyaltySearchInBookingWindow(businessId, body.value);
  }

  @Put('clients/settings/auto-save-chat-leads')
  @Biz('settings.manage')
  @ZodBody(autoSaveChatLeadsBody)
  setAutoSaveChatLeads(@Param('businessId') businessId: string, @Body(new Zod(autoSaveChatLeadsBody)) body: z.infer<typeof autoSaveChatLeadsBody>) {
    return this.extras.setAutoSaveChatLeads(businessId, body.value);
  }

  @Put('clients/settings/lost-after-days')
  @Biz('settings.manage')
  @ZodBody(lostAfterDaysBody)
  setLostAfterDays(@Param('businessId') businessId: string, @Body(new Zod(lostAfterDaysBody)) body: z.infer<typeof lostAfterDaysBody>) {
    return this.extras.setLostAfterDays(businessId, body.days);
  }

  @Put('clients/settings/booking-window-favorites/toggle')
  @Biz('clients.view')
  @ApiOperation({ summary: '«⋯ Ещё» в окне записи (F-04-093) — закрепить/открепить плитку, общее на бизнес' })
  @ZodBody(bookingWindowFavoriteBody)
  toggleBookingWindowFavorite(@Param('businessId') businessId: string, @Body(new Zod(bookingWindowFavoriteBody)) body: z.infer<typeof bookingWindowFavoriteBody>) {
    return this.extras.toggleBookingWindowFavorite(businessId, body.section);
  }

  @Post('clients/simulate-chat-lead')
  @Biz('clients.edit')
  @ApiOperation({ summary: 'Демонстрационная кнопка F-04-016/187: что сделает хук чата при автосохранении лидов' })
  simulateChatLead(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.extras.simulateChatLead(ctx, businessId).then((c) => ({ id: c.id, businessId: c.businessId, name: c.name, phone: c.phone }));
  }

  // ─────────── тонкие права «Клиентская база» (F-04-194…204) ───────────

  @Get('staff/:staffId/client-fine-rights')
  @Biz('staff.manage')
  getFineRights(@Param('staffId') staffId: string) {
    return this.extras.getFineRights(staffId);
  }

  @Put('staff/:staffId/client-fine-rights')
  @Biz('staff.manage')
  @ZodBody(fineRightsBody)
  setFineRights(@Param('businessId') businessId: string, @Param('staffId') staffId: string, @Body(new Zod(fineRightsBody)) body: z.infer<typeof fineRightsBody>) {
    return this.extras.setFineRights(businessId, staffId, body);
  }

  // ─────────── импорт (F-04-126…129) ───────────

  @Post('clients/import')
  @Biz('settings.manage')
  @ZodBody(runImportBody)
  @ApiOperation({ summary: 'Импорт из Excel/CSV — до 500 строк, разбор текста делает экран (parseImportText)' })
  runImport(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(runImportBody)) body: z.infer<typeof runImportBody>) {
    return this.importExport.runImport(ctx, businessId, body.authorName, body.mapping, body.rows, body.method).then((r) => ({
      results: r.results as unknown as z.infer<typeof importRowResultOut>[],
      summary: r.summary,
    }));
  }

  // ─────────── выгрузка (F-04-130, P4) ───────────

  @Post('clients/export')
  @Biz('clients.export')
  @ZodBody(exportClientsBody)
  @ZodOk(z.array(clientRowOut))
  exportClients(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(exportClientsBody)) body: z.infer<typeof exportClientsBody>) {
    return this.importExport.exportClients(ctx, businessId, body.ids, body.authorName, body.fileName);
  }
}
