import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';

/** Этап 4: ресурсы — кресла, кабинеты, аппараты (docs/backend/01 §4, 02 §9) */
@Module({
  controllers: [ResourcesController],
  providers: [ResourcesService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
