import 'reflect-metadata';
import { Queue, Worker } from 'bullmq';
import { createRedis } from './common/redis.js';
import { logger } from './common/logging/logger.js';
import { PrismaService } from './common/prisma.service.js';
import { authHousekeeping } from './jobs/auth-housekeeping.js';
import { scheduleEmptyWeek } from './jobs/schedule-empty-week.js';
import { journalHolds, journalSeries, journalServices } from './jobs/journal-jobs.js';
import { notifyServices } from './jobs/notify-jobs.js';
import { notifyBookingReminders } from './jobs/notify-reminders.js';
import { notifyMailingsJob } from './jobs/notify-mailings.js';
import { reportsExportDispatch } from './jobs/reports-export.js';
import { notifyEmptyWeek } from './modules/notify/notify-empty-week.js';
import { billingDispatch } from './jobs/billing-tick.js';
import { webhooksDispatch } from './jobs/webhooks-dispatch.js';
import { businessRetentionTick } from './jobs/business-retention.js';
import { dbBackup, hasBackupToday } from './jobs/db-backup.js';
import { createTelegramBot } from './adapters/telegram-bot/telegram-bot.js';
import { env } from './common/config/env.js';
import { TelegramBotService } from './modules/telegram/telegram-bot.service.js';
import { startTelegramPolling } from './modules/telegram/telegram-polling.js';

/**
 * Воркер: очереди BullMQ и расписания (PLAN.md Р10) — напоминания, снятие заявок по сроку, списания, выгрузки.
 * Этап 0: одна системная очередь и «пульс» раз в минуту, чтобы было видно, что воркер жив.
 */
const connection = createRedis('worker');
const SYSTEM = 'system';

const queue = new Queue(SYSTEM, { connection });
await queue.upsertJobScheduler('heartbeat', { every: 60_000 }, { name: 'heartbeat', data: {} });
await queue.upsertJobScheduler('auth-housekeeping', { every: 3_600_000 }, { name: 'auth.housekeeping', data: {} });
// F-00-055: воскресенье 18:00 по Еревану — «откройте окна на неделю» (адресаты; пуш — этап 10)
await queue.upsertJobScheduler('schedule-empty-week', { pattern: '0 18 * * 0', tz: 'Asia/Yerevan' }, { name: 'schedule.empty-week', data: {} });
// Этап 7: снятие заявок по сроку и раздача окна — каждую минуту; продление серий — ночью
await queue.upsertJobScheduler('journal-holds', { every: 60_000 }, { name: 'journal.holds', data: {} });
await queue.upsertJobScheduler('journal-series', { pattern: '0 3 * * *', tz: 'Asia/Yerevan' }, { name: 'journal.series', data: {} });
// Этап 10: отправитель очереди пушей — часто (сообщение должно уйти за секунды, не минуты); напоминания — раз в 5 мин
await queue.upsertJobScheduler('notify-dispatch', { every: 20_000 }, { name: 'notify.dispatch', data: {} });
await queue.upsertJobScheduler('notify-reminders', { every: 300_000 }, { name: 'notify.reminders', data: {} });
// Этап 21 (лейн notify-log+mailings): рассылки по расписанию (Ув13) — раз в минуту
await queue.upsertJobScheduler('notify-mailings', { every: 60_000 }, { name: 'notify.mailings', data: {} });
// Этап 16: выгрузка отчёта — CSV должен быть готов быстро, не в час по расписанию
await queue.upsertJobScheduler('reports-export', { every: 15_000 }, { name: 'reports.export', data: {} });
// Этап 18: подписка — 03:00 по Еревану предупреждения/списания/заморозка, каждые 5 мин повтор списаний (06 §3.3)
await queue.upsertJobScheduler('billing-daily', { pattern: '0 3 * * *', tz: 'Asia/Yerevan' }, { name: 'billing.tick', data: {} });
await queue.upsertJobScheduler('billing-retry', { every: 300_000 }, { name: 'billing.tick', data: {} });
// Этап 17: доставка вебхуков — подпись + до 5 попыток с отступом (fan-out кладёт AuditService.record); часто,
// как notify.dispatch — событие должно уйти за секунды
await queue.upsertJobScheduler('webhooks-dispatch', { every: 10_000 }, { name: 'webhooks.dispatch', data: {} });
// Этап 20: хранение и обезличивание при уходе бизнеса (B6) — раз в сутки, срок считается в днях, не в минутах
await queue.upsertJobScheduler('business-retention', { pattern: '0 4 * * *', tz: 'Asia/Yerevan' }, { name: 'business.retention', data: {} });
// 03.10.2026: ежедневная копия базы, пока на Railway нет снимков дисков (тариф Hobby) — только где DB_BACKUP=1
if (env.DB_BACKUP) await queue.upsertJobScheduler('db-backup', { pattern: '30 4 * * *', tz: 'Asia/Yerevan' }, { name: 'db.backup', data: {} });
else await queue.removeJobScheduler('db-backup');
// Копии за сегодня нет (первый запуск, перезапуск в 04:30) — сделать сейчас; jobId не даёт поставить дважды за день
if (env.DB_BACKUP && !(await hasBackupToday(env.DB_BACKUP_DIR))) {
  await queue.add('db.backup', {}, { jobId: `db-backup-${new Date().toISOString().slice(0, 10)}`, removeOnComplete: true, removeOnFail: true });
}
const prisma = new PrismaService();
const journal = journalServices(prisma, createRedis('worker-journal'));
const notify = notifyServices(prisma);
const notifyMailings = notifyMailingsJob(prisma);
// Telegram-бот (30.09.2026): без публичного адреса вебхука воркер сам забирает обновления (TELEGRAM_BOT_POLLING=1)
const stopTelegramPolling = env.TELEGRAM_BOT_POLLING
  ? (() => {
      const redis = createRedis('worker-telegram');
      const bot = createTelegramBot();
      return startTelegramPolling(bot, new TelegramBotService(prisma, redis, bot, journal.bookings), redis);
    })()
  : () => undefined;

const worker = new Worker(
  SYSTEM,
  async (job) => {
    if (job.name === 'heartbeat') {
      await connection.set('booktime:worker:heartbeat', new Date().toISOString(), 'EX', 180);
      return;
    }
    if (job.name === 'auth.housekeeping') {
      logger.info(await authHousekeeping(prisma), 'auth housekeeping');
      return;
    }
    if (job.name === 'schedule.empty-week') {
      const res = await scheduleEmptyWeek(prisma);
      const sent = await notifyEmptyWeek(prisma, res.staffIds);
      logger.info({ ...res, count: res.staffIds.length, sent }, 'schedule: пустая неделя у мастеров «всё занято»');
      return;
    }
    if (job.name === 'journal.holds') {
      const res = await journalHolds(journal);
      if (res.released.prepayment.length || res.released.confirmation.length || res.freed.subscribers || res.freed.hot || res.freed.taken)
        logger.info(res, 'journal: сняты заявки по сроку / раздача окон');
      return;
    }
    if (job.name === 'journal.series') {
      logger.info(await journalSeries(journal), 'journal: серии продлены');
      return;
    }
    if (job.name === 'notify.dispatch') {
      const res = await notify.dispatch.processDue();
      if (res.sent || res.failed) logger.info(res, 'notify.dispatch');
      return;
    }
    if (job.name === 'notify.mailings') {
      const sent = await notifyMailings();
      if (sent) logger.info({ sent }, 'notify.mailings');
      return;
    }
    if (job.name === 'notify.reminders') {
      const res = await notifyBookingReminders(prisma);
      if (res.sent) logger.info(res, 'notify.reminders');
      return;
    }
    if (job.name === 'billing.tick') {
      const res = await billingDispatch(prisma);
      if (res.warned || res.charged || res.failed || res.grace || res.frozen) logger.info(res, 'billing.tick');
      return;
    }
    if (job.name === 'reports.export') {
      const res = await reportsExportDispatch(prisma);
      if (res.done || res.failed) logger.info(res, 'reports.export');
      return;
    }
    if (job.name === 'webhooks.dispatch') {
      await webhooksDispatch(prisma);
      return;
    }
    if (job.name === 'db.backup') {
      const res = await dbBackup(prisma, env.DB_BACKUP_DIR, env.DB_BACKUP_KEEP);
      logger.info(res, 'db.backup');
      return res;
    }
    if (job.name === 'business.retention') {
      const res = await businessRetentionTick(prisma);
      if (res.businesses || res.clients) logger.info(res, 'business.retention');
      return;
    }
    logger.warn({ job: job.name }, 'unknown system job');
  },
  { connection: createRedis('worker-consumer') },
);
worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'job failed'));
logger.info('worker: очереди запущены');

const stop = async () => {
  stopTelegramPolling();
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
