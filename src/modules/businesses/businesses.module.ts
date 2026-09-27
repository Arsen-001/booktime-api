import { Module } from '@nestjs/common';
import { NetworkController, NetworkService } from '../network/network.controller.js';
import { InvitesController } from '../staff/invites.controller.js';
import { JournalsController } from '../staff/journals.controller.js';
import { StaffController } from '../staff/staff.controller.js';
import { StaffService } from '../staff/staff.service.js';
import { BusinessController } from './business.controller.js';
import { BusinessService } from './business.service.js';

/** Этап 3: бизнес, филиалы, сеть, сотрудники, приглашения, права, журналы (docs/backend/01 §2–3, 02 §7, §15, §18) */
@Module({
  controllers: [BusinessController, StaffController, JournalsController, InvitesController, NetworkController],
  providers: [BusinessService, StaffService, NetworkService],
  exports: [BusinessService, StaffService],
})
export class BusinessesModule {}
