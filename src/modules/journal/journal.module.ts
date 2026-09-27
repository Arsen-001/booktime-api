import { Module } from '@nestjs/common';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { JournalAccess } from './access.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { GroupEventsService } from './group-events.service.js';
import { JournalSettingsService } from './journal-settings.js';
import { ClaimsController, JournalController, MeBookingsController, PublicClaimsController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { SeriesService } from './series.service.js';

/** Этап 7: журнал и записи (PLAN §6 №7) — записи, статусы, удержание окна, серии, групповые, лист ожидания, F-00-107.
 * `LoyaltyModule` — этап 11: «Клиент пришёл» / «Не пришёл» пересчитывают программу лояльности локации
 * (F-04-121, см. `BookingsService.changeStatus`), поэтому журналу нужен `LoyaltyProgramService`. */
@Module({
  imports: [ScheduleModule, LoyaltyModule],
  controllers: [BookingsController, JournalController, ClaimsController, MeBookingsController, PublicClaimsController],
  providers: [BookingsService, JournalService, GroupEventsService, SeriesService, JournalSettingsService, JournalAccess],
  exports: [BookingsService, JournalService, JournalSettingsService],
})
export class JournalModule {}
