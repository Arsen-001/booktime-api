import { Module } from '@nestjs/common';
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
  providers: [ClientsService, ClientsExtrasService, ClientsImportExportService, ClientsBroadcastService],
  exports: [ClientsService],
})
export class ClientsModule {}
