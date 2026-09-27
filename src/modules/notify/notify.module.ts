import { Module } from '@nestjs/common';
import { BusinessesModule } from '../businesses/businesses.module.js';
import { NotifyChannelsService } from './notify-channels.service.js';
import { NotifyClientPrefsService } from './notify-client-prefs.service.js';
import { NotifyDispatchService } from './notify-dispatch.service.js';
import { NotifyInboxService } from './notify-inbox.service.js';
import { NotifyMiscService } from './notify-misc.service.js';
import { NotifyNewsService } from './notify-news.service.js';
import { NotifyStaffPrefsService } from './notify-staff-prefs.service.js';
import { NotifyTypesService } from './notify-types.service.js';
import { NotifyController } from './notify.controller.js';

/**
 * Этап 10: уведомления — очередь/пуш, новости, колокольчик, настройки (docs/backend/05, PLAN.md §6 №10).
 * Этап 21 «notify+integrations»: + NotifyMiscService (web-popup/email/banners/channels-overview) и
 * BusinessesModule (StaffService.reissueInvite — «Приглашение сотрудника с доступом» F-05-063 переиспользует
 * настоящее приглашение этапа 3, а не заводит второе).
 */
@Module({
  imports: [BusinessesModule],
  controllers: [NotifyController],
  providers: [NotifyTypesService, NotifyNewsService, NotifyStaffPrefsService, NotifyClientPrefsService, NotifyInboxService, NotifyChannelsService, NotifyDispatchService, NotifyMiscService],
  exports: [NotifyTypesService, NotifyStaffPrefsService, NotifyDispatchService, NotifyChannelsService],
})
export class NotifyModule {}
