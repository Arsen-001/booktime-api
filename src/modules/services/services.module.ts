import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';

/** Этап 4: категории, услуги, пакеты «Комплекс» (docs/backend/01 §4, 02 §8) */
@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
