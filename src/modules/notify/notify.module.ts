import { Module } from '@nestjs/common';
import { BusinessesModule } from '../businesses/businesses.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { NotifyChannelsService } from './notify-channels.service.js';
import { NotifyClientPrefsService } from './notify-client-prefs.service.js';
import { NotifyDispatchService } from './notify-dispatch.service.js';
import { NotifyInboxService } from './notify-inbox.service.js';
import { NotifyMiscService } from './notify-misc.service.js';
import { NotifyMoreService } from './notify-more.service.js';
import { NotifyNewsService } from './notify-news.service.js';
import { NotifyRichTypesService } from './notify-rich-types.service.js';
import { NotifyStaffPrefsService } from './notify-staff-prefs.service.js';
import { NotifyTypesService } from './notify-types.service.js';
import { NotifyController } from './notify.controller.js';

/**
 * Этап 10: уведомления — очередь/пуш, новости, колокольчик, настройки (docs/backend/05, PLAN.md §6 №10).
 * Этап 21 «notify+integrations»: + NotifyMiscService (web-popup/email/banners/channels-overview) и
 * BusinessesModule (StaffService.reissueInvite — «Приглашение сотрудника с доступом» F-05-063 переиспользует
 * настоящее приглашение этапа 3, а не заводит второе).
 * Попытка 3: + NotifyMoreService (настройки/тихие часы, витрина подарков, Open Slots расписание, сводки
 * партнёров, WhatsApp через Altegio, флаги агента, время напоминания на услугу, свои вебхуки, письма) и
 * NotifyRichTypesService — каталог типов ПОД экран (29+2, решение владельца 28.09), НЕ заменяет NotifyTypesService
 * (13 kind, питает настоящую отправку — kinds.ts, bookings.service.ts, не трогать).
 * Попытка 4: ScheduleModule (AvailabilityService) — «Open Slots»/«Кого позвать» (F-05-124/125) считают на
 * настоящем движке свободных окон, не свой параллельный расчёт.
 */
@Module({
  imports: [BusinessesModule, ScheduleModule],
  controllers: [NotifyController],
  providers: [
    NotifyTypesService,
    NotifyNewsService,
    NotifyStaffPrefsService,
    NotifyClientPrefsService,
    NotifyInboxService,
    NotifyChannelsService,
    NotifyDispatchService,
    NotifyMiscService,
    NotifyMoreService,
    NotifyRichTypesService,
  ],
  exports: [NotifyTypesService, NotifyStaffPrefsService, NotifyDispatchService, NotifyChannelsService],
})
export class NotifyModule {}
