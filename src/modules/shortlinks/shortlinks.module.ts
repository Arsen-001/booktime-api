import { Module } from '@nestjs/common';
import { ShortLinksController, ShortLinksRedirectController } from './shortlinks.controller.js';
import { ShortLinksService } from './shortlinks.service.js';

/** Этап 21, 28.09: короткие ссылки SMS `booktime.am/s/<code>` — сервис экспортируется отправителю уведомлений */
@Module({
  controllers: [ShortLinksController, ShortLinksRedirectController],
  providers: [ShortLinksService],
  exports: [ShortLinksService],
})
export class ShortLinksModule {}
