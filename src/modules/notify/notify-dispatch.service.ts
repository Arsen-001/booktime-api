import { Inject, Injectable } from '@nestjs/common';
import { PUSH_SENDERS, TELEGRAM_BOT } from '../../adapters/adapters.js';
import type { PushSenders } from '../../adapters/push/push.js';
import { TelegramBlockedError, type ReplyMarkup, type TelegramBot } from '../../adapters/telegram-bot/telegram-bot.js';
import { logger } from '../../common/logging/logger.js';
import { PrismaService } from '../../common/prisma.service.js';
import { isKindEnabled } from './notify-types.service.js';
import { QUIET_HOURS_KINDS } from './kinds.js';
import { inQuietHours, nextQuietHoursEnd } from './quiet-hours.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 3, 10, 30, 60]; // минут — растущая пауза между попытками

type Outcome = 'sent' | 'skipped' | 'failed' | 'deferred';

/**
 * Отправитель очереди (docs/backend/05 §4): забирает готовые строки notify_outbox и шлёт push настоящим
 * токенам (PushToken). Каждая строка обрабатывается независимо — сбой одной не роняет остальные (важно: это
 * читает воркер каждые ~30 с, PLAN.md Р10).
 */
@Injectable()
export class NotifyDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SENDERS) private readonly senders: PushSenders,
    @Inject(TELEGRAM_BOT) private readonly telegram: TelegramBot,
  ) {}

  async processDue(limit = 200): Promise<Record<Outcome, number>> {
    const now = new Date();
    const rows = await this.prisma.notifyOutbox.findMany({ where: { status: 'queued', sendAt: { lte: now } }, orderBy: { sendAt: 'asc' }, take: limit });
    const res: Record<Outcome, number> = { sent: 0, skipped: 0, failed: 0, deferred: 0 };
    for (const row of rows) {
      try {
        res[await this.processOne(row, now)]++;
      } catch (err) {
        logger.error({ err, outboxId: row.id }, 'notify.dispatch: строка упала целиком');
        res.deferred++;
      }
    }
    return res;
  }

  private async processOne(row: { id: string; businessId: string | null; app: string; kind: string; recipientUserId: string; title: string; body: string; url: string | null; attempts: number; meta: unknown }, now: Date): Promise<Outcome> {
    if (QUIET_HOURS_KINDS.has(row.kind) && inQuietHours(now)) {
      await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { sendAt: nextQuietHoursEnd(now) } });
      return 'deferred';
    }
    if (row.businessId && !(await isKindEnabled(this.prisma, row.businessId, row.kind))) {
      await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'skipped', sentAt: now, lastError: 'type_disabled' } });
      return 'skipped';
    }
    if (row.app === 'telegram') return this.sendTelegram(row, now);
    const tokens = await this.prisma.pushToken.findMany({ where: { userId: row.recipientUserId, app: row.app, invalidAt: null } });
    if (tokens.length === 0) {
      await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'skipped', sentAt: now, lastError: 'no_push_token' } });
      return 'skipped';
    }
    let anyOk = false;
    for (const token of tokens) {
      const sender = token.platform === 'web' ? this.senders.web : this.senders.fcm;
      const ok = await sender.send({ token: token.token, subscription: token.subscription ?? undefined }, { title: row.title, body: row.body, url: row.url ?? undefined });
      if (ok) anyOk = true;
      else await this.prisma.pushToken.update({ where: { id: token.id }, data: { invalidAt: now } });
    }
    if (anyOk) {
      await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'sent', sentAt: now } });
      return 'sent';
    }
    return this.retryLater(row, now);
  }

  /**
   * Telegram-бот напоминаний (30.09.2026): recipientUserId — chat id, текст целиком в body, кнопки — meta.replyMarkup.
   * Чат остановлен (/stop) или бот заблокирован (403) — строка пропускается, дальше этот чат не беспокоим.
   */
  private async sendTelegram(row: { id: string; recipientUserId: string; body: string; attempts: number; meta: unknown }, now: Date): Promise<Outcome> {
    const link = await this.prisma.telegramLink.findUnique({ where: { chatId: row.recipientUserId }, select: { blockedAt: true } });
    if (!link || link.blockedAt) {
      await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'skipped', sentAt: now, lastError: 'telegram_blocked' } });
      return 'skipped';
    }
    try {
      await this.telegram.sendMessage(row.recipientUserId, row.body, (row.meta as { replyMarkup?: ReplyMarkup } | null)?.replyMarkup);
    } catch (err) {
      if (err instanceof TelegramBlockedError) {
        await this.prisma.telegramLink.update({ where: { chatId: row.recipientUserId }, data: { blockedAt: now } });
        await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'skipped', sentAt: now, lastError: 'telegram_blocked' } });
        return 'skipped';
      }
      logger.warn({ err, outboxId: row.id }, 'notify.dispatch: telegram не отправлен');
      return this.retryLater(row, now);
    }
    await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'sent', sentAt: now } });
    return 'sent';
  }

  private async retryLater(row: { id: string; attempts: number }, now: Date): Promise<Outcome> {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'failed', attempts, sentAt: now, lastError: 'send_failed' } });
      return 'failed';
    }
    const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] ?? 60;
    await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { attempts, sendAt: new Date(now.getTime() + wait * 60_000), lastError: 'send_failed' } });
    return 'deferred';
  }
}
