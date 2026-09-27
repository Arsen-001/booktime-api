import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { PlatformModule } from '../platform/platform.module.js';
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
 * саму логику несёт `MeLoyaltyService`. `PlatformModule` — этап 21 (лейн client): отзывы (В-24) шлют текст на
 * модерацию через `ModerationService` (уже строит очередь платформы, этап 19) — не дублируем её здесь.
 */
@Module({
  imports: [ScheduleModule, JournalModule, LoyaltyModule, PlatformModule],
  controllers: [PublicCatalogController, MeController],
  providers: [CatalogService, MeService],
})
export class ClientModule {}
