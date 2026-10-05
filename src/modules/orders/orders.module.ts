import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrderIntakeService } from './order-intake.service.js';
import { OrderPickupService } from './order-pickup.service.js';
import { OrdersService } from './orders.service.js';

/** Заказы (03.10.2026): ателье, ремонт телефонов и техники, химчистка, детейлинг — приём, статусы, «готов», /o/<code>, запись на сдачу */
// JournalModule — ⭐ запись на сдачу (05.10.2026): принятый по записи заказ отмечает запись «Пришёл» (BookingsService);
// ScheduleModule — ⭐ выдача по времени (06.10.2026): окна выдачи (AvailabilityService)
@Module({
  imports: [JournalModule, ScheduleModule],
  controllers: [OrdersController, PublicOrdersController],
  providers: [OrdersService, OrderIntakeService, OrderPickupService],
  exports: [OrdersService, OrderIntakeService, OrderPickupService],
})
export class OrdersModule {}
