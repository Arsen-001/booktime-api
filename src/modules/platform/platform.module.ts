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

/**
 * Этап 19 — модерация и наша панель (docs/backend/02 §19, 06 §1). Не строит этим проходом: подключение салона
 * за 10 минут (ConnectDraft), спрос/first-awards, реклама и сторис, план запуска — см. docs/PROGRESS.md.
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
  ],
  providers: [ModerationService, PlatformBusinessesService, PlatformSupportService, IdeasService, SphereRequestsService, VisitsService, OverviewService],
  exports: [ModerationService],
})
export class PlatformModule {}
