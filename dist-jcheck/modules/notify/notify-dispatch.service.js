var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Inject, Injectable } from '@nestjs/common';
import { PUSH_SENDERS } from '../../adapters/adapters.js';
import { logger } from '../../common/logging/logger.js';
import { PrismaService } from '../../common/prisma.service.js';
import { isKindEnabled } from './notify-types.service.js';
import { QUIET_HOURS_KINDS } from './kinds.js';
import { inQuietHours, nextQuietHoursEnd } from './quiet-hours.js';
const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 3, 10, 30, 60]; // минут — растущая пауза между попытками
/**
 * Отправитель очереди (docs/backend/05 §4): забирает готовые строки notify_outbox и шлёт push настоящим
 * токенам (PushToken). Каждая строка обрабатывается независимо — сбой одной не роняет остальные (важно: это
 * читает воркер каждые ~30 с, PLAN.md Р10).
 */
let NotifyDispatchService = class NotifyDispatchService {
    constructor(prisma, senders) {
        this.prisma = prisma;
        this.senders = senders;
    }
    async processDue(limit = 200) {
        const now = new Date();
        const rows = await this.prisma.notifyOutbox.findMany({ where: { status: 'queued', sendAt: { lte: now } }, orderBy: { sendAt: 'asc' }, take: limit });
        const res = { sent: 0, skipped: 0, failed: 0, deferred: 0 };
        for (const row of rows) {
            try {
                res[await this.processOne(row, now)]++;
            }
            catch (err) {
                logger.error({ err, outboxId: row.id }, 'notify.dispatch: строка упала целиком');
                res.deferred++;
            }
        }
        return res;
    }
    async processOne(row, now) {
        if (QUIET_HOURS_KINDS.has(row.kind) && inQuietHours(now)) {
            await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { sendAt: nextQuietHoursEnd(now) } });
            return 'deferred';
        }
        if (row.businessId && !(await isKindEnabled(this.prisma, row.businessId, row.kind))) {
            await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'skipped', sentAt: now, lastError: 'type_disabled' } });
            return 'skipped';
        }
        const tokens = await this.prisma.pushToken.findMany({ where: { userId: row.recipientUserId, app: row.app, invalidAt: null } });
        if (tokens.length === 0) {
            await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'skipped', sentAt: now, lastError: 'no_push_token' } });
            return 'skipped';
        }
        let anyOk = false;
        for (const token of tokens) {
            const sender = token.platform === 'web' ? this.senders.web : this.senders.fcm;
            const ok = await sender.send({ token: token.token, subscription: token.subscription ?? undefined }, { title: row.title, body: row.body, url: row.url ?? undefined });
            if (ok)
                anyOk = true;
            else
                await this.prisma.pushToken.update({ where: { id: token.id }, data: { invalidAt: now } });
        }
        if (anyOk) {
            await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'sent', sentAt: now } });
            return 'sent';
        }
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
            await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { status: 'failed', attempts, sentAt: now, lastError: 'send_failed' } });
            return 'failed';
        }
        const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] ?? 60;
        await this.prisma.notifyOutbox.update({ where: { id: row.id }, data: { attempts, sendAt: new Date(now.getTime() + wait * 60_000), lastError: 'send_failed' } });
        return 'deferred';
    }
};
NotifyDispatchService = __decorate([
    Injectable(),
    __param(1, Inject(PUSH_SENDERS)),
    __metadata("design:paramtypes", [PrismaService, Object])
], NotifyDispatchService);
export { NotifyDispatchService };
//# sourceMappingURL=notify-dispatch.service.js.map