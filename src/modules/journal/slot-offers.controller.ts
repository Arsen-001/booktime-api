import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error.js';
import { Biz } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { PrismaService } from '../../common/prisma.service.js';
import { isLocalDate } from '../../common/time/time.js';
import { listSlotOffers, offerSlots, previewSlotOffer } from './slot-offers.js';

const target = z.object({
  staffId: z.string().min(1).max(32),
  serviceId: z.string().min(1).max(32),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  freeMin: z.number().int().min(1).max(24 * 60).optional(),
});
const previewBody = z.object({ targets: z.array(target).min(1).max(50) });
const offerBody = previewBody.extend({ channels: z.array(z.enum(['waitlist', 'hot'])).min(1).max(2) });

/** ⭐ «Найти окно → Предложить» (F-01-156, F-00-103, F-00-101) — slot-offers.ts */
@ApiTags('journal')
@Controller('v1/biz/:businessId/journal/slot-offers')
export class SlotOffersController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('preview')
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(previewBody)
  @ApiOperation({ summary: 'Кому уйдёт предложение окон: лист ожидания и подписчики (горящее — только сегодня), скидка, когда уже предлагали' })
  preview(@Param('businessId') businessId: string, @Body(new Zod(previewBody)) body: z.infer<typeof previewBody>) {
    return previewSlotOffer(this.prisma, businessId, body.targets);
  }

  @Post()
  @HttpCode(200)
  @Biz('journal.edit')
  @ZodBody(offerBody)
  @ApiOperation({ summary: 'Предложить окна: пуш / Telegram листу ожидания, горящее — подписчикам; журнал отправок и отметки «Уведомлён»' })
  offer(@Param('businessId') businessId: string, @Body(new Zod(offerBody)) body: z.infer<typeof offerBody>) {
    return offerSlots(this.prisma, businessId, body.targets, body.channels);
  }

  @Get()
  @Biz('journal.view')
  @ApiOperation({ summary: 'Когда предлагали окна дня: «staffId|HH:mm» → местное время последнего предложения' })
  async list(@Param('businessId') businessId: string, @Query('date') date?: string) {
    if (!isLocalDate(date)) throw new ApiError('validation', 'Invalid input', { date: 'YYYY-MM-DD' });
    return listSlotOffers(this.prisma, businessId, date);
  }
}
