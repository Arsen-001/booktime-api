import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { OnlineModule } from '../online/online.module.js';
import { TelegramBotService } from './telegram-bot.service.js';
import { TelegramLinksService, TelegramMeController, TelegramPublicController, TelegramWebhookController, TelegramBizController } from './telegram.controller.js';

/**
 * Telegram-бот напоминаний (решение владельца 30.09.2026: бесплатный канал для клиентов без нашего приложения).
 * `JournalModule` — подтверждение/отмена кнопками идут теми же путями журнала; `OnlineModule` — проверка хэша
 * записи по ссылке (`OnlineService.bookingByHash`). Напоминания кладёт `jobs/notify-reminders.ts`, шлёт
 * `NotifyDispatchService` (app = 'telegram'); опрос getUpdates без вебхука — воркер (`telegram-polling.ts`).
 */
@Module({
  imports: [JournalModule, OnlineModule],
  controllers: [TelegramWebhookController, TelegramPublicController, TelegramMeController, TelegramBizController],
  providers: [TelegramBotService, TelegramLinksService],
})
export class TelegramModule {}
