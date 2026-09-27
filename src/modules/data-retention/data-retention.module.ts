import { Module } from '@nestjs/common';
import { DataRetentionController } from './data-retention.controller.js';
import { FullArchiveService } from './full-archive.service.js';

/** Этап 20 — данные и удаление (docs/backend/01 §10, 06 §6): полный архив бизнеса по запросу. */
@Module({
  controllers: [DataRetentionController],
  providers: [FullArchiveService],
})
export class DataRetentionModule {}
