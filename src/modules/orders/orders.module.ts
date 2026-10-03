import { Module } from '@nestjs/common';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/** Заказы (03.10.2026): ателье, ремонт телефонов и техники, химчистка, детейлинг — приём, статусы, «готов», /o/<code> */
@Module({
  controllers: [OrdersController, PublicOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
