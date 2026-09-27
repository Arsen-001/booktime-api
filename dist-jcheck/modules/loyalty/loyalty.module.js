var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { LoyaltyCatalogService } from './loyalty-catalog.service.js';
import { LoyaltyInstancesService } from './loyalty-instances.service.js';
import { LoyaltyProgramService } from './loyalty-program.service.js';
import { LoyaltyController } from './loyalty.controller.js';
import { MeLoyaltyService } from './me-loyalty.service.js';
/** Этап 11: лояльность (docs/backend/02-api.md §11, PLAN §6 №11). `MeLoyaltyService` экспортирован для
 * `ClientModule` (GET /v1/me/loyalty, заявки В-17) — своего контроллера под /v1/me здесь нет намеренно,
 * все /v1/me маршруты одного раздела уже собраны в client/me.controller.ts (PLAN §2). */
let LoyaltyModule = class LoyaltyModule {
};
LoyaltyModule = __decorate([
    Module({
        controllers: [LoyaltyController],
        providers: [LoyaltyProgramService, LoyaltyCatalogService, LoyaltyInstancesService, MeLoyaltyService],
        exports: [LoyaltyProgramService, LoyaltyCatalogService, LoyaltyInstancesService, MeLoyaltyService],
    })
], LoyaltyModule);
export { LoyaltyModule };
//# sourceMappingURL=loyalty.module.js.map