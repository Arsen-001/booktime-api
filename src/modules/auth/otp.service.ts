import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { CODE_SENDERS, type CodeSenders } from '../../adapters/adapters.js';
import type { CodeChannel } from '../../adapters/code-sender/code-sender.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import { t, type Locale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Коды (docs/backend/05 §6.3, решение E2): 4 цифры, 5 минут, 5 попыток на код, повтор не раньше 60 с,
 * не больше 5 кодов на номер в час и 10 в сутки, с одного адреса — 20 в час. В базе только хэш кода.
 */
export const OTP = {
  length: 4,
  ttlSec: 5 * 60,
  maxAttempts: 5,
  resendSec: 60,
  perPhoneHour: 5,
  perPhoneDay: 10,
  perIpHour: 20,
} as const;

export type OtpPurpose = 'login' | 'phone_change' | 'second_factor' | 'platform';

export interface OtpSendInput {
  phone: string;
  purpose: OtpPurpose;
  channel: CodeChannel;
  ip: string;
  locale: Locale;
  subjectId?: string;
  userId?: string;
}

export interface OtpSent {
  /** id запроса кода — для второго шага входа по паролю («вызов») */
  challengeId: string;
  /** Через сколько секунд можно попросить новый код */
  resendAfter: number;
  /** Сколько секунд живёт код */
  expiresIn: number;
  channel: CodeChannel;
}

function codeHash(otpId: string, code: string): string {
  return createHash('sha256').update(`${otpId}:${code}`).digest('hex');
}

/** Постоянный код — только при разработке (env.DEV_LOGIN_CODE и NODE_ENV=development) */
function makeCode(): string {
  if (env.NODE_ENV === 'development' && env.DEV_LOGIN_CODE) return env.DEV_LOGIN_CODE;
  return String(randomInt(0, 10 ** OTP.length)).padStart(OTP.length, '0');
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CODE_SENDERS) private readonly senders: CodeSenders,
  ) {}

  async send(input: OtpSendInput): Promise<OtpSent> {
    const now = Date.now();
    const hourAgo = new Date(now - 3600_000);
    const dayAgo = new Date(now - 86_400_000);
    const last = await this.prisma.otpRequest.findFirst({
      where: { phone: input.phone, purpose: input.purpose },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    });
    if (last) {
      const wait = Math.ceil((last.sentAt.getTime() + OTP.resendSec * 1000 - now) / 1000);
      if (wait > 0) throw new ApiError('code_resend_wait', `Resend available in ${wait}s`, undefined, wait);
    }
    const [perHour, perDay, perIp] = await Promise.all([
      this.prisma.otpRequest.count({ where: { phone: input.phone, sentAt: { gte: hourAgo } } }),
      this.prisma.otpRequest.count({ where: { phone: input.phone, sentAt: { gte: dayAgo } } }),
      this.prisma.otpRequest.count({ where: { ip: input.ip, sentAt: { gte: hourAgo } } }),
    ]);
    if (perDay >= OTP.perPhoneDay) throw new ApiError('rate_limited', 'Too many codes for this number today', undefined, 3600);
    if (perHour >= OTP.perPhoneHour || perIp >= OTP.perIpHour) throw new ApiError('rate_limited', 'Too many codes, try later', undefined, 3600);

    const id = newId('otp');
    const code = makeCode();
    await this.prisma.$transaction([
      // Прежний неиспользованный код того же назначения больше не действует
      this.prisma.otpRequest.updateMany({
        where: { phone: input.phone, purpose: input.purpose, status: 'sent' },
        data: { status: 'superseded' },
      }),
      this.prisma.otpRequest.create({
        data: {
          id,
          phone: input.phone,
          purpose: input.purpose,
          channel: input.channel,
          codeHash: codeHash(id, code),
          subjectId: input.subjectId ?? null,
          userId: input.userId ?? null,
          ip: input.ip,
          expiresAt: new Date(now + OTP.ttlSec * 1000),
        },
      }),
    ]);
    try {
      const sent = await this.senders[input.channel].send({
        phone: input.phone,
        code,
        text: t(input.locale, 'auth.code', { code }),
        ttlSec: OTP.ttlSec,
      });
      if (sent.providerMessageId) {
        await this.prisma.otpRequest.update({ where: { id }, data: { providerMessageId: sent.providerMessageId } });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, channel: input.channel }, 'code not delivered');
      await this.prisma.otpRequest.update({ where: { id }, data: { status: 'failed' } });
      throw new ApiError('code_not_delivered', 'Code could not be delivered via this channel');
    }
    return { challengeId: id, resendAfter: OTP.resendSec, expiresIn: OTP.ttlSec, channel: input.channel };
  }

  /**
   * Проверить код. Ищется последний отправленный код (по номеру и назначению или по id вызова).
   * Неверный код тратит попытку; пятая неверная гасит код. Верный — код больше не действует.
   */
  async verify(where: { phone: string; purpose: OtpPurpose } | { challengeId: string; purpose: OtpPurpose }, code: string) {
    const otp =
      'challengeId' in where
        ? await this.prisma.otpRequest.findFirst({ where: { id: where.challengeId, purpose: where.purpose } })
        : await this.prisma.otpRequest.findFirst({ where: { phone: where.phone, purpose: where.purpose }, orderBy: { sentAt: 'desc' } });
    if (!otp || otp.status === 'superseded' || otp.status === 'used' || otp.status === 'failed') {
      throw new ApiError('wrong_code', 'No active code, request a new one');
    }
    if (otp.status === 'exhausted' || otp.attempts >= OTP.maxAttempts) throw new ApiError('code_attempts', 'Too many attempts, request a new code');
    if (otp.expiresAt.getTime() <= Date.now()) throw new ApiError('code_expired', 'Code expired, request a new one');

    const given = Buffer.from(codeHash(otp.id, /^\d{4}$/.test(code) ? code : 'xxxx'));
    const ok = timingSafeEqual(given, Buffer.from(otp.codeHash));
    if (!ok) {
      const attempts = otp.attempts + 1;
      await this.prisma.otpRequest.updateMany({
        where: { id: otp.id, status: 'sent' },
        data: { attempts, ...(attempts >= OTP.maxAttempts ? { status: 'exhausted' } : {}) },
      });
      throw new ApiError(attempts >= OTP.maxAttempts ? 'code_attempts' : 'wrong_code', 'Wrong code');
    }
    // Одноразовость: второй параллельный запрос с тем же кодом не пройдёт (status уже не 'sent')
    const used = await this.prisma.otpRequest.updateMany({ where: { id: otp.id, status: 'sent' }, data: { status: 'used', usedAt: new Date() } });
    if (used.count !== 1) throw new ApiError('wrong_code', 'Code already used');
    return otp;
  }
}
