import { Module } from '@nestjs/common';
import { FilesController, UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

/** Файлы и фото (04.10.2026): загрузка фото в хранилище (диск или S3) и раздача /v1/files/<key> */
@Module({
  controllers: [UploadsController, FilesController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
