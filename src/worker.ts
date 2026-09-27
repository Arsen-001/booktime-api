import 'reflect-metadata';
import { Queue, Worker } from 'bullmq';
import { createRedis } from './common/redis.js';
import { logger } from './common/logging/logger.js';
import { PrismaService } from './common/prisma.service.js';
import { authHousekeeping } from './jobs/auth-housekeeping.js';
import { scheduleEmptyWeek } from './jobs/schedule-empty-week.js';

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
const prisma = new PrismaService();

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
      logger.info({ ...res, count: res.staffIds.length }, 'schedule: пустая неделя у мастеров «всё занято»');
      return;
    }
    logger.warn({ job: job.name }, 'unknown system job');
  },
  { connection: createRedis('worker-consumer') },
);
worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'job failed'));
logger.info('worker: очереди запущены');

const stop = async () => {
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
