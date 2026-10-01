import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Booking as BookingRow } from '../../generated/prisma/client.js';
import { env } from '../../common/config/env.js';
import { isLocale, type Locale } from '../../common/i18n/i18n.js';
import { normalizePhone } from '../../common/phone.js';
import type { PrismaService } from '../../common/prisma.service.js';

/**
 * Привязка чата Telegram к номеру клиента (30.09.2026). Код ссылки `t.me/<бот>?start=<код>` живёт в Redis 7 дней и
 * одноразовый: бот, получив `/start <код>`, связывает чат с номером из кода. Без кода — кнопка «Поделиться номером».
 */
const CODE_TTL_SEC = 7 * 24 * 3600;
const codeKey = (code: string) => `booktime:tg:code:${code}`;

export interface LinkCodePayload {
  phone: string;
  bookingId?: string;
  appUserId?: string;
}

export interface TelegramLinkOut {
  url: string;
  botUsername: string;
  linked: boolean;
}

/** Статусы, при которых запись ещё впереди и о ней стоит напоминать/показывать */
export const UPCOMING_STATUSES = ['awaiting_confirmation', 'awaiting_prepayment', 'scheduled', 'client_confirmed'];

/** language_code Telegram → наш язык; всё прочее — русский (решение 30.09: по умолчанию ru) */
export function tgLocale(code: string | null | undefined): Locale {
  const base = (code ?? '').slice(0, 2).toLowerCase();
  return isLocale(base) ? base : 'ru';
}

export async function createLinkCode(redis: Redis, payload: LinkCodePayload): Promise<string> {
  // start-параметр Telegram: [A-Za-z0-9_-], до 64 символов; 12 байт = 96 бит — не угадать
  const code = randomBytes(12).toString('base64url');
  await redis.set(codeKey(code), JSON.stringify(payload), 'EX', CODE_TTL_SEC);
  return code;
}

/** Забрать код (одноразово): нет/истёк — undefined */
export async function consumeLinkCode(redis: Redis, code: string): Promise<LinkCodePayload | undefined> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return undefined;
  const raw = await redis.getdel(codeKey(code));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as LinkCodePayload;
  } catch {
    return undefined;
  }
}

/** Номер клиента записи: карточка клиента бизнеса, иначе номер человека приложения */
export async function bookingPhone(prisma: PrismaService, b: Pick<BookingRow, 'clientId' | 'appUserId'>): Promise<string | undefined> {
  if (b.clientId) {
    const c = await prisma.client.findUnique({ where: { id: b.clientId }, select: { phone: true } });
    const phone = c?.phone ? normalizePhone(c.phone) : undefined;
    if (phone) return phone;
  }
  if (b.appUserId) {
    const u = await prisma.user.findUnique({ where: { id: b.appUserId }, select: { phone: true } });
    if (u?.phone) return normalizePhone(u.phone);
  }
  return undefined;
}

/** Есть ли у номера живая привязка (бот не остановлен) */
export async function isPhoneLinked(prisma: PrismaService, phone: string): Promise<boolean> {
  return (await prisma.telegramLink.count({ where: { phone, blockedAt: null } })) > 0;
}

export async function linkOut(prisma: PrismaService, redis: Redis, payload: LinkCodePayload): Promise<TelegramLinkOut> {
  const code = await createLinkCode(redis, payload);
  return {
    url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    linked: await isPhoneLinked(prisma, payload.phone),
  };
}
