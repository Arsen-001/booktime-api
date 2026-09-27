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
@Module({
  controllers: [ScheduleController, CalendarController, SlotsController],
  providers: [AvailabilityService, OccupyService, ScheduleService, CalendarService, RulesService],
  exports: [AvailabilityService, OccupyService, ScheduleService],
})
export class ScheduleModule {}
