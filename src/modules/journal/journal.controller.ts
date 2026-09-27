import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { MEMBERSHIP_RESOLVER, type MembershipResolver } from '../../common/http/resolvers.js';
import { Zod } from '../../common/http/validation.js';
import { Idempotent } from '../../common/idempotency/idempotency.js';
import { isLocalDate } from '../../common/time/time.js';
import { JournalAccess, csv } from './access.js';
import { BookingsService, canJournal, clientActor, staffActor } from './bookings.service.js';
import { GroupEventsService } from './group-events.service.js';
import type { JournalArea } from './journal-settings.js';
import { JournalService } from './journal.service.js';
import {
  attachLinkedBody,
  authorBody,
  categoryBody,
  checkBody,
  checkLinkedBody,
  claimMintBody,
  clientRescheduleBody,
  configPatchBody,
  dataOpBody,
  groupEventBody,
  groupEventPatchBody,
  importBody,
  medicalCardBody,
  medicalVisitBody,
  packageBody,
  packageTransferBody,
  planBody,
  recurrenceBody,
  seriesBody,
  seriesPreviewBody,
  templateBody,
  visitIdBody,
  visitStatusBody,
  waitlistBody,
  waitlistCloseBody,
  waitlistPatchBody,
} from './journal.schemas.js';
import type { BookingStatus } from './rules.js';
import { SeriesService } from './series.service.js';

type B = { businessId: string };
const date = (v: string | undefined, name: string) => {
  if (!isLocalDate(v)) throw new ApiError('validation', 'Invalid input', { [name]: 'YYYY-MM-DD' });
  return v;
};

/** Журнал вокруг записей (02 §4, §9): /v1/biz/{b}/journal…, waitlist, events, series, packages, медкарта */
@ApiTags('journal')
@Controller('v1/biz/:businessId')
export class JournalController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly journal: JournalService,
    private readonly events: GroupEventsService,
    private readonly series: SeriesService,
    private readonly access: JournalAccess,
  ) {}

  // ─────────── настройки ───────────

  @Get('journal/config')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Настройки «Цифрового журнала», категории, свои поля, шаблоны повтора, права блоков, разметка' })
  config(@Param() p: B) {
    return this.journal.config(p.businessId);
  }

  @Patch('journal/config')
  @Biz('journal.view')
  @ZodBody(configPatchBody)
  patchConfig(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(configPatchBody)) body: z.infer<typeof configPatchBody>) {
    return this.journal.patchConfig(ctx, p.businessId, body as Partial<JournalArea>);
  }

  @Post('journal/categories')
  @Biz('journal.edit')
  @ZodBody(categoryBody)
  addCategory(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(categoryBody)) body: z.infer<typeof categoryBody>) {
    return this.journal.addCategory(ctx, p.businessId, body);
  }

  @Post('journal/recurrence-templates')
  @Biz('journal.edit')
  @ZodBody(templateBody)
  addTemplate(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(templateBody)) body: z.infer<typeof templateBody>) {
    return this.journal.addRecurrenceTemplate(ctx, p.businessId, body);
  }

  // ─────────── проверки, визит, зеркало, события ───────────

  @Post('journal/check')
  @HttpCode(200)
  @Biz('journal.view')
  @ApiOperation({ summary: 'Занято ли время человека во всех его бизнесах / экземпляр ресурса; внутри ли часов (F-01-034, F-01-215)' })
  @ZodBody(checkBody)
  check(@Param() p: B, @Body(new Zod(checkBody)) body: z.infer<typeof checkBody>) {
    return this.journal.check(p.businessId, body);
  }

  @Post('journal/visit-id')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(visitIdBody)
  visitId(@Param() p: B, @Body(new Zod(visitIdBody)) body: z.infer<typeof visitIdBody>) {
    return this.journal.visitId(p.businessId, body);
  }

  @Post('visits/:visitId/status')
  @HttpCode(200)
  @Biz('journal.edit')
  @ApiOperation({ summary: 'Статус сразу на весь визит (F-01-041)' })
  @ZodBody(visitStatusBody)
  visitStatus(@Ctx() ctx: RequestContext, @Param('visitId') visitId: string, @Body(new Zod(visitStatusBody)) body: z.infer<typeof visitStatusBody>) {
    return this.journal.syncVisitStatus(staffActor(ctx), [ctx.member!.businessId], visitId, body.status as BookingStatus, body.excludeId);
  }

  @Get('journal/mirror')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Записи, доп. данные, групповые события и пакеты за период — зеркало экранов, считающих у себя (до этапа 21)' })
  async mirror(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string, @Query('businessIds') ids?: string) {
    const businessIds = await this.access.businessIds(ctx, ids);
    return this.journal.mirror(businessIds, date(from, 'from'), date(to, 'to'));
  }

  @Get('booking-events')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Журнал событий записей (создана/статус/перенос/удалена/задерживается), старые → новые' })
  async bookingEvents(@Ctx() ctx: RequestContext, @Query() q: Record<string, string | undefined>) {
    const businessIds = await this.access.businessIds(ctx, q['businessIds']);
    return this.bookings.listEvents({
      businessIds,
      staffId: q['staffId'],
      bookingId: q['bookingId'],
      clientId: q['clientId'],
      appUserId: q['appUserId'],
      kinds: csv(q['kinds']),
      since: q['since'],
      freedOnly: q['freedOnly'] === 'true' || q['freedOnly'] === '1',
    });
  }

  // ─────────── импорт / выгрузка ───────────

  @Post('bookings-import')
  @HttpCode(200)
  @Biz('settings.manage')
  @ApiOperation({ summary: 'Импорт визитов (F-01-182): строки после разбора файла, до 5000' })
  @ZodBody(importBody)
  import(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(importBody)) body: z.infer<typeof importBody>) {
    return this.journal.importRows(ctx, p.businessId, body.locationId, body.createdBy, body.rows);
  }

  @Post('journal/data-ops')
  @HttpCode(200)
  @Biz('journal.view')
  @ZodBody(dataOpBody)
  logDataOp(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(dataOpBody)) body: z.infer<typeof dataOpBody>) {
    if (body.kind === 'export' && !ctx.member!.permissions.has('clients.export')) throw new ApiError('forbidden', 'clients.export required');
    return this.journal.logDataOp(ctx, p.businessId, body.kind, body.count);
  }

  @Get('journal/data-ops')
  @Biz('journal.view')
  dataOps(@Ctx() ctx: RequestContext, @Param() p: B) {
    return this.journal.dataOps(p.businessId, ctx.member!.staffId);
  }

  // ─────────── повтор записи из окна (F-01-100…107) ───────────

  @Post('bookings/:id/recurrence')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(recurrenceBody)
  recurrence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(recurrenceBody)) body: z.infer<typeof recurrenceBody>) {
    return this.journal.createRecurrence(ctx, [ctx.member!.businessId], id, body as never);
  }

  @Get('series/:seriesId/bookings')
  @Biz('journal.view')
  seriesBookings(@Ctx() ctx: RequestContext, @Param('seriesId') seriesId: string) {
    return this.journal.seriesBookings([ctx.member!.businessId], seriesId);
  }

  @Post('series/:seriesId/delete-bookings')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(authorBody)
  deleteSeriesBookings(@Ctx() ctx: RequestContext, @Param('seriesId') seriesId: string, @Body(new Zod(authorBody)) body: z.infer<typeof authorBody>) {
    return this.journal.deleteSeries(ctx, [ctx.member!.businessId], seriesId, body.authorName);
  }

  // ─────────── серии по правилу (F-00-064, K5) ───────────

  @Get('series')
  @Biz('journal.view')
  listSeries(@Param() p: B, @Query('staffId') staffId?: string) {
    return this.series.list(p.businessId, staffId);
  }

  @Post('series')
  @Biz('journal.edit')
  @Idempotent()
  @ApiOperation({ summary: 'Серия записей: правило + записи на 8 недель вперёд (выходной/занято — ближайший свободный день)' })
  @ZodBody(seriesBody)
  createSeries(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(seriesBody)) body: z.infer<typeof seriesBody>) {
    return this.series.create(ctx, p.businessId, body);
  }

  @Post('series/preview')
  @HttpCode(200)
  @Biz('journal.view')
  @ZodBody(seriesPreviewBody)
  previewSeries(@Body(new Zod(seriesPreviewBody)) body: z.infer<typeof seriesPreviewBody>) {
    return this.series.preview(body);
  }

  @Post('series/extend-due')
  @HttpCode(200)
  @Biz('journal.edit')
  async extendDue(@Ctx() ctx: RequestContext, @Param() p: B) {
    return { added: await this.series.extendDue(staffActor(ctx), p.businessId) };
  }

  @Get('series/:seriesId/occurrences')
  @Biz('journal.view')
  occurrences(@Ctx() ctx: RequestContext, @Param('seriesId') seriesId: string) {
    return this.series.occurrences([ctx.member!.businessId], seriesId);
  }

  @Post('series/:seriesId/extend')
  @HttpCode(200)
  @Biz('journal.edit')
  extend(@Ctx() ctx: RequestContext, @Param() p: B, @Param('seriesId') seriesId: string, @Query('ifNeeded') ifNeeded?: string) {
    return this.series.extend(staffActor(ctx), p.businessId, seriesId, ifNeeded === 'true' || ifNeeded === '1');
  }

  @Post('series/:seriesId/stop')
  @HttpCode(204)
  @Biz('journal.edit')
  stop(@Param() p: B, @Param('seriesId') seriesId: string) {
    return this.series.setActive(p.businessId, seriesId, false);
  }

  @Post('series/:seriesId/resume')
  @HttpCode(204)
  @Biz('journal.edit')
  resume(@Param() p: B, @Param('seriesId') seriesId: string) {
    return this.series.setActive(p.businessId, seriesId, true);
  }

  // ─────────── пакеты (F-01-113, 134…136, F-16-125…130) ───────────

  @Post('booking-packages')
  @Biz('journal.edit')
  @Idempotent()
  @ZodBody(packageBody)
  createPackage(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(packageBody)) body: z.infer<typeof packageBody>) {
    return this.journal.createPackage(ctx, p.businessId, body);
  }

  @Get('booking-packages/:groupId')
  @Biz('journal.view')
  getPackage(@Ctx() ctx: RequestContext, @Param('groupId') groupId: string) {
    return this.journal.getPackage([ctx.member!.businessId], groupId);
  }

  @Get('bookings/:id/package-siblings')
  @Biz('journal.view')
  siblings(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.journal.packageSiblings([ctx.member!.businessId], id);
  }

  @Post('bookings/:id/package-transfer')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(packageTransferBody)
  transfer(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(packageTransferBody)) body: z.infer<typeof packageTransferBody>) {
    return this.journal.transferPackage(ctx, [ctx.member!.businessId], id, body.deltaMin, body.authorName);
  }

  @Post('bookings/:id/package-delete')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(authorBody)
  deletePackage(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(authorBody)) body: z.infer<typeof authorBody>) {
    return this.journal.deletePackage(ctx, [ctx.member!.businessId], id, body.authorName);
  }

  @Post('booking-packages/check-linked')
  @HttpCode(200)
  @Biz('journal.view')
  @ZodBody(checkLinkedBody)
  checkLinked(@Param() p: B, @Body(new Zod(checkLinkedBody)) body: z.infer<typeof checkLinkedBody>) {
    return this.journal.checkLinked(p.businessId, body.plans);
  }

  @Post('booking-packages/attach')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(attachLinkedBody)
  attach(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(attachLinkedBody)) body: z.infer<typeof attachLinkedBody>) {
    return this.journal.attachLinked(ctx, p.businessId, body);
  }

  // ─────────── лист ожидания (F-01-156…162) ───────────

  @Get('waitlist')
  @Biz('journal.view')
  waitlist(@Param() p: B, @Query() q: Record<string, string | undefined>) {
    return this.journal.listWaitlist(p.businessId, { status: q['status'], dateMode: q['dateMode'], selectedDate: q['selectedDate'], sort: q['sort'], query: q['query'] });
  }

  @Post('waitlist')
  @Biz('journal.edit')
  @ZodBody(waitlistBody)
  addWaitlist(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(waitlistBody)) body: z.infer<typeof waitlistBody>) {
    return this.journal.createWaitlist(ctx, p.businessId, body);
  }

  @Patch('waitlist/:id')
  @Biz('journal.edit')
  @ZodBody(waitlistPatchBody)
  patchWaitlist(@Param() p: B, @Param('id') id: string, @Body(new Zod(waitlistPatchBody)) body: z.infer<typeof waitlistPatchBody>) {
    return this.journal.updateWaitlist(p.businessId, id, body);
  }

  @Post('waitlist/:id/close')
  @HttpCode(204)
  @Biz('journal.edit')
  @ZodBody(waitlistCloseBody)
  closeWaitlist(@Param() p: B, @Param('id') id: string, @Body(new Zod(waitlistCloseBody)) body: z.infer<typeof waitlistCloseBody>) {
    return this.journal.closeWaitlist(p.businessId, id, body.bookingId);
  }

  @Delete('waitlist/:id')
  @HttpCode(204)
  @Biz('journal.edit')
  deleteWaitlist(@Param() p: B, @Param('id') id: string) {
    return this.journal.deleteWaitlist(p.businessId, id);
  }

  // ─────────── групповые события (F-01-035, F-16-036…) ───────────

  @Get('events')
  @Biz('journal.view')
  async listEvents(@Ctx() ctx: RequestContext, @Query() q: Record<string, string | undefined>) {
    const businessIds = await this.access.businessIds(ctx, q['businessIds']);
    return this.events.list({ businessIds, locationId: q['locationId'], staffId: q['staffId'], serviceId: q['serviceId'], from: q['from'], to: q['to'], statuses: csv(q['statuses']) });
  }

  @Post('events')
  @Biz('journal.edit')
  @ZodBody(groupEventBody)
  createEvent(@Ctx() ctx: RequestContext, @Param() p: B, @Body(new Zod(groupEventBody)) body: z.infer<typeof groupEventBody>) {
    return this.events.create(ctx, p.businessId, body);
  }

  @Patch('events/:id')
  @Biz('journal.edit')
  @ZodBody(groupEventPatchBody)
  patchEvent(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(groupEventPatchBody)) body: z.infer<typeof groupEventPatchBody>) {
    return this.events.update(ctx, [ctx.member!.businessId], id, body);
  }

  // ─────────── медицинские сферы (F-01-189…191) ───────────

  @Get('bookings/:id/medical')
  @Biz('journal.view')
  medical(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.journal.medicalVisit([ctx.member!.businessId], id);
  }

  @Put('bookings/:id/medical')
  @Biz('journal.edit')
  @ZodBody(medicalVisitBody)
  setMedical(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(medicalVisitBody)) body: z.infer<typeof medicalVisitBody>) {
    return this.journal.setMedicalVisit([ctx.member!.businessId], id, body.patch, body.authorName);
  }

  @Get('clients/:clientId/medical-card')
  @Biz('clients.view')
  card(@Param() p: B, @Param('clientId') clientId: string) {
    return this.journal.medicalCard(p.businessId, clientId);
  }

  @Put('clients/:clientId/medical-card')
  @Biz('clients.view')
  @ZodBody(medicalCardBody)
  setCard(@Param() p: B, @Param('clientId') clientId: string, @Body(new Zod(medicalCardBody)) body: z.infer<typeof medicalCardBody>) {
    return this.journal.setMedicalCard(p.businessId, clientId, body);
  }

  @Get('clients/:clientId/treatment-plans')
  @Biz('clients.view')
  plans(@Param() p: B, @Param('clientId') clientId: string) {
    return this.journal.listPlans(p.businessId, clientId);
  }

  @Post('clients/:clientId/treatment-plans')
  @Biz('clients.view')
  @ZodBody(planBody)
  addPlan(@Param() p: B, @Param('clientId') clientId: string, @Body(new Zod(planBody)) body: z.infer<typeof planBody>) {
    return this.journal.addPlan(p.businessId, clientId, body);
  }

  @Post('clients/:clientId/treatment-plans/refresh-prices')
  @HttpCode(204)
  @Biz('clients.view')
  refreshPlans(@Param() p: B, @Param('clientId') clientId: string) {
    return this.journal.refreshPlanPrices(p.businessId, clientId);
  }

  @Post('clients/:clientId/treatment-plans/:planId/duplicate')
  @HttpCode(200)
  @Biz('clients.view')
  duplicatePlan(@Param() p: B, @Param('clientId') clientId: string, @Param('planId') planId: string) {
    return this.journal.duplicatePlan(p.businessId, clientId, planId);
  }

  @Delete('clients/:clientId/treatment-plans/:planId')
  @HttpCode(204)
  @Biz('clients.view')
  deletePlan(@Param() p: B, @Param('clientId') clientId: string, @Param('planId') planId: string) {
    return this.journal.deletePlan(p.businessId, clientId, planId);
  }

  // ─────────── «Закрыть окно» (F-00-107): выдать ссылку на окно мастера ───────────

  @Post('claims')
  @HttpCode(200)
  @Biz('journal.view')
  @ZodBody(claimMintBody)
  async mintClaim(@Param() p: B, @Body(new Zod(claimMintBody)) body: z.infer<typeof claimMintBody>) {
    return { token: await this.journal.mintClaim({ ...body, businessId: p.businessId }) };
  }
}

/**
 * Ссылка «Закрыть окно» из переписки (F-00-107): /v1/claims/{token}. Срабатывает только для вошедшего мастера этого
 * окна (или того, кто вправе записывать за него — journal.create на этого мастера); остальным — ничего о самом окне.
 */
@ApiTags('journal')
@Controller('v1/claims')
@Authed()
export class ClaimsController {
  constructor(
    private readonly bookings: BookingsService,
    @Inject(MEMBERSHIP_RESOLVER) private readonly memberships: MembershipResolver,
  ) {}

  private async actorFor(ctx: RequestContext, token: string) {
    const claim = await this.bookings.prisma.slotClaim.findUnique({ where: { token } });
    if (!claim || !ctx.session) return { claim: null, member: null };
    const member = await this.memberships.resolve(ctx.session, claim.businessId);
    if (!member) return { claim, member: null };
    const c = { ...ctx, member };
    return { claim, member: canJournal(c, 'journal.create', claim.staffId) ? c : null };
  }

  @Get(':token')
  @ApiOperation({ summary: 'Карточка ссылки: ready | wrong_actor | expired | used | taken' })
  async get(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    const { claim, member } = await this.actorFor(ctx, token);
    if (!claim || !member) return { status: 'wrong_actor' };
    const [staff, business, service] = await Promise.all([
      this.bookings.prisma.staff.findUnique({ where: { id: claim.staffId }, select: { name: true } }),
      this.bookings.prisma.business.findUnique({ where: { id: claim.businessId }, select: { name: true } }),
      claim.serviceId ? this.bookings.prisma.service.findUnique({ where: { id: claim.serviceId }, select: { name: true, durationMin: true, durationMax: true } }) : null,
    ]);
    const shared = { start: claim.startLocal, staffName: staff?.name, businessName: business?.name, serviceName: service?.name };
    if (claim.status === 'used') return { status: 'used', ...shared, usedBookingId: claim.usedBookingId };
    if (claim.startAt.getTime() < Date.now() || Date.now() - claim.createdAt.getTime() >= 7 * 86_400_000) return { status: 'expired', ...shared };
    const duration = service ? Math.max(service.durationMin, service.durationMax ?? 0) : 30;
    const staffRow = await this.bookings.prisma.staff.findUnique({ where: { id: claim.staffId }, select: { id: true, userId: true } });
    const busy = staffRow
      ? await this.bookings.prisma.busyBlock.count({
          where: { personKey: staffRow.userId ?? staffRow.id, active: true, source: { not: 'mark_busy' }, startAt: { lt: new Date(claim.startAt.getTime() + duration * 60_000) }, endAt: { gt: claim.startAt } },
        })
      : 0;
    if (busy) return { status: 'taken', ...shared };
    return { status: 'ready', ...shared, clientName: claim.clientName ?? undefined, clientPhone: claim.clientPhone ?? undefined };
  }

  @Post(':token/close')
  @HttpCode(200)
  @ApiOperation({ summary: '«Закрыть окно»: запись по единому потоку (source phone) — только мастер этого окна' })
  async close(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    const { claim, member } = await this.actorFor(ctx, token);
    if (!claim) throw new ApiError('not_found', 'Claim not found');
    if (!member) throw new ApiError('forbidden', 'Not the master of this slot');
    if (claim.status === 'used') throw new ApiError('already_used', 'Already used');
    if (claim.startAt.getTime() < Date.now() || Date.now() - claim.createdAt.getTime() >= 7 * 86_400_000) throw new ApiError('expired', 'Claim expired');
    const res = await this.bookings.place(staffActor(member), {
      source: 'phone',
      businessId: claim.businessId,
      staffId: claim.staffId,
      start: claim.startLocal,
      services: claim.serviceId ? [{ serviceId: claim.serviceId }] : [],
      client: claim.clientPhone ? { phone: claim.clientPhone, name: claim.clientName ?? undefined } : undefined,
      staffAssignment: 'specific',
    });
    await this.bookings.prisma.slotClaim.update({ where: { token }, data: { status: 'used', usedBookingId: res.booking.id } });
    return { bookingId: res.booking.id };
  }
}

/** Клиент со своей записью (02 §2.2): отмена, перенос, подтверждение, «Я оплатил», лента событий. Только свои записи. */
@ApiTags('journal')
@Controller('v1/me')
@Authed()
export class MeBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отмена клиентом (В-04): позже срока — «поздно» и +1 неявка у этого бизнеса' })
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.bookings.cancelByClient(clientActor(ctx), id, { appUserId: ctx.session!.userId });
  }

  @Post('bookings/:id/reschedule')
  @HttpCode(200)
  @ZodBody(clientRescheduleBody)
  reschedule(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new Zod(clientRescheduleBody)) body: z.infer<typeof clientRescheduleBody>) {
    return this.bookings.rescheduleByClient(clientActor(ctx), id, body.start, { appUserId: ctx.session!.userId });
  }

  @Post('bookings/:id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.bookings.confirmByClient(clientActor(ctx), id, ctx.session!.userId);
  }

  @Post('bookings/:id/paid')
  @HttpCode(200)
  paid(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.bookings.markPaidByClient(ctx.session!.userId, id);
  }

  @Get('booking-events')
  @ApiOperation({ summary: 'Лента событий моих записей (новые → старые), кроме моих собственных действий' })
  async events(@Ctx() ctx: RequestContext, @Query('since') since?: string, @Query('kinds') kinds?: string) {
    const rows = await this.bookings.listEvents({ appUserId: ctx.session!.userId, since, kinds: kinds ? csv(kinds) : ['created', 'status', 'moved', 'deleted', 'delayed'], excludeBy: 'client' });
    return rows.reverse();
  }
}
