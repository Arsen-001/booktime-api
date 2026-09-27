var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { CatalogService } from './catalog.service.js';
import { PublicCatalogController } from './catalog.controller.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';
/**
 * Этап 9: приложение клиента (PLAN §6 №9, docs/backend/02 §2). Каталог/карточки/окна считает тот же фундамент,
 * что журнал и онлайн-запись (этапы 6–8): `ScheduleModule` (AvailabilityService), `JournalModule`
 * (BookingsService.place/markPaidByClient, JournalService.mintClaim). `sanitizePublicStaff` — обычный импорт
 * функции из `online.service.ts` (не DI), поэтому `OnlineModule` сюда заводить не нужно. `LoyaltyModule` —
 * этап 11: GET /v1/me/loyalty и заявки В-17 живут в этом контроллере (все /v1/me — одна поверхность, PLAN §2),
 * саму логику несёт `MeLoyaltyService`.
 */
let ClientModule = class ClientModule {
};
ClientModule = __decorate([
    Module({
        imports: [ScheduleModule, JournalModule, LoyaltyModule],
        controllers: [PublicCatalogController, MeController],
        providers: [CatalogService, MeService],
    })
], ClientModule);
export { ClientModule };
//# sourceMappingURL=client.module.js.map