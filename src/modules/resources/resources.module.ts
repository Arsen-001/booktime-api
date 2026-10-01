import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
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
  imports: [JournalModule, FinanceModule],
  // ResourcesEventsController СНАЧАЛА: у ResourcesController есть catch-all `@Get(':id')`/`@Patch(':id')`/
  // `@Delete(':id')` — зарегистрируй его первым, и он перехватит /resources/waitlist, /resources/series/:id и
  // т.д. раньше, чем Nest дойдёт до литеральных маршрутов этого контроллера (нашёл на этом же прогоне: `GET
  // .../resources/waitlist` падал `not_found` — ловил чужой `@Get(':id')`, приняв «waitlist» за id ресурса).
  controllers: [ResourcesEventsController, ResourcesController],
  providers: [ResourcesService, ResourcesEventsService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
