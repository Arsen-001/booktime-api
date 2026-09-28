import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../common/prisma.service.js';

/** Наш публичный домен: короткая ссылка SMS — `booktime.am/s/<code>` (фронт: src/areas/notify/lib/shortLink.ts) */
export const SHORT_HOST = 'booktime.am';
export const SHORT_CODE_LENGTH = 6;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 6 знаков base62 из crypto: 62^6 ≈ 5,7·10^10; 248 = 62·4 — берём байты < 248, чтобы не было перекоса */
export function randomShortCode(length = SHORT_CODE_LENGTH): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

/** Цель — только путь на нашем домене («/b/x/booking/…»), не «//чужой.сайт» и не абсолютный адрес */
export function isSafeTarget(target: string): boolean {
  return target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\') && target.length <= 512;
}

export interface ShortLinkOut {
  code: string;
  /** Как печатается в SMS: booktime.am/s/<code> */
  url: string;
  target: string;
  expiresAt: string | null;
}

/**
 * Короткие ссылки SMS (этап 21, 28.09): отправитель уведомлений просит код на полный путь, клиент открывает
 * `/s/<code>` на фронте, фронт спрашивает `GET /v1/public/s/<code>` и уходит на путь. Один и тот же путь
 * бизнеса даёт один и тот же код (уникальный ключ business_id+target) — повторная отправка не плодит строки.
 */
@Injectable()
export class ShortLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, target: string, expiresAt?: Date): Promise<ShortLinkOut> {
    if (!isSafeTarget(target)) throw new ApiError('invalid_field', 'target must be a path on our domain');
    const existing = await this.prisma.shortLink.findUnique({ where: { businessId_target: { businessId, target } } });
    if (existing) return this.out(existing);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const row = await this.prisma.shortLink.create({ data: { code: randomShortCode(), target, businessId, expiresAt: expiresAt ?? null } });
        return this.out(row);
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        // Гонка на тот же путь — берём строку соседа; иначе совпал код — новая попытка
        const raced = await this.prisma.shortLink.findUnique({ where: { businessId_target: { businessId, target } } });
        if (raced) return this.out(raced);
      }
    }
    throw new ApiError('conflict', 'short link code collision');
  }

  async resolve(code: string): Promise<{ target: string }> {
    const row = /^[0-9A-Za-z]{4,12}$/.test(code) ? await this.prisma.shortLink.findUnique({ where: { code } }) : null;
    if (!row || (row.expiresAt && row.expiresAt.getTime() < Date.now()) || !isSafeTarget(row.target)) throw new ApiError('not_found', 'Link not found');
    return { target: row.target };
  }

  private out(row: { code: string; target: string; expiresAt: Date | null }): ShortLinkOut {
    return { code: row.code, url: `${SHORT_HOST}/s/${row.code}`, target: row.target, expiresAt: row.expiresAt?.toISOString() ?? null };
  }
}
