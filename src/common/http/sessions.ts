import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { isLocale } from '../i18n/i18n.js';
import { newId } from '../ids/ids.js';
import { PrismaService } from '../prisma.service.js';
import { PLATFORM_COOKIE, SESSION_COOKIE, type RequestContext, type SessionApp, type SessionInfo, type SessionMode } from './context.js';
import type { SessionResolver } from './resolvers.js';

/** Отметку «был в сети» и продление срока пишем не чаще раза в 5 минут — не на каждый запрос */
const TOUCH_EVERY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OpenSessionInput {
  userId: string;
  app: SessionApp;
  mode: SessionMode;
  activeBusinessId?: string | null;
  staffLoginId?: string | null;
  platformMemberId?: string | null;
  mustChangePassword?: boolean;
}

export type SessionRevokeReason = 'logout' | 'logout_all' | 'logout_others' | 'password_changed' | 'disabled' | 'deleted' | 'expired' | 'blocked';

/**
 * Сессии в базе (PLAN.md Р8): в браузере — только случайный токен в httpOnly cookie, в базе — его sha256.
 * Отзыв действует со следующего запроса: резолвер читает базу на каждом запросе (500 салонов — Р20 — это выдерживает).
 */
@Injectable()
export class SessionStore implements SessionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(token: string): Promise<SessionInfo | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const s = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: { select: { locale: true, blockedAt: true, deletedAt: true } },
        staffLogin: { select: { disabledAt: true } },
        platformMember: { select: { disabledAt: true } },
      },
    });
    const now = Date.now();
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now) return null;
    if (s.user.blockedAt || s.user.deletedAt) return null;
    if (s.staffLogin?.disabledAt || s.platformMember?.disabledAt) return null;
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
      app: s.app as SessionApp,
      mode: s.mode as SessionMode,
      activeBusinessId: s.activeBusinessId,
      staffLoginId: s.staffLoginId,
      platformMemberId: s.platformMemberId,
      mustChangePassword: s.mustChangePassword,
    };
  }

  /** Открыть сессию и поставить cookie. Возвращает id сессии. */
  async open(ctx: RequestContext, res: Response, input: OpenSessionInput): Promise<string> {
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

  clearCookie(res: Response, platform: boolean): void {
    res.clearCookie(platform ? PLATFORM_COOKIE : SESSION_COOKIE, this.cookieOptions());
  }

  private cookieOptions(maxAge?: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: env.COOKIE_SECURE,
      path: '/',
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
      ...(maxAge ? { maxAge } : {}),
    };
  }

  async revoke(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  }

  /** Все сессии человека (кроме exceptSessionId) — «Завершить все сеансы» (F-15-152), удаление, блокировка */
  async revokeAllOfUser(userId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
    const res = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return res.count;
  }

  /** Все сессии входа администратора — отключение (F-00-040), смена пароля. Этап 3 зовёт при отключении сотрудника. */
  async revokeAllOfStaffLogin(staffLoginId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
    const res = await this.prisma.session.updateMany({
      where: { staffLoginId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return res.count;
  }
}
