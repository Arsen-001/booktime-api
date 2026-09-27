var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
let OnlineModule = class OnlineModule {
};
OnlineModule = __decorate([
    Module({
        imports: [ScheduleModule, JournalModule, AuthModule],
        controllers: [PublicOnlineController, BizOnlineController],
        providers: [OnlineService],
        exports: [OnlineService],
    })
], OnlineModule);
export { OnlineModule };
//# sourceMappingURL=online.module.js.map