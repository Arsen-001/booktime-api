var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { StockModule } from '../stock/stock.module.js';
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
 * (F-04-121, см. `BookingsService.changeStatus`), поэтому журналу нужен `LoyaltyProgramService`.
 * `StockModule` — этап 13: тот же статус-переход списывает/возвращает расходники по техкарте (F-08-041/042). */
let JournalModule = class JournalModule {
};
JournalModule = __decorate([
    Module({
        imports: [ScheduleModule, LoyaltyModule, StockModule],
        controllers: [BookingsController, JournalController, ClaimsController, MeBookingsController, PublicClaimsController],
        providers: [BookingsService, JournalService, GroupEventsService, SeriesService, JournalSettingsService, JournalAccess],
        // GroupEventsService, BookingsService — stage 21 lane «resources» использует их для участников/повтора/
        // серий группового события (src/modules/resources/*), не переопределяя логику журнала своей копией.
        exports: [BookingsService, JournalService, JournalSettingsService, GroupEventsService],
    })
], JournalModule);
export { JournalModule };
//# sourceMappingURL=journal.module.js.map