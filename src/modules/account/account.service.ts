import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { SessionStore } from '../../common/http/sessions.js';
import { updateVersioned } from '../../common/http/version.js';
import { isLocale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { CONSENT_VERSION } from '../auth/auth.service.js';
import { OtpService } from '../auth/otp.service.js';
import type { patchAccountBody, pushTokenBody } from './account.schemas.js';

/** Удаление аккаунта наступает через 25 дней после запроса, до того — можно отменить (F-10-129, F-15-158) */
export const ACCOUNT_DELETION_DAYS = 25;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const PROFILE_KEYS = ['gender', 'birthday', 'district', 'photoUrl', 'bigFont', 'timeFormat'] as const;

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly otp: OtpService,
    private readonly sessions: SessionStore,
  ) {}

  async get(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { appProfile: true } });
    const p = u.appProfile;
    return {
      id: u.id,
      name: u.name,
      phone: u.phone,
      locale: isLocale(u.locale) ? u.locale : ('ru' as const),
      twoFactorEnabled: u.twoFactorEnabled,
      sessionsRevokedAt: iso(u.sessionsRevokedAt),
      deleteRequestedAt: iso(u.deleteRequestedAt),
      deletionAt: u.deleteRequestedAt ? new Date(u.deleteRequestedAt.getTime() + ACCOUNT_DELETION_DAYS * 86_400_000).toISOString() : null,
      profile: p
        ? {
            gender: p.gender,
            birthday: p.birthday,
            district: p.district,
            photoUrl: p.photoUrl,
            bigFont: p.bigFont,
            timeFormat: p.timeFormat,
            consentAt: iso(p.consentAt),
          }
        : null,
      version: u.version,
    };
  }

  /** Имя, язык, профиль клиента (F-00-124). If-Match — версия пользователя. */
  async patch(ctx: RequestContext, input: z.infer<typeof patchAccountBody>, expectedVersion: number | undefined) {
    const userId = ctx.session!.userId;
    const before = await this.get(userId);
    const userData: Record<string, unknown> = { updatedBy: userId };
    if (input.name !== undefined) userData.name = input.name;
    if (input.locale !== undefined) userData.locale = input.locale;
    const profileData: Record<string, unknown> = {};
    for (const k of PROFILE_KEYS) if (input[k] !== undefined) profileData[k] = input[k];
    await this.prisma.$transaction(async (tx) => {
      await updateVersioned(tx.user as never, { id: userId }, expectedVersion, userData);
      if (Object.keys(profileData).length) {
        await tx.appProfile.upsert({ where: { userId }, create: { userId, ...profileData }, update: { ...profileData, version: { increment: 1 } } });
      }
      await this.audit.record(tx, ctx, {
        action: 'update',
        entityType: 'user',
        entityId: userId,
        before: { name: before.name, locale: before.locale, ...(before.profile ?? {}) },
        after: { name: before.name, locale: before.locale, ...(before.profile ?? {}), ...userData, ...profileData, updatedBy: undefined },
      });
    });
    return this.get(userId);
  }

  async consent(userId: string) {
    const p = await this.prisma.appProfile.findUnique({ where: { userId }, select: { consentAt: true, consentVersion: true } });
    return { accepted: Boolean(p?.consentAt), at: iso(p?.consentAt), version: p?.consentVersion ?? null };
  }

  async acceptConsent(userId: string) {
    await this.prisma.appProfile.upsert({
      where: { userId },
      create: { userId, consentAt: new Date(), consentVersion: CONSENT_VERSION },
      update: { consentAt: new Date(), consentVersion: CONSENT_VERSION },
    });
    return this.consent(userId);
  }

  async requestDeletion(ctx: RequestContext) {
    const userId = ctx.session!.userId;
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (u.deleteRequestedAt) return;
      const at = new Date();
      await tx.user.update({ where: { id: userId }, data: { deleteRequestedAt: at, updatedBy: userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'delete_request', entityType: 'user', entityId: userId, before: { deleteRequestedAt: null }, after: { deleteRequestedAt: at.toISOString() } });
    });
    return this.get(userId);
  }

  async cancelDeletion(ctx: RequestContext) {
    const userId = ctx.session!.userId;
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (!u.deleteRequestedAt) return;
      await tx.user.update({ where: { id: userId }, data: { deleteRequestedAt: null, updatedBy: userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'delete_cancel', entityType: 'user', entityId: userId, before: { deleteRequestedAt: u.deleteRequestedAt.toISOString() }, after: { deleteRequestedAt: null } });
    });
    return this.get(userId);
  }

  // ─────────── смена номера (F-15-149): код на НОВЫЙ номер ───────────

  async sendPhoneCode(ctx: RequestContext, input: { phone: string; channel: 'telegram' | 'whatsapp' | 'sms' }) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374XXXXXXXX');
    const owner = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (owner && owner.id !== ctx.session!.userId) throw new ApiError('phone_taken', 'Phone belongs to another account');
    return this.otp.send({ phone, purpose: 'phone_change', channel: input.channel, ip: ctx.ip, locale: ctx.session!.locale, userId: ctx.session!.userId });
  }

  async confirmPhone(ctx: RequestContext, input: { phone: string; code: string }) {
    const userId = ctx.session!.userId;
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374XXXXXXXX');
    const otp = await this.otp.verify({ phone, purpose: 'phone_change' }, input.code);
    if (otp.userId !== userId) throw new ApiError('wrong_code', 'Code was requested by another account');
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const taken = await tx.user.findUnique({ where: { phone }, select: { id: true } });
      if (taken && taken.id !== userId) throw new ApiError('phone_taken', 'Phone belongs to another account');
      await tx.user.update({ where: { id: userId }, data: { phone, updatedBy: userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'user', entityId: userId, before: { phone: u.phone }, after: { phone } });
    });
    return this.get(userId);
  }

  /** Двухэтапная проверка (F-15-159): код приходит на телефон аккаунта — без телефона включить нельзя */
  async setTwoFactor(ctx: RequestContext, enabled: boolean) {
    const userId = ctx.session!.userId;
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (enabled && !u.phone) throw new ApiError('phone_required', 'Add a phone number first');
      if (u.twoFactorEnabled === enabled) return;
      await tx.user.update({ where: { id: userId }, data: { twoFactorEnabled: enabled, updatedBy: userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'user', entityId: userId, before: { twoFactorEnabled: u.twoFactorEnabled }, after: { twoFactorEnabled: enabled } });
    });
    return this.get(userId);
  }

  // ─────────── устройства и журнал входов ───────────

  async listSessions(ctx: RequestContext) {
    const rows = await this.prisma.session.findMany({
      where: { userId: ctx.session!.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    });
    return rows.map((s) => ({
      id: s.id,
      app: s.app,
      device: s.device,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.id === ctx.session!.sessionId,
    }));
  }

  async revokeSession(ctx: RequestContext, sessionId: string) {
    const s = await this.prisma.session.findFirst({ where: { id: sessionId, userId: ctx.session!.userId, revokedAt: null } });
    if (!s) throw new ApiError('not_found', 'Session not found');
    await this.sessions.revoke(s.id, 'logout');
  }

  async loginEvents(ctx: RequestContext, limit: number) {
    const rows = await this.prisma.loginEvent.findMany({
      where: { userId: ctx.session!.userId },
      orderBy: { at: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      method: e.method,
      app: e.app,
      result: e.result,
      device: e.device,
      ip: e.ip,
      current: e.sessionId === ctx.session!.sessionId,
    }));
  }

  // ─────────── токены пушей (05 §4) ───────────

  async savePushToken(ctx: RequestContext, input: z.infer<typeof pushTokenBody>) {
    const userId = ctx.session!.userId;
    const data = {
      userId,
      app: input.app,
      platform: input.platform,
      subscription: (input.subscription ?? undefined) as never,
      locale: ctx.session!.locale,
      invalidAt: null,
    };
    await this.prisma.pushToken.upsert({ where: { token: input.token }, create: { id: newId('pushToken'), token: input.token, ...data }, update: data });
  }

  async deletePushToken(ctx: RequestContext, token: string) {
    await this.prisma.pushToken.deleteMany({ where: { token, userId: ctx.session!.userId } });
  }
}
