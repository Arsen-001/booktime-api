import { createPushSenders } from '../adapters/push/push.js';
import { createTelegramBot } from '../adapters/telegram-bot/telegram-bot.js';
import type { PrismaService } from '../common/prisma.service.js';
import { NotifyDispatchService } from '../modules/notify/notify-dispatch.service.js';

/** Собранный без Nest, как journalServices() (jobs/journal-jobs.ts) — тот же приём для воркера (PLAN.md Р10) */
export function notifyServices(prisma: PrismaService) {
  const dispatch = new NotifyDispatchService(prisma, createPushSenders(), createTelegramBot());
  return { dispatch };
}
