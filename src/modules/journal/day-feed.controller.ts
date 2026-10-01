import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { isLocalDate } from '../../common/time/time.js';
import { JournalAccess } from './access.js';
import { DayFeedService } from './day-feed.service.js';

/** «Лента изменений за день» журнала (⭐ рабочий день №12): кто, что и когда изменил — записи и оплаты */
@ApiTags('journal')
@Controller('v1/biz/:businessId/journal')
export class DayFeedController {
  constructor(
    private readonly feed: DayFeedService,
    private readonly access: JournalAccess,
  ) {}

  @Get('day-feed')
  @Biz('journal.view')
  @ApiOperation({ summary: 'Лента изменений журнала за день: новые, переносы, статусы, отмены, оплаты — кто и когда (новые → старые)' })
  async dayFeed(@Ctx() ctx: RequestContext, @Query('date') date?: string, @Query('businessIds') ids?: string, @Query('staffId') staffId?: string) {
    if (!isLocalDate(date)) throw new ApiError('validation', 'Invalid input', { date: 'YYYY-MM-DD' });
    const m = ctx.member!;
    // Без права видеть чужие записи — только свои, что бы ни попросили (индивидуал — сам себе салон)
    const seesOthers = m.permissions.has('journal.others') || m.kind === 'individual';
    const onlyStaffId = seesOthers ? staffId || undefined : m.staffId;
    const businessIds = seesOthers ? await this.access.businessIds(ctx, ids) : [m.businessId];
    return this.feed.dayFeed({ businessIds, date, onlyStaffId });
  }
}
