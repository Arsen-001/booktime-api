import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { ResourcesEventsController } from './resources-events.controller.js';
import { ResourcesEventsService } from './resources-events.service.js';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';

/**
 * Этап 4: ресурсы — кресла, кабинеты, аппараты (docs/backend/01 §4, 02 §9).
 * `JournalModule` — этап 21 (лейн «resources»): `ResourcesEventsService` использует `BookingsService`/
 * `GroupEventsService` журнала как есть (участники группового события, повтор, серии — не своя копия логики).
 */
@Module({
  imports: [JournalModule],
  controllers: [ResourcesController, ResourcesEventsController],
  providers: [ResourcesService, ResourcesEventsService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
