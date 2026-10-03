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
import type { Prisma } from '../../generated/prisma/client.js';
import { AppleIdTokenVerifier, type AppleProfile } from './apple-id-token.js';
import { APPLE_PENDING, APPLE_PENDING_TTL_SEC, type ApplePendingStore } from './apple-pending.js';
import { GoogleIdTokenVerifier, type GoogleProfile } from './google-id-token.js';
import { GOOGLE_PENDING, GOOGLE_PENDING_TTL_SEC, type GooglePendingStore } from './google-pending.js';
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
  /** channel — куда код ушёл на самом деле (Telegram / WhatsApp / SMS): экран пишет «Код отправлен в Telegram на …» */
  secondFactor: { challengeId: string; phoneMasked: string; resendAfter: number; expiresIn: number; channel: CodeChannel };
}

type LoginMethod = 'code' | 'password' | 'platform' | 'second_factor' | 'google' | 'apple';
/** Внешний вход, привязанный к человеку (user_identities.provider) */
type IdentityProvider = 'google' | 'apple';
type PhoneApp = 'client' | 'business';

/** Google-аккаунт ещё не привязан: экран просит номер и код один раз, token — в verify (pendingGoogle) */
export interface PendingGoogleView {
  token: string;
  email: string;
  name: string | null;
  expiresIn: number;
}

/** Ответ «Войти через Google»: либо сессия (аккаунт привязан), либо pendingGoogle (нужен номер и код) */
export interface GoogleLoginView {
  session: SessionView | null;
  pendingGoogle: PendingGoogleView | null;
}

/** Apple-аккаунт ещё не привязан: экран просит номер и код один раз, token — в verify (pendingApple). Почты может не быть */
export interface PendingAppleView {
  token: string;
  email: string | null;
  name: string | null;
  expiresIn: number;
}

/** Ответ «Войти через Apple»: либо сессия (аккаунт привязан), либо pendingApple (нужен номер и код) */
export interface AppleLoginView {
  session: SessionView | null;
  pendingApple: PendingAppleView | null;
}

/** «Google: a•••@gmail.com» — в журнал входов, без полной почты */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`.slice(0, 64);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionStore,
    private readonly audit: AuditService,
    @Inject(MEMBERSHIP_LISTER) private readonly memberships: MembershipLister,
    @Inject(GoogleIdTokenVerifier) private readonly google: GoogleIdTokenVerifier,
    @Inject(GOOGLE_PENDING) private readonly googlePending: GooglePendingStore,
    @Inject(AppleIdTokenVerifier) private readonly apple: AppleIdTokenVerifier,
    @Inject(APPLE_PENDING) private readonly applePending: ApplePendingStore,
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

  /** Куда можно прислать код: Telegram (всегда), WhatsApp и SMS — если настроены (03.10.2026) */
  codeChannels(): { channels: CodeChannel[] } {
    return { channels: this.otp.channels() };
  }

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
    input: { phone: string; code: string; app: PhoneApp; name?: string; consent?: boolean; locale?: Locale; pendingGoogle?: string; pendingApple?: string },
  ): Promise<SessionView & { googleLinked?: boolean; appleLinked?: boolean }> {
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
    // «Войти через Google» с непривязанным аккаунтом (03.10.2026): номер подтверждён кодом — только теперь Google
    // привязывается к человеку с этим номером. Токен одноразовый и гасится здесь; истёк — вход по коду всё равно идёт.
    const google = input.pendingGoogle ? await this.googlePending.take(input.pendingGoogle) : null;
    // То же для «Войти через Apple»; пришли оба токена — привязываются оба
    const apple = input.pendingApple ? await this.applePending.take(input.pendingApple) : null;

    const now = new Date();
    let googleLinked = false;
    let appleLinked = false;
    const userId = await this.prisma.$transaction(async (tx) => {
      let id = existing?.id;
      if (!id) {
        id = newId('user');
        const name = input.name?.trim().slice(0, 120) || google?.name || apple?.name || phone;
        await tx.user.create({ data: { id, phone, name, locale: input.locale ?? 'ru', createdBy: id, updatedBy: id } });
        await this.audit.record(tx, ctx, { action: 'create', entityType: 'user', entityId: id, after: { phone, name } });
      }
      await this.prepareAppAccess(tx, ctx, { userId: id, phone, app: input.app, consentAt: existing?.appProfile?.consentAt ?? null, consent: input.consent, now });
      if (google) googleLinked = await this.attachIdentity(tx, ctx, id, 'google', google, now);
      if (apple) appleLinked = await this.attachIdentity(tx, ctx, id, 'apple', apple, now);
      return id;
    });

    const sessionId = await this.openPhoneSession(ctx, res, userId, input.app, 'code');
    const linked: { googleLinked?: boolean; appleLinked?: boolean } = {};
    if (input.pendingGoogle) {
      await this.logEvent(ctx, {
        userId,
        sessionId,
        method: 'google',
        app: input.app,
        result: googleLinked ? 'google_linked' : google ? 'google_taken' : 'google_expired',
        identifier: google ? maskEmail(google.email) : undefined,
      });
      linked.googleLinked = googleLinked;
    }
    if (input.pendingApple) {
      await this.logEvent(ctx, {
        userId,
        sessionId,
        method: 'apple',
        app: input.app,
        result: appleLinked ? 'apple_linked' : apple ? 'apple_taken' : 'apple_expired',
        identifier: apple?.email ? maskEmail(apple.email) : undefined,
      });
      linked.appleLinked = appleLinked;
    }
    return { ...(await this.view(sessionId)), ...linked };
  }

  /**
   * Что нужно человеку, вошедшему по номеру (кодом или привязанным Google), до открытия сессии: клиенту — профиль
   * приложения и согласие (F-14-008); бизнесу — салон, подключённый нашей командой, ждущий владельца по номеру.
   */
  private async prepareAppAccess(
    tx: Prisma.TransactionClient,
    ctx: RequestContext,
    a: { userId: string; phone: string; app: PhoneApp; consentAt: Date | null; consent?: boolean; now: Date },
  ): Promise<void> {
    if (a.app === 'client') {
      const consentAt = a.consentAt ?? (a.consent ? a.now : null);
      await tx.appProfile.upsert({
        where: { userId: a.userId },
        create: { userId: a.userId, consentAt, consentVersion: consentAt ? CONSENT_VERSION : null },
        update: a.consentAt ? {} : { consentAt, consentVersion: CONSENT_VERSION },
      });
      return;
    }
    // F-00-176 (этап 19): салон, подключённый нашей командой на визите, ждёт владельца по номеру телефона —
    // без отдельного приглашения (ConnectHandoff фронта: «шаг 1 — войдите этим номером»). Пришёл именно этот
    // номер бизнес-входом и есть непринятый owner-стул с ним — сразу привязать (та же строка, что заводит
    // ConnectService.finish: userId ещё null). Обычных сотрудников это не касается — те идут через инвайт (F-00-042).
    const unclaimed = await tx.staff.findFirst({
      where: { phone: a.phone, role: 'owner', userId: null, deletedAt: null, business: { leftAt: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (unclaimed) {
      await tx.staff.update({
        where: { id: unclaimed.id },
        data: { userId: a.userId, accessEnabled: true, status: unclaimed.status === 'fired' ? 'fired' : 'active', updatedBy: a.userId, version: { increment: 1 } },
      });
      await this.audit.record(tx, { ...ctx, member: null }, { action: 'connectOwnerClaimed', entityType: 'staff', entityId: unclaimed.id, businessId: unclaimed.businessId });
    }
  }

  /** Сессия человека с номером (вход кодом или Google): бизнес — первый из его бизнесов */
  private async openPhoneSession(ctx: RequestContext, res: Response, userId: string, app: PhoneApp, method: LoginMethod): Promise<string> {
    const memberships = app === 'business' ? await this.memberships.list(userId) : [];
    const sessionId = await this.sessions.open(ctx, res, {
      userId,
      app,
      mode: app === 'business' ? 'business' : 'client',
      activeBusinessId: memberships[0]?.businessId ?? null,
    });
    await this.logEvent(ctx, { userId, sessionId, method, app, result: 'ok' });
    return sessionId;
  }

  // ─────────── «Войти через Google» (03.10.2026) ───────────

  /**
   * Привязать внешний вход (Google, Apple) к человеку. Этот аккаунт уже у другого человека — false (чужой вход не
   * перехватываем). У человека был другой аккаунт того же провайдера — заменяется: один на человека (unique userId+provider).
   * Аудит — googleLinked / appleLinked. Apple даёт почту не всегда: нет в этот раз — прежняя остаётся.
   */
  private async attachIdentity(
    tx: Prisma.TransactionClient,
    ctx: RequestContext,
    userId: string,
    provider: IdentityProvider,
    p: { sub: string; email: string | null },
    now: Date,
  ): Promise<boolean> {
    const found = await tx.userIdentity.findUnique({ where: { provider_subject: { provider, subject: p.sub } } });
    if (found && found.userId !== userId) return false;
    if (found) {
      await tx.userIdentity.update({ where: { id: found.id }, data: { email: p.email ?? found.email, lastUsedAt: now } });
      return true;
    }
    const before = await tx.userIdentity.findFirst({ where: { userId, provider }, select: { email: true } });
    await tx.userIdentity.deleteMany({ where: { userId, provider } });
    await tx.userIdentity.create({ data: { id: newId('userIdentity'), provider, subject: p.sub, email: p.email, userId, lastUsedAt: now } });
    await this.audit.record(tx, { ...ctx, member: null }, {
      action: provider === 'google' ? 'googleLinked' : 'appleLinked',
      entityType: 'user',
      entityId: userId,
      before: before ? { [provider]: before.email } : undefined,
      after: { [provider]: p.email },
    });
    return true;
  }

  /**
   * POST /v1/auth/google. Google ID token проверен → аккаунт привязан — сразу сессия (как после кода);
   * не привязан — pendingGoogle: номер обязателен (вся система — на номере), его подтверждает только код.
   * Почта Google с номером не сопоставляется и человека не находит — иначе Google-входом можно было бы занять чужой номер.
   */
  async googleLogin(ctx: RequestContext, res: Response, input: { idToken: string; app: PhoneApp; consent?: boolean }): Promise<GoogleLoginView> {
    let profile: GoogleProfile;
    try {
      profile = await this.google.verify(input.idToken);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'google_invalid') {
        await this.logEvent(ctx, { method: 'google', app: input.app, result: 'google_invalid' });
      }
      throw err;
    }
    const identity = await this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: 'google', subject: profile.sub } },
      include: { user: { include: { appProfile: { select: { consentAt: true } } } } },
    });
    if (!identity) {
      const token = await this.googlePending.put(profile);
      await this.logEvent(ctx, { method: 'google', app: input.app, result: 'google_unlinked', identifier: maskEmail(profile.email) });
      return { session: null, pendingGoogle: { token, email: profile.email, name: profile.name, expiresIn: GOOGLE_PENDING_TTL_SEC } };
    }
    const user = identity.user;
    if (user.blockedAt || user.deletedAt || !user.phone) {
      await this.logEvent(ctx, { userId: user.id, method: 'google', app: input.app, result: 'blocked' });
      throw new ApiError('account_blocked', 'Account is blocked');
    }
    const consentAt = user.appProfile?.consentAt ?? null;
    if (input.app === 'client' && !consentAt && !input.consent) throw new ApiError('consent_required', 'User agreement must be accepted');
    const now = new Date();
    const phone = user.phone;
    await this.prisma.$transaction(async (tx) => {
      await tx.userIdentity.update({ where: { id: identity.id }, data: { email: profile.email, lastUsedAt: now } });
      await this.prepareAppAccess(tx, ctx, { userId: user.id, phone, app: input.app, consentAt, consent: input.consent, now });
    });
    const sessionId = await this.openPhoneSession(ctx, res, user.id, input.app, 'google');
    return { session: await this.view(sessionId), pendingGoogle: null };
  }

  // ─────────── «Войти через Apple» (03.10.2026) ───────────

  /**
   * POST /v1/auth/apple — как googleLogin. Identity token проверен → Apple привязан — сразу сессия; не привязан —
   * pendingApple: номер подтверждает только код. Почта Apple (если есть) с номером не сопоставляется.
   * name — имя из первого ответа Apple приложению: в токене его нет, а нужно для нового человека.
   */
  async appleLogin(
    ctx: RequestContext,
    res: Response,
    input: { identityToken: string; app: PhoneApp; consent?: boolean; name?: string },
  ): Promise<AppleLoginView> {
    let profile: AppleProfile;
    try {
      profile = await this.apple.verify(input.identityToken);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'apple_invalid') {
        await this.logEvent(ctx, { method: 'apple', app: input.app, result: 'apple_invalid' });
      }
      throw err;
    }
    const identifier = profile.email ? maskEmail(profile.email) : undefined;
    const identity = await this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: 'apple', subject: profile.sub } },
      include: { user: { include: { appProfile: { select: { consentAt: true } } } } },
    });
    if (!identity) {
      const name = input.name?.trim().slice(0, 120) || null;
      const pending: AppleProfile = { ...profile, name };
      const token = await this.applePending.put(pending);
      await this.logEvent(ctx, { method: 'apple', app: input.app, result: 'apple_unlinked', identifier });
      return { session: null, pendingApple: { token, email: pending.email, name, expiresIn: APPLE_PENDING_TTL_SEC } };
    }
    const user = identity.user;
    if (user.blockedAt || user.deletedAt || !user.phone) {
      await this.logEvent(ctx, { userId: user.id, method: 'apple', app: input.app, result: 'blocked', identifier });
      throw new ApiError('account_blocked', 'Account is blocked');
    }
    const consentAt = user.appProfile?.consentAt ?? null;
    if (input.app === 'client' && !consentAt && !input.consent) throw new ApiError('consent_required', 'User agreement must be accepted');
    const now = new Date();
    const phone = user.phone;
    await this.prisma.$transaction(async (tx) => {
      await tx.userIdentity.update({ where: { id: identity.id }, data: { email: profile.email ?? identity.email, lastUsedAt: now } });
      await this.prepareAppAccess(tx, ctx, { userId: user.id, phone, app: input.app, consentAt, consent: input.consent, now });
    });
    const sessionId = await this.openPhoneSession(ctx, res, user.id, input.app, 'apple');
    return { session: await this.view(sessionId), pendingApple: null };
  }

  /** Привязан ли Google к вошедшему (профиль) и включён ли вход через Google на сервере */
  async googleStatus(ctx: RequestContext): Promise<{ enabled: boolean; email: string | null }> {
    const row = await this.prisma.userIdentity.findFirst({ where: { userId: ctx.session!.userId, provider: 'google' }, select: { email: true } });
    return { enabled: this.google.enabled, email: row ? (row.email ?? '') : null };
  }

  /** Привязать Google из профиля вошедшего по номеру человека (не из входа администратора по логину) */
  async linkGoogle(ctx: RequestContext, input: { idToken: string }): Promise<{ enabled: boolean; email: string | null }> {
    const session = ctx.session!;
    if (session.staffLoginId || session.platformMemberId) throw new ApiError('forbidden', 'Phone sign-in only');
    const profile = await this.google.verify(input.idToken);
    const linked = await this.prisma.$transaction((tx) => this.attachIdentity(tx, ctx, session.userId, 'google', profile, new Date()));
    await this.logEvent(ctx, { userId: session.userId, sessionId: session.sessionId, method: 'google', app: session.app, result: linked ? 'google_linked' : 'google_taken', identifier: maskEmail(profile.email) });
    if (!linked) throw new ApiError('google_taken', 'This Google account is linked to another user');
    return this.googleStatus(ctx);
  }

  /** Отвязать Google: дальше вход только по номеру и коду */
  async unlinkGoogle(ctx: RequestContext): Promise<{ enabled: boolean; email: string | null }> {
    const session = ctx.session!;
    const row = await this.prisma.userIdentity.findFirst({ where: { userId: session.userId, provider: 'google' } });
    if (row) {
      await this.prisma.$transaction(async (tx) => {
        await tx.userIdentity.delete({ where: { id: row.id } });
        await this.audit.record(tx, { ...ctx, member: null }, { action: 'googleUnlinked', entityType: 'user', entityId: session.userId, before: { google: row.email } });
      });
    }
    return this.googleStatus(ctx);
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
      return { secondFactor: { challengeId: sent.challengeId, phoneMasked: maskPhone(sl.user.phone), resendAfter: sent.resendAfter, expiresIn: sent.expiresIn, channel: sent.channel } };
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
    return { secondFactor: { challengeId: sent.challengeId, phoneMasked: maskPhone(pm.user.phone), resendAfter: sent.resendAfter, expiresIn: sent.expiresIn, channel: sent.channel } };
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
