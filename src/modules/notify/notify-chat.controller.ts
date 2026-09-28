import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { JournalModule } from '../journal/journal.module.js';
import { NotifyChatService } from './notify-chat.service.js';

const sendBody = z.object({ phone: z.string().min(1).max(20), clientId: z.string().max(32).optional(), text: z.string().max(4000), attachmentName: z.string().max(200).optional() });
const incomingBody = z.object({ phone: z.string().min(1).max(20), clientId: z.string().max(32).optional(), text: z.string().max(4000) });
const agentBody = z.object({ clientPhone: z.string().max(40), sendToClient: z.boolean() });

/** Этап 21 (сдача, попытка 6): чат через партнёра и демо-кнопки «Уведомлений» — /v1/biz/{b}/notify/chat|… */
@ApiTags('notify')
@Controller('v1/biz/:businessId/notify')
export class NotifyChatController {
  constructor(private readonly svc: NotifyChatService) {}

  @Get('chat/unread')
  @Biz('clients.view')
  unread(@Param('businessId') businessId: string) {
    return this.svc.unread(businessId).then((count) => ({ count }));
  }

  @Post('chat/unread/clear')
  @Biz('clients.view')
  clear(@Param('businessId') businessId: string) {
    return this.svc.clearUnread(businessId).then(() => ({ ok: true }));
  }

  @Get('chat/messages')
  @Biz('clients.view')
  list(@Param('businessId') businessId: string, @Query('phone') phone: string) {
    return this.svc.list(businessId, phone ?? '');
  }

  @Post('chat/messages')
  @Biz('clients.view')
  @ZodBody(sendBody)
  send(@Param('businessId') businessId: string, @Body(new Zod(sendBody)) body: z.infer<typeof sendBody>) {
    return this.svc.send(businessId, body);
  }

  @Post('chat/simulate-incoming')
  @Biz('clients.view')
  @ZodBody(incomingBody)
  incoming(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(incomingBody)) body: z.infer<typeof incomingBody>) {
    return this.svc.simulateIncoming(ctx, businessId, body);
  }

  @Post('chat/simulate-partner-confirm')
  @Biz('notify.manage')
  partnerConfirm(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.svc.simulatePartnerConfirm(ctx, businessId);
  }

  @Post('whatsapp/test-message')
  @Biz('notify.manage')
  testWhatsApp(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.svc.sendTestWhatsApp(ctx, businessId);
  }

  @Post('agent/simulate-booking')
  @Biz('notify.manage')
  @ZodBody(agentBody)
  agentBooking(@Param('businessId') businessId: string, @Body(new Zod(agentBody)) body: z.infer<typeof agentBody>) {
    return this.svc.simulateAgentBooking(businessId, body);
  }
}

/** Отдельный модуль: чату нужен BookingsService (JournalModule), а NotifyModule журнал не импортирует */
@Module({
  imports: [JournalModule],
  controllers: [NotifyChatController],
  providers: [NotifyChatService],
})
export class NotifyChatModule {}
