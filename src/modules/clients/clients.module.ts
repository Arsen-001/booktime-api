import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller.js';
import { ClientsExtrasService } from './clients-extras.service.js';
import { ClientsImportExportService } from './clients-import-export.service.js';
import { ClientsService } from './clients.service.js';

/** Этап 5: клиенты / CRM (docs/backend/01 §5, 02 §6) */
@Module({
  controllers: [ClientsController],
  providers: [ClientsService, ClientsExtrasService, ClientsImportExportService],
  exports: [ClientsService],
})
export class ClientsModule {}
