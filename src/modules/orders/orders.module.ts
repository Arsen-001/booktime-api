import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrderIntakeService } from './order-intake.service.js';
import { OrdersService } from './orders.service.js';

/** Заказы (03.10.2026): ателье, ремонт телефонов и техники, химчистка, детейлинг — приём, статусы, «готов», /o/<code>, запись на сдачу */
// JournalModule — ⭐ запись на сдачу (05.10.2026): принятый по записи заказ отмечает запись «Пришёл» (BookingsService)
@Module({
  imports: [JournalModule],
  controllers: [OrdersController, PublicOrdersController],
  providers: [OrdersService, OrderIntakeService],
  exports: [OrdersService, OrderIntakeService],
})
export class OrdersModule {}
