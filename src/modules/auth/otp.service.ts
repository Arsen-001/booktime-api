import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { CODE_SENDERS, type CodeSenders } from '../../adapters/adapters.js';
import { CODE_CHANNEL_ORDER, deliverCode, deliveryOrder, enabledChannels, type CodeChannel } from '../../adapters/code-sender/code-sender.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import { t, type Locale } from '../../common/i18n/i18n.js';
import { newId } from '../../common/ids/ids.js';
import { logger } from '../../common/logging/logger.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Коды (docs/backend/05 §6.3, решение E2): 4 цифры, 5 минут, 5 попыток на код, повтор не раньше 60 с,
 * не больше 5 кодов на номер в час и 10 в сутки, с одного адреса — 20 в час. В базе только хэш кода.
 *
 * Каналы (03.10.2026): код уходит в запрошенный канал (по умолчанию Telegram); не доставлен — тот же код в следующий
 * включённый канал (WhatsApp) в том же запросе, одна запись otp_requests — лимиты считаются как за один код.
 * «Прислать в WhatsApp» / «Прислать SMS» с экрана кода — обычная повторная отправка: те же 60 с и часовые/суточные
 * лимиты. SMS — последним и со своими лимитами (smsPerPhoneDay, smsPerIpHour, SMS_MAX_PER_HOUR на весь сервис).
 */
export const OTP = {
  length: 4,
  ttlSec: 5 * 60,
  maxAttempts: 5,
  resendSec: 60,
  perPhoneHour: 5,
  perPhoneDay: 10,
  perIpHour: 20,
  /** SMS платные и цель накрутки (SMS pumping) — свои лимиты сверх общих; исчерпаны — SMS просто не предлагается */
  smsPerPhoneDay: 3,
  smsPerIpHour: 5,
} as const;

/** 'booking' — F-00-007: подтвердить номер перед онлайн-записью без входа, без сессии (этап 8) */
export type OtpPurpose = 'login' | 'phone_change' | 'second_factor' | 'platform' | 'booking';

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
  /** Куда код ушёл на самом деле (может отличаться от запрошенного — запасной канал) */
  channel: CodeChannel;
  /** Какие каналы включены — экран предлагает «Прислать в <другой>» */
  channels: CodeChannel[];
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

  /** Включённые каналы (без учёта номера и лимитов) — экран входа показывает выбор только из них */
  channels(): CodeChannel[] {
    return CODE_CHANNEL_ORDER.filter((c) => this.senders[c].enabled);
  }

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

    const smsOk = await this.smsAllowedNow(input.phone, input.ip, hourAgo, dayAgo);
    const order = deliveryOrder(this.senders, input.phone, input.channel).filter((c) => c !== 'sms' || smsOk);
    if (order.length === 0) throw new ApiError('code_not_delivered', 'No code channel is enabled');
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
          channel: order[0]!,
          codeHash: codeHash(id, code),
          subjectId: input.subjectId ?? null,
          userId: input.userId ?? null,
          ip: input.ip,
          expiresAt: new Date(now + OTP.ttlSec * 1000),
        },
      }),
    ]);
    let channel: CodeChannel;
    try {
      const sent = await deliverCode(this.senders, order, {
        phone: input.phone,
        code,
        text: t(input.locale, 'auth.code', { code }),
        ttlSec: OTP.ttlSec,
        locale: input.locale,
      });
      channel = sent.channel;
      if (sent.providerMessageId || channel !== order[0]) {
        await this.prisma.otpRequest.update({
          where: { id },
          data: { channel, ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) },
        });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, channels: order }, 'code not delivered');
      await this.prisma.otpRequest.update({ where: { id }, data: { status: 'failed' } });
      throw new ApiError('code_not_delivered', 'Code could not be delivered via this channel');
    }
    const channels = enabledChannels(this.senders, input.phone).filter((c) => c !== 'sms' || smsOk);
    return { challengeId: id, resendAfter: OTP.resendSec, expiresIn: OTP.ttlSec, channel, channels };
  }

  /** Можно ли сейчас слать SMS: канал включён и не исчерпаны лимиты на номер, адрес и весь сервис (защита от накрутки) */
  private async smsAllowedNow(phone: string, ip: string, hourAgo: Date, dayAgo: Date): Promise<boolean> {
    if (!this.senders.sms.enabled) return false;
    const [perPhone, perIp, total] = await Promise.all([
      this.prisma.otpRequest.count({ where: { phone, channel: 'sms', sentAt: { gte: dayAgo } } }),
      this.prisma.otpRequest.count({ where: { ip, channel: 'sms', sentAt: { gte: hourAgo } } }),
      this.prisma.otpRequest.count({ where: { channel: 'sms', sentAt: { gte: hourAgo } } }),
    ]);
    const ok = perPhone < OTP.smsPerPhoneDay && perIp < OTP.smsPerIpHour && total < env.SMS_MAX_PER_HOUR;
    if (!ok) logger.warn({ perPhone, perIp, total }, 'sms code limit reached — sms skipped');
    return ok;
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
