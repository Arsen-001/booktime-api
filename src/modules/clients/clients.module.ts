import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClientPhonesInterceptor } from './client-phones.interceptor.js';
import { ClientsController } from './clients.controller.js';
import { ClientsExtrasService } from './clients-extras.service.js';
import { ClientsImportExportService } from './clients-import-export.service.js';
import { ClientsService } from './clients.service.js';
import { ClientsBroadcastService } from './clients-broadcast.service.js';
import { UploadsModule } from '../uploads/uploads.module.js';

/** Этап 5: клиенты / CRM (docs/backend/01 §5, 02 §6) */
@Module({
  imports: [UploadsModule],
  controllers: [ClientsController],
  // Ответ 29: телефоны клиентов скрыты в любом ответе кабинета без права clients.phones
  providers: [ClientsService, ClientsExtrasService, ClientsImportExportService, ClientsBroadcastService, { provide: APP_INTERCEPTOR, useClass: ClientPhonesInterceptor }],
  exports: [ClientsService],
})
export class ClientsModule {}
