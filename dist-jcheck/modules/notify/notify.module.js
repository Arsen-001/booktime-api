var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { NotifyChannelsService } from './notify-channels.service.js';
import { NotifyClientPrefsService } from './notify-client-prefs.service.js';
import { NotifyDispatchService } from './notify-dispatch.service.js';
import { NotifyInboxService } from './notify-inbox.service.js';
import { NotifyNewsService } from './notify-news.service.js';
import { NotifyStaffPrefsService } from './notify-staff-prefs.service.js';
import { NotifyTypesService } from './notify-types.service.js';
import { NotifyController } from './notify.controller.js';
/** Этап 10: уведомления — очередь/пуш, новости, колокольчик, настройки (docs/backend/05, PLAN.md §6 №10) */
let NotifyModule = class NotifyModule {
};
NotifyModule = __decorate([
    Module({
        controllers: [NotifyController],
        providers: [NotifyTypesService, NotifyNewsService, NotifyStaffPrefsService, NotifyClientPrefsService, NotifyInboxService, NotifyChannelsService, NotifyDispatchService],
        exports: [NotifyTypesService, NotifyStaffPrefsService, NotifyDispatchService, NotifyChannelsService],
    })
], NotifyModule);
export { NotifyModule };
//# sourceMappingURL=notify.module.js.map