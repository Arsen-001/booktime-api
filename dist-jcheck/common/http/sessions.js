var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { isLocale } from '../i18n/i18n.js';
import { newId } from '../ids/ids.js';
import { PrismaService } from '../prisma.service.js';
import { PLATFORM_COOKIE, SESSION_COOKIE } from './context.js';
/** Отметку «был в сети» и продление срока пишем не чаще раза в 5 минут — не на каждый запрос */
const TOUCH_EVERY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
export function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
/**
 * Сессии в базе (PLAN.md Р8): в браузере — только случайный токен в httpOnly cookie, в базе — его sha256.
 * Отзыв действует со следующего запроса: резолвер читает базу на каждом запросе (500 салонов — Р20 — это выдерживает).
 */
let SessionStore = class SessionStore {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async resolve(token) {
        if (!/^[A-Za-z0-9_-]{20,100}$/.test(token))
            return null;
        const s = await this.prisma.session.findUnique({
            where: { tokenHash: hashToken(token) },
            include: {
                user: { select: { locale: true, blockedAt: true, deletedAt: true } },
                staffLogin: { select: { disabledAt: true } },
                platformMember: { select: { disabledAt: true } },
            },
        });
        const now = Date.now();
        if (!s || s.revokedAt || s.expiresAt.getTime() <= now)
            return null;
        if (s.user.blockedAt || s.user.deletedAt)
            return null;
        if (s.staffLogin?.disabledAt || s.platformMember?.disabledAt)
            return null;
        if (now - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
            await this.prisma.session.update({
                where: { id: s.id },
                data: { lastSeenAt: new Date(now), expiresAt: new Date(now + env.SESSION_TTL_DAYS * DAY_MS) },
            });
        }
        return {
            sessionId: s.id,
            userId: s.userId,
            locale: isLocale(s.user.locale) ? s.user.locale : 'ru',
            platform: s.app === 'platform' || undefined,
            app: s.app,
            mode: s.mode,
            activeBusinessId: s.activeBusinessId,
            staffLoginId: s.staffLoginId,
            platformMemberId: s.platformMemberId,
            mustChangePassword: s.mustChangePassword,
        };
    }
    /** Открыть сессию и поставить cookie. Возвращает id сессии. */
    async open(ctx, res, input) {
        const token = randomBytes(32).toString('base64url');
        const id = newId('session');
        const now = Date.now();
        await this.prisma.session.create({
            data: {
                id,
                tokenHash: hashToken(token),
                userId: input.userId,
                app: input.app,
                mode: input.mode,
                activeBusinessId: input.activeBusinessId ?? null,
                staffLoginId: input.staffLoginId ?? null,
                platformMemberId: input.platformMemberId ?? null,
                mustChangePassword: input.mustChangePassword ?? false,
                device: ctx.device,
                ip: ctx.ip,
                expiresAt: new Date(now + env.SESSION_TTL_DAYS * DAY_MS),
            },
        });
        res.cookie(input.app === 'platform' ? PLATFORM_COOKIE : SESSION_COOKIE, token, this.cookieOptions(env.SESSION_TTL_DAYS * DAY_MS));
        return id;
    }
    clearCookie(res, platform) {
        res.clearCookie(platform ? PLATFORM_COOKIE : SESSION_COOKIE, this.cookieOptions());
    }
    cookieOptions(maxAge) {
        return {
            httpOnly: true,
            sameSite: 'lax',
            secure: env.COOKIE_SECURE,
            path: '/',
            ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
            ...(maxAge ? { maxAge } : {}),
        };
    }
    async revoke(sessionId, reason) {
        await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    }
    /** Все сессии человека (кроме exceptSessionId) — «Завершить все сеансы» (F-15-152), удаление, блокировка */
    async revokeAllOfUser(userId, reason, exceptSessionId) {
        const res = await this.prisma.session.updateMany({
            where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
            data: { revokedAt: new Date(), revokeReason: reason },
        });
        return res.count;
    }
    /** Все сессии входа администратора — отключение (F-00-040), смена пароля. Этап 3 зовёт при отключении сотрудника. */
    async revokeAllOfStaffLogin(staffLoginId, reason, exceptSessionId) {
        const res = await this.prisma.session.updateMany({
            where: { staffLoginId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
            data: { revokedAt: new Date(), revokeReason: reason },
        });
        return res.count;
    }
};
SessionStore = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], SessionStore);
export { SessionStore };
//# sourceMappingURL=sessions.js.map