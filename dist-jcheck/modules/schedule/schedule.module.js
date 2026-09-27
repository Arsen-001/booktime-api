var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { AvailabilityService } from '../availability/availability.service.js';
import { OccupyService } from '../availability/occupy.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { RulesService } from './rules.service.js';
import { ScheduleController } from './schedule.controller.js';
import { ScheduleService } from './schedule.service.js';
import { SlotsController } from './slots.controller.js';
/** Этап 6: график, отметки календаря, правила онлайн-записи, свободные окна и «замок на мастера» (PLAN §6 №6, §4.2) */
let ScheduleModule = class ScheduleModule {
};
ScheduleModule = __decorate([
    Module({
        controllers: [ScheduleController, CalendarController, SlotsController],
        providers: [AvailabilityService, OccupyService, ScheduleService, CalendarService, RulesService],
        exports: [AvailabilityService, OccupyService, ScheduleService],
    })
], ScheduleModule);
export { ScheduleModule };
//# sourceMappingURL=schedule.module.js.map