import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { AppReportsController } from './app-reports.controller.js';
import { AppReportsService } from './app-reports.service.js';
import { AppStaffController } from './app-staff.controller.js';
import { AppStaffService } from './app-staff.service.js';
import { CatalogService } from './catalog.service.js';
import { ClientPromoBizController, ClientPromoPublicController } from './client-promo.controller.js';
import { ClientPromoService } from './client-promo.service.js';
import { PublicCatalogController } from './catalog.controller.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';
import { TranslationsController } from './translations.controller.js';
import { TranslationsService } from './translations.service.js';
import { VisitCashController } from './visit-cash.controller.js';
import { VisitCashService } from './visit-cash.service.js';

/**
 * Этап 9: приложение клиента (PLAN §6 №9, docs/backend/02 §2). Каталог/карточки/окна считает тот же фундамент,
 * что журнал и онлайн-запись (этапы 6–8): `ScheduleModule` (AvailabilityService), `JournalModule`
 * (BookingsService.place/markPaidByClient, JournalService.mintClaim). `sanitizePublicStaff` — обычный импорт
 * функции из `online.service.ts` (не DI), поэтому `OnlineModule` сюда заводить не нужно. `LoyaltyModule` —
 * этап 11: GET /v1/me/loyalty и заявки В-17 живут в этом контроллере (все /v1/me — одна поверхность, PLAN §2),
 * саму логику несёт `MeLoyaltyService`. `PlatformModule` — этап 21 (лейн client): отзывы (В-24) шлют текст на
 * модерацию через `ModerationService` (уже строит очередь платформы, этап 19) — не дублируем её здесь.
 * `AppReportsController/Service` — этап 21 (лейн client, попытка 5): отчёты вкладки «Приложение»
 * (`GET /v1/biz/{b}/apps/reports/…`, F-14-123…129) — своя лёгкая форма, не реестр `reports.controller.ts`
 * (см. докстринг `app-reports.service.ts`). Только `reports-common.ts` (чистые функции) и
 * `loyalty.owner.ts::resolveScopeBusinessIds` (тоже чистая функция) — не тянет ни `ReportsModule`, ни второй раз
 * `LoyaltyModule` (он уже в импортах строкой выше).
 *
 * `AppStaffController/Service`, `TranslationsController/Service` — этап 21 (лейн client+online, попытка 2):
 * `client.ts::listAppStaff/setEmployeeAppAccess/getDayZReport/getAppPayrollCalculation/getAppPayrollPayouts/
 * recordPayrollPayout` и `::getTranslationOverride/listTranslatable/setTranslationOverride`. `AppStaffService`
 * зовёт `BookingsService.view()` для Z-отчёта — уже в импортах через `JournalModule`.
 *
 * `VisitCashController/Service` — этап 21 (лейн client+online, попытка 4): «визит-микрокасса» (F-14-092…098),
 * `client.ts::listVisitCandidates/getVisitDetail/addVisitSaleLine/removeVisitSaleLine/addVisitPayment/
 * removeVisitPayment/refundVisitPayment/listNoAppRemindersTomorrow/sendVisitReceipt/isVisitReceiptSent`. Тоже
 * зовёт `BookingsService.view()/.find()/.tzOfBusiness()` — `JournalModule` уже в импортах.
 */
@Module({
  imports: [ScheduleModule, JournalModule, LoyaltyModule, PlatformModule],
  controllers: [PublicCatalogController, ClientPromoPublicController, ClientPromoBizController, MeController, AppReportsController, AppStaffController, TranslationsController, VisitCashController],
  providers: [CatalogService, ClientPromoService, MeService, AppReportsService, AppStaffService, TranslationsService, VisitCashService],
})
export class ClientModule {}
