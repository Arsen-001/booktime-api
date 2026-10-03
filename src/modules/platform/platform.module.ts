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
import { PlatformProspectsController } from './prospects.controller.js';
import { ProspectsService } from './prospects.service.js';
import { PlatformDemandController } from './demand.controller.js';
import { DemandService } from './demand.service.js';
import { PlatformAdsController, PublicAdsController } from './ads.controller.js';
import { AdsService } from './ads.service.js';
import { PlatformStoriesController } from './stories.controller.js';
import { StoriesService } from './stories.service.js';
import { PlatformNotesController } from './notes.controller.js';
import { PlatformNotesService } from './notes.service.js';
import { PlatformConnectController, PlatformConnectResultController } from './connect.controller.js';
import { ConnectService } from './connect.service.js';
import { PlatformTeamController } from './team.controller.js';
import { PlatformUsersController } from './users.controller.js';
import { PlatformUsersService } from './users.service.js';

/**
 * Этап 19 — модерация и наша панель (docs/backend/02 §19, 06 §1). Попытка 3 достроила последнее, что оставалось:
 * подключение салона за 10 минут (ConnectDraft, F-00-176) — см. docs/PROGRESS.md. Остальное (модерация, бизнесы,
 * поддержка, идеи, заявки на сферы, визиты, обзор, спрос/first-awards, реклама+сторис, заметки основателя) —
 * построено попытками 1–2.
 */
@Module({
  controllers: [
    PlatformTeamController,
    PlatformUsersController,
    PlatformModerationController,
    BizModerationController,
    ModerationStatusController,
    PlatformBusinessesController,
    PlatformSupportController,
    BizIdeasController,
    PlatformIdeasController,
    PlatformSphereController,
    PlatformVisitsController,
    PlatformProspectsController,
    PlatformOverviewController,
    PlatformDemandController,
    PlatformAdsController,
    PublicAdsController,
    PlatformStoriesController,
    PlatformNotesController,
    PlatformConnectController,
    PlatformConnectResultController,
  ],
  providers: [
    ModerationService,
    PlatformBusinessesService,
    PlatformSupportService,
    IdeasService,
    SphereRequestsService,
    VisitsService,
    ProspectsService,
    OverviewService,
    DemandService,
    AdsService,
    StoriesService,
    PlatformNotesService,
    ConnectService,
    PlatformUsersService,
  ],
  exports: [ModerationService],
})
export class PlatformModule {}
