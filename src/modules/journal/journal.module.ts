import { SlotOffersController } from './slot-offers.controller.js';
import { Module } from '@nestjs/common';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { StockModule } from '../stock/stock.module.js';
import { JournalAccess } from './access.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { DayFeedController } from './day-feed.controller.js';
import { DayFeedService } from './day-feed.service.js';
import { GroupEventsService } from './group-events.service.js';
import { JournalSettingsService } from './journal-settings.js';
import { ClaimsController, JournalController, MeBookingsController, PublicClaimsController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { SeriesService } from './series.service.js';
import { UpsellController } from './upsell.controller.js';
import { UpsellService } from './upsell.service.js';

/** Этап 7: журнал и записи (PLAN §6 №7) — записи, статусы, удержание окна, серии, групповые, лист ожидания, F-00-107.
 * `LoyaltyModule` — этап 11: «Клиент пришёл» / «Не пришёл» пересчитывают программу лояльности локации
 * (F-04-121, см. `BookingsService.changeStatus`), поэтому журналу нужен `LoyaltyProgramService`.
 * `StockModule` — этап 13: тот же статус-переход списывает/возвращает расходники по техкарте (F-08-041/042). */
@Module({
  imports: [ScheduleModule, LoyaltyModule, StockModule],
  controllers: [BookingsController, JournalController, DayFeedController, SlotOffersController, ClaimsController, MeBookingsController, PublicClaimsController, UpsellController],
  providers: [BookingsService, DayFeedService, JournalService, GroupEventsService, SeriesService, JournalSettingsService, JournalAccess, UpsellService],
  // GroupEventsService, BookingsService — stage 21 lane «resources» использует их для участников/повтора/
  // серий группового события (src/modules/resources/*), не переопределяя логику журнала своей копией.
  exports: [BookingsService, JournalService, JournalSettingsService, GroupEventsService],
})
export class JournalModule {}
