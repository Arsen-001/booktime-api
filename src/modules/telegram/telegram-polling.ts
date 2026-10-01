import type { Redis } from 'ioredis';
import type { TelegramBot } from '../../adapters/telegram-bot/telegram-bot.js';
import { logger } from '../../common/logging/logger.js';
import type { TelegramBotService } from './telegram-bot.service.js';

const OFFSET_KEY = 'booktime:tg:offset';
const LONG_POLL_SEC = 25;

/**
 * Опрос getUpdates в воркере (TELEGRAM_BOT_POLLING=1) — для разработки без публичного адреса. Смещение хранится в
 * Redis, чтобы перезапуск воркера не отдавал старые обновления заново. Вебхук и опрос вместе Telegram не допускает
 * (getUpdates при заданном вебхуке отвечает 409) — в проде включён только вебхук.
 * Возвращает функцию остановки.
 */
export function startTelegramPolling(bot: TelegramBot, service: TelegramBotService, redis: Redis): () => void {
  let stopped = false;
  if (!bot.real) {
    logger.warn('telegram polling: нет TELEGRAM_BOT_TOKEN — опрашивать некого (обновления можно слать POST /v1/telegram/webhook)');
    return () => undefined;
  }
  const loop = async () => {
    while (!stopped) {
      try {
        const offset = Number((await redis.get(OFFSET_KEY)) ?? 0);
        const updates = await bot.getUpdates(offset, LONG_POLL_SEC);
        for (const u of updates) {
          await service.handleUpdate(u);
          await redis.set(OFFSET_KEY, String(u.update_id + 1));
        }
      } catch (err) {
        logger.warn({ err }, 'telegram polling: getUpdates не прошёл, пауза 5 с');
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  };
  void loop();
  logger.info('telegram polling: запущен');
  return () => {
    stopped = true;
  };
}
