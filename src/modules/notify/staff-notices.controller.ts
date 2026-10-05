import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Biz } from '../../common/http/guards.js';
import { PrismaService } from '../../common/prisma.service.js';
import { requestReminderTimes } from '../../jobs/notify-staff-request-reminders.js';

/** Пуши персоналу (staff-notices.ts) — то, что из них видно в кабинете */
@ApiTags('notify')
@Controller('v1/biz/:businessId')
export class StaffNoticesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('notify/request-reminders')
  @Biz('journal.view')
  @ApiOperation({ summary: '«напомнили в HH:MM» по заявкам (F-00-067): bookingId → когда последний раз напомнили мастеру' })
  requestReminders(@Param('businessId') businessId: string): Promise<Record<string, string>> {
    return requestReminderTimes(this.prisma, businessId);
  }
}
