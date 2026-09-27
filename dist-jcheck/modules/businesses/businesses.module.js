var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { NetworkController, NetworkService } from '../network/network.controller.js';
import { InvitesController } from '../staff/invites.controller.js';
import { JournalsController } from '../staff/journals.controller.js';
import { StaffController } from '../staff/staff.controller.js';
import { StaffService } from '../staff/staff.service.js';
import { BusinessController } from './business.controller.js';
import { BusinessService } from './business.service.js';
/** Этап 3: бизнес, филиалы, сеть, сотрудники, приглашения, права, журналы (docs/backend/01 §2–3, 02 §7, §15, §18) */
let BusinessesModule = class BusinessesModule {
};
BusinessesModule = __decorate([
    Module({
        controllers: [BusinessController, StaffController, JournalsController, InvitesController, NetworkController],
        providers: [BusinessService, StaffService, NetworkService],
        exports: [BusinessService, StaffService],
    })
], BusinessesModule);
export { BusinessesModule };
//# sourceMappingURL=businesses.module.js.map