import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { BizOnlineController } from './biz.controller.js';
import { OnlineService } from './online.service.js';
import { PublicOnlineController } from './public.controller.js';

/**
 * Этап 8: онлайн-запись и страница по ссылке (PLAN §6 №8, docs/backend/02 §3). Считает окна и создаёт записи
 * через тот же фундамент, что журнал и график (этапы 6–7): `ScheduleModule` (AvailabilityService, «замок на
 * мастера»), `JournalModule` (BookingsService.place/cancelByClient), `AuthModule` (OtpService — код без входа).
 */
@Module({
  imports: [ScheduleModule, JournalModule, AuthModule],
  controllers: [PublicOnlineController, BizOnlineController],
  providers: [OnlineService],
  exports: [OnlineService],
})
export class OnlineModule {}
