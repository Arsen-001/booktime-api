import { FakeBusinessMessenger } from '../adapters/business-sms/business-sms.js';
import type { PrismaService } from '../common/prisma.service.js';
import { NotifyLogService } from '../modules/notify/notify-log.service.js';
import { NotifyMailingsService } from '../modules/notify/notify-mailings.service.js';

/**
 * Рассылки по расписанию (Ув13, этап 21 лейн notify-log+mailings) — воркер раз в минуту отправляет те, чьё время
 * пришло. Собрано без Nest (как notifyServices): рассылке от журнала нужна только запись строки (`write` — одна
 * Prisma), поэтому зависимости вывода журнала (каталог типов, настройки, короткие ссылки) здесь не нужны.
 * Адаптер SMS — тот же, что даёт adapters.ts (заглушка, провайдер бизнеса не выбран — В-08).
 */
export function notifyMailingsJob(prisma: PrismaService) {
  const messenger = new FakeBusinessMessenger();
  const log = new NotifyLogService(prisma, null as never, null as never, null as never, messenger);
  const mailings = new NotifyMailingsService(prisma, log, messenger);
  return () => mailings.processDue();
}
