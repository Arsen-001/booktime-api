import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { CodeChannel } from '../../adapters/code-sender/code-sender.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext, SessionApp, SessionMode } from '../../common/http/context.js';
import { MEMBERSHIP_LISTER, type MembershipLister, type MembershipSummary } from '../../common/http/resolvers.js';
import { SessionStore } from '../../common/http/sessions.js';
import { isLocale, type Locale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { maskPhone, normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { OtpService, type OtpSent } from './otp.service.js';
import { hashPassword, isWeakPassword, verifyPassword } from './passwords.js';

/** Версия пользовательского соглашения, которое клиент принимает при входе (F-14-008; тексты — черновик, В-32) */
export const CONSENT_VERSION = '2026-09-draft';
/** После 5 неверных паролей вход закрыт на 15 минут (03 §6) */
const PASSWORD_MAX_FAILS = 5;
const PASSWORD_LOCK_MIN = 15;

export interface SessionUser {
  id: string;
  name: string;
  phone: string | null;
  locale: Locale;
}

/** Ответ «кто я»: вход, GET /v1/auth/session */
export interface SessionView {
  user: SessionUser;
  app: SessionApp;
  mode: SessionMode;
  activeBusinessId: string | null;
  memberships: MembershipSummary[];
  /** Вход логином администратора — какой у него логин */
  staffLogin: string | null;
  mustChangePassword: boolean;
  /** Клиент принял соглашение (F-14-008) */
  consent: boolean;
}

export interface SecondFactorView {
  secondFactor: { challengeId: string; phoneMasked: string; resendAfter: number; expiresIn: number };
}

type LoginMethod = 'code' | 'password' | 'platform' | 'second_factor';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionStore,
    private readonly audit: AuditService,
    @Inject(MEMBERSHIP_LISTER) private readonly memberships: MembershipLister,
  ) {}

  // ─────────── журнал входов (F-10-106) ───────────

  private async logEvent(
    ctx: RequestContext,
    e: { userId?: string | null; sessionId?: string | null; method: LoginMethod; app: SessionApp; result: string; identifier?: string },
  ): Promise<void> {
    await this.prisma.loginEvent.create({
      data: {
        id: newId('loginEvent'),
        userId: e.userId ?? null,
        sessionId: e.sessionId ?? null,
        method: e.method,
        app: e.app,
        result: e.result,
        identifier: e.identifier?.slice(0, 64) ?? null,
        ip: ctx.ip,
        device: ctx.device,
      },
    });
  }

  // ─────────── «кто я» ───────────

  async view(sessionId: string): Promise<SessionView> {
    const s = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { user: { include: { appProfile: { select: { consentAt: true } } } }, staffLogin: { select: { login: true } } },
    });
    const memberships = s.app === 'platform' ? [] : await this.memberships.list(s.userId, s.staffLoginId);
    return {
      user: { id: s.user.id, name: s.user.name, phone: s.user.phone, locale: isLocale(s.user.locale) ? s.user.locale : 'ru' },
      app: s.app as SessionApp,
      mode: s.mode as SessionMode,
      activeBusinessId: s.activeBusinessId,
      memberships,
      staffLogin: s.staffLogin?.login ?? null,
      mustChangePassword: s.mustChangePassword,
      consent: Boolean(s.user.appProfile?.consentAt),
    };
  }

  // ─────────── вход по коду (F-00-032, F-00-033) ───────────

  sendCode(ctx: RequestContext, input: { phone: string; channel: CodeChannel; locale?: Locale }): Promise<OtpSent> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374XXXXXXXX');
    return this.otp.send({ phone, purpose: 'login', channel: input.channel, ip: ctx.ip, locale: input.locale ?? 'ru' });
  }

  /**
   * Код верный → вход. Клиент: нет такого человека — создаём (нужны имя и согласие, F-14-008).
   * Бизнес: человек тоже находится или создаётся — бизнеса у него может ещё не быть (тогда memberships пуст,
   * и экран ведёт на регистрацию бизнеса, этап 3).
   */
  async verifyCode(
    ctx: RequestContext,
    res: Response,
    input: { phone: string; code: string; app: 'client' | 'business'; name?: string; consent?: boolean; locale?: Locale },
  ): Promise<SessionView> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374XXXXXXXX');
    const existing = await this.prisma.user.findUnique({ where: { phone }, include: { appProfile: { select: { consentAt: true } } } });
    // Согласие проверяем до кода: иначе код потратился бы, а вход не состоялся
    if (input.app === 'client' && !existing?.appProfile?.consentAt && !input.consent) {
      throw new ApiError('consent_required', 'User agreement must be accepted');
    }
    try {
      await this.otp.verify({ phone, purpose: 'login' }, input.code);
    } catch (err) {
      await this.logEvent(ctx, { userId: existing?.id, method: 'code', app: input.app, result: err instanceof ApiError ? err.code : 'error', identifier: maskPhone(phone) });
      throw err;
    }
    if (existing?.blockedAt || existing?.deletedAt) {
      await this.logEvent(ctx, { userId: existing.id, method: 'code', app: input.app, result: 'blocked' });
      throw new ApiError('account_blocked', 'Account is blocked');
    }

    const now = new Date();
    const userId = await this.prisma.$transaction(async (tx) => {
      let id = existing?.id;
      if (!id) {
        id = newId('user');
        const name = input.name?.trim().slice(0, 120) || phone;
        await tx.user.create({ data: { id, phone, name, locale: input.locale ?? 'ru', createdBy: id, updatedBy: id } });
        await this.audit.record(tx, ctx, { action: 'create', entityType: 'user', entityId: id, after: { phone, name } });
      }
      if (input.app === 'client') {
        const consentAt = existing?.appProfile?.consentAt ?? (input.consent ? now : null);
        await tx.appProfile.upsert({
          where: { userId: id },
          create: { userId: id, consentAt, consentVersion: consentAt ? CONSENT_VERSION : null },
          update: existing?.appProfile?.consentAt ? {} : { consentAt, consentVersion: CONSENT_VERSION },
        });
      }
      // F-00-176 (этап 19): салон, подключённый нашей командой на визите, ждёт владельца по номеру телефона —
      // без отдельного приглашения (ConnectHandoff фронта: «шаг 1 — войдите этим номером»). Пришёл именно этот
      // номер бизнес-входом и есть непринятый owner-стул с ним — сразу привязать (та же строка, что заводит
      // ConnectService.finish: userId ещё null). Обычных сотрудников это не касается — те идут через инвайт (F-00-042).
      if (input.app === 'business') {
        const unclaimed = await tx.staff.findFirst({
          where: { phone, role: 'owner', userId: null, deletedAt: null, business: { leftAt: null } },
          orderBy: { createdAt: 'asc' },
        });
        if (unclaimed) {
          await tx.staff.update({
            where: { id: unclaimed.id },
            data: { userId: id, accessEnabled: true, status: unclaimed.status === 'fired' ? 'fired' : 'active', updatedBy: id, version: { increment: 1 } },
          });
          await this.audit.record(tx, { ...ctx, member: null }, { action: 'connectOwnerClaimed', entityType: 'staff', entityId: unclaimed.id, businessId: unclaimed.businessId });
        }
      }
      return id;
    });

    const memberships = input.app === 'business' ? await this.memberships.list(userId) : [];
    const mode: SessionMode = input.app === 'business' ? 'business' : 'client';
    const sessionId = await this.sessions.open(ctx, res, {
      userId,
      app: input.app,
      mode,
      activeBusinessId: memberships[0]?.businessId ?? null,
    });
    await this.logEvent(ctx, { userId, sessionId, method: 'code', app: input.app, result: 'ok' });
    return this.view(sessionId);
  }

  // ─────────── администратор: логин + пароль (F-00-034) + второй шаг (F-15-159) ───────────

  private async checkPassword(
    ctx: RequestContext,
    row: { id: string; userId: string; passwordHash: string; failedAttempts: number; lockedUntil: Date | null; disabledAt: Date | null } | null,
    password: string,
    kind: 'staff' | 'platform',
    login: string,
  ): Promise<void> {
    const app: SessionApp = kind === 'platform' ? 'platform' : 'business';
    const method: LoginMethod = kind === 'platform' ? 'platform' : 'password';
    if (!row) {
      await this.logEvent(ctx, { method, app, result: 'wrong_password', identifier: login });
      throw new ApiError('wrong_password', 'Wrong login or password');
    }
    if (row.disabledAt) {
      await this.logEvent(ctx, { userId: row.userId, method, app, result: 'blocked' });
      throw new ApiError('account_blocked', 'Login is disabled');
    }
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      const wait = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000);
      await this.logEvent(ctx, { userId: row.userId, method, app, result: 'locked' });
      throw new ApiError('account_locked', 'Too many wrong passwords', undefined, wait);
    }
    const ok = await verifyPassword(password, row.passwordHash);
    const table = kind === 'platform' ? this.prisma.platformMember : this.prisma.staffLogin;
    if (!ok) {
      const fails = row.failedAttempts + 1;
      const lock = fails >= PASSWORD_MAX_FAILS;
      await (table as typeof this.prisma.staffLogin).update({
        where: { id: row.id },
        data: lock ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + PASSWORD_LOCK_MIN * 60_000) } : { failedAttempts: fails },
      });
      await this.logEvent(ctx, { userId: row.userId, method, app, result: lock ? 'locked' : 'wrong_password' });
      if (lock) throw new ApiError('account_locked', 'Too many wrong passwords', undefined, PASSWORD_LOCK_MIN * 60);
      throw new ApiError('wrong_password', 'Wrong login or password');
    }
    if (row.failedAttempts || row.lockedUntil) {
      await (table as typeof this.prisma.staffLogin).update({ where: { id: row.id }, data: { failedAttempts: 0, lockedUntil: null } });
    }
  }

  async passwordLogin(
    ctx: RequestContext,
    res: Response,
    input: { login: string; password: string; channel?: CodeChannel },
  ): Promise<(SessionView & { secondFactor?: undefined }) | SecondFactorView> {
    const login = input.login.trim().toLowerCase();
    const row = await this.prisma.staffLogin.findUnique({ where: { login }, include: { user: true } });
    await this.checkPassword(ctx, row, input.password, 'staff', login);
    const sl = row!;
    if (sl.user.blockedAt || sl.user.deletedAt) throw new ApiError('account_blocked', 'Account is blocked');
    if (sl.user.twoFactorEnabled && sl.user.phone) {
      const sent = await this.otp.send({
        phone: sl.user.phone,
        purpose: 'second_factor',
        channel: input.channel ?? 'telegram',
        ip: ctx.ip,
        locale: isLocale(sl.user.locale) ? sl.user.locale : 'ru',
        subjectId: sl.id,
      });
      await this.logEvent(ctx, { userId: sl.userId, method: 'password', app: 'business', result: 'second_factor_sent' });
      return { secondFactor: { challengeId: sent.challengeId, phoneMasked: maskPhone(sl.user.phone), resendAfter: sent.resendAfter, expiresIn: sent.expiresIn } };
    }
    return this.openStaffSession(ctx, res, sl, 'password');
  }

  private async openStaffSession(
    ctx: RequestContext,
    res: Response,
    sl: { id: string; userId: string; businessId: string | null; mustChangePassword: boolean },
    method: LoginMethod,
  ): Promise<SessionView> {
    const sessionId = await this.sessions.open(ctx, res, {
      userId: sl.userId,
      app: 'business',
      mode: 'business',
      activeBusinessId: sl.businessId,
      staffLoginId: sl.id,
      mustChangePassword: sl.mustChangePassword,
    });
    await this.logEvent(ctx, { userId: sl.userId, sessionId, method, app: 'business', result: 'ok' });
    return this.view(sessionId);
  }

  async secondFactor(ctx: RequestContext, res: Response, input: { challengeId: string; code: string }): Promise<SessionView> {
    const otp = await this.otp.verify({ challengeId: input.challengeId, purpose: 'second_factor' }, input.code);
    const sl = await this.prisma.staffLogin.findUnique({ where: { id: otp.subjectId ?? '' } });
    if (!sl || sl.disabledAt) throw new ApiError('account_blocked', 'Login is disabled');
    return this.openStaffSession(ctx, res, sl, 'second_factor');
  }

  /** Смена пароля администратора. После выдачи владельцем (mustChangePassword) старый пароль не спрашиваем. */
  async changePassword(ctx: RequestContext, input: { oldPassword?: string; newPassword: string }): Promise<void> {
    const session = ctx.session!;
    if (!session.staffLoginId) throw new ApiError('forbidden', 'Password login only');
    const sl = await this.prisma.staffLogin.findUniqueOrThrow({ where: { id: session.staffLoginId } });
    if (!session.mustChangePassword) {
      if (!input.oldPassword || !(await verifyPassword(input.oldPassword, sl.passwordHash))) {
        throw new ApiError('wrong_password', 'Current password is wrong');
      }
    }
    if (isWeakPassword(input.newPassword, sl.login)) throw new ApiError('weak_password', 'At least 6 characters, not equal to login');
    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.staffLogin.update({
        where: { id: sl.id },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date(), updatedBy: session.userId, version: { increment: 1 } },
      });
      await tx.session.update({ where: { id: session.sessionId }, data: { mustChangePassword: false } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'staff_login', entityId: sl.id, businessId: sl.businessId, before: { password: 'old' }, after: { password: 'changed' } });
    });
    // Остальные сессии этого входа закрываются: пароль мог утечь
    await this.sessions.revokeAllOfStaffLogin(sl.id, 'password_changed', session.sessionId);
  }

  // ─────────── команда платформы (Р11): логин + пароль + код ───────────

  async platformLogin(ctx: RequestContext, input: { login: string; password: string; channel?: CodeChannel }): Promise<SecondFactorView> {
    const login = input.login.trim().toLowerCase();
    const row = await this.prisma.platformMember.findUnique({ where: { login }, include: { user: true } });
    await this.checkPassword(ctx, row, input.password, 'platform', login);
    const pm = row!;
    if (!pm.user.phone) throw new ApiError('phone_required', 'Platform member has no phone for the code');
    const sent = await this.otp.send({
      phone: pm.user.phone,
      purpose: 'platform',
      channel: input.channel ?? 'telegram',
      ip: ctx.ip,
      locale: isLocale(pm.user.locale) ? pm.user.locale : 'ru',
      subjectId: pm.id,
    });
    await this.logEvent(ctx, { userId: pm.userId, method: 'platform', app: 'platform', result: 'second_factor_sent' });
    return { secondFactor: { challengeId: sent.challengeId, phoneMasked: maskPhone(pm.user.phone), resendAfter: sent.resendAfter, expiresIn: sent.expiresIn } };
  }

  async platformVerify(ctx: RequestContext, res: Response, input: { challengeId: string; code: string }) {
    const otp = await this.otp.verify({ challengeId: input.challengeId, purpose: 'platform' }, input.code);
    const pm = await this.prisma.platformMember.findUnique({ where: { id: otp.subjectId ?? '' }, include: { user: true } });
    if (!pm || pm.disabledAt || pm.user.blockedAt) throw new ApiError('account_blocked', 'Platform login is disabled');
    const sessionId = await this.sessions.open(ctx, res, { userId: pm.userId, app: 'platform', mode: 'client', platformMemberId: pm.id });
    await this.logEvent(ctx, { userId: pm.userId, sessionId, method: 'platform', app: 'platform', result: 'ok' });
    return this.platformView(sessionId);
  }

  async platformView(sessionId: string) {
    const s = await this.prisma.session.findUniqueOrThrow({ where: { id: sessionId }, include: { user: true, platformMember: true } });
    return {
      user: { id: s.user.id, name: s.user.name, phone: s.user.phone, locale: isLocale(s.user.locale) ? s.user.locale : 'ru' },
      login: s.platformMember?.login ?? '',
      role: s.platformMember?.role ?? 'reviewer',
    };
  }

  // ─────────── переключатель «Я клиент / Мой бизнес» (В-21, C1) ───────────

  async setMode(ctx: RequestContext, input: { mode: SessionMode; businessId?: string }): Promise<SessionView> {
    const session = ctx.session!;
    let activeBusinessId: string | null = session.activeBusinessId;
    if (input.mode === 'business') {
      const list = await this.memberships.list(session.userId, session.staffLoginId);
      const pick = input.businessId ? list.find((m) => m.businessId === input.businessId) : (list.find((m) => m.businessId === activeBusinessId) ?? list[0]);
      if (!pick) throw new ApiError('no_business', 'No business for this account');
      activeBusinessId = pick.businessId;
    } else if (session.staffLoginId) {
      // Вход логином администратора — это вход в кабинет салона, клиентского режима у него нет
      throw new ApiError('forbidden', 'Admin login has no client mode');
    }
    await this.prisma.session.update({ where: { id: session.sessionId }, data: { mode: input.mode, activeBusinessId } });
    return this.view(session.sessionId);
  }

  // ─────────── выход ───────────

  async logout(ctx: RequestContext, res: Response, platform: boolean): Promise<void> {
    if (ctx.session) await this.sessions.revoke(ctx.session.sessionId, 'logout');
    this.sessions.clearCookie(res, platform);
  }

  /** «Завершить все сеансы» (F-15-152, F-10-125): keepCurrent — все, кроме этого устройства */
  async logoutAll(ctx: RequestContext, res: Response, keepCurrent: boolean): Promise<{ revoked: number }> {
    const session = ctx.session!;
    const revoked = await this.sessions.revokeAllOfUser(session.userId, keepCurrent ? 'logout_others' : 'logout_all', keepCurrent ? session.sessionId : undefined);
    await this.prisma.user.update({ where: { id: session.userId }, data: { sessionsRevokedAt: new Date() } });
    if (!keepCurrent) this.sessions.clearCookie(res, false);
    return { revoked };
  }
}
