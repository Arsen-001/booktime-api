import { Module } from '@nestjs/common';
import { NotifyModule } from '../notify/notify.module.js';
import { NetworkAccessService } from './network-access.service.js';
import { NetworkBroadcastController, NetworkBroadcastService } from './network-broadcast.controller.js';
import { NetworkCatalogController, NetworkCatalogService } from './network-catalog.controller.js';
import { NetworkClientsController, NetworkClientsService } from './network-clients.controller.js';
import { NetworkReportsController, NetworkReportsService } from './network-reports.controller.js';
import { NetworkUsersController, NetworkUsersService } from './network-users.controller.js';

/**
 * Этап 15 — Сеть (docs/backend/02 §15, PLAN.md §6 №15): пользователи сети, общая база клиентов, рассылки,
 * аналитика и планы, сетевые каталоги (услуги/товары/должности/поля). Устройство сети/филиалов само (создание
 * сети, добавление/вывод филиала, порядок, мягкое удаление) — этап 3, `NetworkController`/`NetworkService` в
 * `modules/businesses` (не трогается здесь, PLAN §9 «не переписывать чужой рабочий срез»).
 */
@Module({
  imports: [NotifyModule],
  controllers: [NetworkUsersController, NetworkClientsController, NetworkBroadcastController, NetworkReportsController, NetworkCatalogController],
  providers: [NetworkAccessService, NetworkUsersService, NetworkClientsService, NetworkBroadcastService, NetworkReportsService, NetworkCatalogService],
})
export class NetworkModule {}
