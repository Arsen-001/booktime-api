import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { Zod } from '../../common/http/validation.js';
import { isLocalDate, isLocalDateTime, localDayRangeUtc } from '../../common/time/time.js';
import { NotifyLogService } from './notify-log.service.js';
import { NotifyMailingsService } from './notify-mailings.service.js';

const channel = z.enum(['push', 'adminApp', 'email', 'sms', 'brandedApp', 'whatsapp', 'telegram']);
const mailingChannel = z.enum(['sms', 'pushOwnApp', 'pushClientApp']);
const id32 = z.string().min(1).max(32);
const audienceFilter = z
  .object({
    onlyWithApp: z.boolean().optional(),
    onlyBirthdayMonth: z.boolean().optional(),
    excludeBlocked: z.boolean().optional(),
    receivedMailing: z.object({ status: z.enum(['received', 'notReceived']), days: z.number().int().min(1).max(3650) }).optional(),
    lastVisitOlderThanDays: z.number().int().min(0).max(3650).optional(),
    serviceId: id32.optional(),
    staffId: id32.optional(),
    visitKind: z.enum(['new', 'returning']).optional(),
  })
  .strict();
const businessIds = z.array(id32).min(1).max(200);

export const oneOffBody = z.object({ clientId: id32, text: z.string().min(1).max(1000), channels: z.array(channel).min(1).max(7), source: z.enum(['clientCard', 'bookingWindow']), bookingId: id32.optional() });
export const paymentLinkSendBody = z.object({ clientId: id32, channels: z.array(channel).min(1).max(7) });
export const createMailingBody = z.object({
  businessIds,
  channel: mailingChannel,
  text: z.string().min(1).max(2000),
  audienceLabel: z.string().max(400),
  filter: audienceFilter,
  network: z.boolean().optional(),
  scheduledAt: z.string().refine(isLocalDateTime, 'YYYY-MM-DDTHH:mm').optional(),
});
export const testMailingBody = z.object({ channel: mailingChannel, text: z.string().min(1).max(2000) });
export const audienceCountBody = z.object({ businessIds, filter: audienceFilter });

/**
 * Журнал отправок, рассылки, разовое сообщение и ссылка на оплату (этап 21, лейн notify-log+mailings) —
 * /v1/biz/{b}/notify/send-log*, /notify/mailings*, /notify/one-off, /bookings/{id}/notify-payment-link.
 * Старый `GET notify/log` (сырой notify_outbox, этап 10) не тронут — это другой, технический журнал очереди.
 */
@ApiTags('notify')
@Controller('v1/biz/:businessId')
export class NotifyLogController {
  constructor(
    private readonly log: NotifyLogService,
    private readonly mailings: NotifyMailingsService,
  ) {}

  @Get('notify/send-log')
  @Biz()
  @ApiOperation({ summary: 'Журнал отправок (F-05-107/130), страница по курсору; фильтры индексированы' })
  async sendLog(
    @Ctx() ctx: RequestContext,
    @Param('businessId') businessId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channel') ch?: string,
    @Query('status') status?: string,
    @Query('typeCode') typeCode?: string,
    @Query('clientId') clientId?: string,
    @Query('bookingId') bookingId?: string,
  ) {
    // Журнал целиком — право «журнал отправок»; история одного клиента/записи (карточка, окно визита) — тем,
    // кто видит клиентов или настраивает уведомления
    const perms = ctx.member?.permissions;
    if (!perms?.has('notify.log') && !perms?.has('notify.manage') && !perms?.has('clients.view')) throw new ApiError('forbidden', 'Missing permission: notify.log');
    if (from !== undefined && !isLocalDate(from)) throw new ApiError('invalid_field', 'from: YYYY-MM-DD');
    if (to !== undefined && !isLocalDate(to)) throw new ApiError('invalid_field', 'to: YYYY-MM-DD');
    const n = limit ? Number(limit) : 100;
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new ApiError('invalid_field', 'limit: 1..500');
    const code = typeCode !== undefined ? Number(typeCode) : undefined;
    if (code !== undefined && !Number.isInteger(code)) throw new ApiError('invalid_field', 'typeCode');
    await this.mailings.processDue(businessId);
    return this.log.list(businessId, {
      limit: n,
      cursor,
      from: from ? localDayRangeUtc(from).from : undefined,
      to: to ? localDayRangeUtc(to).to : undefined,
      channel: ch,
      status,
      typeCode: code,
      clientId,
      bookingId,
    });
  }

  @Get('notify/send-log/scheduled')
  @Biz('notify.log')
  @ApiOperation({ summary: 'Ув11 «Запланировано»: что уйдёт в ближайшую неделю, раньше первым' })
  async scheduled(@Param('businessId') businessId: string) {
    const [live, mailings] = await Promise.all([this.log.listScheduled(businessId), this.mailings.scheduledLogRows(businessId)]);
    return [...live, ...mailings].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  @Post('notify/one-off')
  @Biz('clients.view')
  @ApiOperation({ summary: 'Разовое сообщение клиенту из карточки/окна записи (F-05-084/109), тип 15' })
  oneOff(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(oneOffBody)) body: z.infer<typeof oneOffBody>) {
    return this.log.sendOneOff(businessId, { ...body, staffId: ctx.member?.staffId });
  }

  @Get('bookings/:bookingId/notify-payment-link')
  @Biz('notify.manage')
  @ApiOperation({ summary: 'Ссылка на оплату визита (F-05-089): короткая ссылка на страницу записи с ?pay=1' })
  paymentLink(@Param('businessId') businessId: string, @Param('bookingId') bookingId: string) {
    return this.log.getPaymentLink(businessId, bookingId);
  }

  @Post('bookings/:bookingId/notify-payment-link/send')
  @Biz('notify.manage')
  sendPaymentLink(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Param('bookingId') bookingId: string, @Body(new Zod(paymentLinkSendBody)) body: z.infer<typeof paymentLinkSendBody>) {
    return this.log.sendPaymentLink(businessId, { bookingId, clientId: body.clientId, channels: body.channels, staffId: ctx.member?.staffId });
  }

  // ─────────── рассылки (F-05-095…099, Ув13) ───────────

  @Get('notify/mailings')
  @Biz('notify.mailings')
  listMailings(@Param('businessId') businessId: string) {
    return this.mailings.list(businessId);
  }

  @Get('notify/mailings/push-count')
  @Biz()
  @ApiOperation({ summary: 'Пушей подписчикам за 7 дней (лимит 3, F-05-095) — рассылки раздела + пуш-рассылки CRM' })
  async pushCount(@Param('businessId') businessId: string) {
    return { value: await this.mailings.countRecentAppPushes(businessId) };
  }

  @Post('notify/mailings')
  @Biz('notify.mailings')
  createMailing(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(createMailingBody)) body: z.infer<typeof createMailingBody>) {
    return this.mailings.create(businessId, ctx.member?.staffId, body);
  }

  @Post('notify/mailings/test')
  @Biz('notify.mailings')
  testMailing(@Param('businessId') businessId: string, @Body(new Zod(testMailingBody)) body: z.infer<typeof testMailingBody>) {
    return this.mailings.sendTest(businessId, body.channel, body.text);
  }

  @Post('notify/mailings/audience-count')
  @Biz('notify.mailings')
  async audienceCount(@Param('businessId') businessId: string, @Body(new Zod(audienceCountBody)) body: z.infer<typeof audienceCountBody>) {
    return { value: await this.mailings.countAudience(businessId, body.businessIds, body.filter) };
  }
}
