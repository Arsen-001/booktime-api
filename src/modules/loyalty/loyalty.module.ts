import { Module } from '@nestjs/common';
import { LoyaltyCatalogService } from './loyalty-catalog.service.js';
import { LoyaltyInstancesService } from './loyalty-instances.service.js';
import { LoyaltyProgramService } from './loyalty-program.service.js';
import { LoyaltyController } from './loyalty.controller.js';
import { MeLoyaltyService } from './me-loyalty.service.js';
import { BusinessesModule } from '../businesses/businesses.module.js';
import { LoyaltyPortController, MeLoyaltyPortController, PublicLoyaltyPortController } from './port/loyalty-port.controller.js';
import { LoyaltyPortRunner } from './port/runner.service.js';
// этап 21, лейн client-loyalty
import { BizClientLoyaltyController, MeClientLoyaltyController, PublicClientLoyaltyController } from './client-loyalty.controller.js';
import { ClientLoyaltyService } from './client-loyalty.service.js';

/** Этап 11: лояльность (docs/backend/02-api.md §11, PLAN §6 №11). `MeLoyaltyService` экспортирован для
 * `ClientModule` (GET /v1/me/loyalty, заявки В-17) — своего контроллера под /v1/me здесь нет намеренно,
 * все /v1/me маршруты одного раздела уже собраны в client/me.controller.ts (PLAN §2). */
@Module({
  // этап 21, лейн loyalty: port/* — расчётный слой фасада фронта на сервере (LoyaltyPortRunner)
  imports: [BusinessesModule],
  controllers: [LoyaltyController, LoyaltyPortController, MeLoyaltyPortController, PublicLoyaltyPortController, MeClientLoyaltyController, PublicClientLoyaltyController, BizClientLoyaltyController],
  providers: [LoyaltyProgramService, LoyaltyCatalogService, LoyaltyInstancesService, MeLoyaltyService, LoyaltyPortRunner, ClientLoyaltyService],
  exports: [LoyaltyProgramService, LoyaltyCatalogService, LoyaltyInstancesService, MeLoyaltyService, LoyaltyPortRunner],
})
export class LoyaltyModule {}
