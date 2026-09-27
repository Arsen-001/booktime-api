import { Module } from '@nestjs/common';
import { BizIdeasController, PlatformIdeasController } from './ideas.controller.js';
import { IdeasService } from './ideas.service.js';
import { PlatformBusinessesController } from './businesses.controller.js';
import { PlatformBusinessesService } from './businesses.service.js';
import { BizModerationController, ModerationStatusController, PlatformModerationController } from './moderation.controller.js';
import { ModerationService } from './moderation.service.js';
import { PlatformOverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';
import { PlatformSphereController } from './sphere.controller.js';
import { SphereRequestsService } from './sphere.service.js';
import { PlatformSupportController } from './support.controller.js';
import { PlatformSupportService } from './support.service.js';
import { PlatformVisitsController } from './visits.controller.js';
import { VisitsService } from './visits.service.js';
import { PlatformDemandController } from './demand.controller.js';
import { DemandService } from './demand.service.js';
import { PlatformAdsController, PublicAdsController } from './ads.controller.js';
import { AdsService } from './ads.service.js';
import { PlatformStoriesController } from './stories.controller.js';
import { StoriesService } from './stories.service.js';
import { PlatformNotesController } from './notes.controller.js';
import { PlatformNotesService } from './notes.service.js';

/**
 * Этап 19 — модерация и наша панель (docs/backend/02 §19, 06 §1). Не строит этим проходом (попытка 2): подключение
 * салона за 10 минут (ConnectDraft) — см. docs/PROGRESS.md. Спрос/first-awards, реклама+сторис (без покупки места
 * и без картинки сторис K18, они не построены ещё и во фронте) и заметки основателя — построены этой попыткой.
 */
@Module({
  controllers: [
    PlatformModerationController,
    BizModerationController,
    ModerationStatusController,
    PlatformBusinessesController,
    PlatformSupportController,
    BizIdeasController,
    PlatformIdeasController,
    PlatformSphereController,
    PlatformVisitsController,
    PlatformOverviewController,
    PlatformDemandController,
    PlatformAdsController,
    PublicAdsController,
    PlatformStoriesController,
    PlatformNotesController,
  ],
  providers: [ModerationService, PlatformBusinessesService, PlatformSupportService, IdeasService, SphereRequestsService, VisitsService, OverviewService, DemandService, AdsService, StoriesService, PlatformNotesService],
  exports: [ModerationService],
})
export class PlatformModule {}
