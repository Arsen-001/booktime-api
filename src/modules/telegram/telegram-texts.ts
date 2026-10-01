import type { Booking as BookingRow } from '../../generated/prisma/client.js';
import type { InlineButton, InlineKeyboard } from '../../adapters/telegram-bot/telegram-bot.js';
import { env } from '../../common/config/env.js';
import { t, type Locale } from '../../common/i18n/i18n.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal } from '../../common/time/time.js';

/** Сообщения бота о записи: карточка (бизнес, дата/время по поясу филиала, услуга, мастер) и кнопки под ней */

const MONTHS: Record<Locale, string[]> = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  hy: ['հունվարի', 'փետրվարի', 'մարտի', 'ապրիլի', 'մայիսի', 'հունիսի', 'հուլիսի', 'օգոստոսի', 'սեպտեմբերի', 'հոկտեմբերի', 'նոյեմբերի', 'դեկտեմբերի'],
};

/** 'YYYY-MM-DDTHH:mm' → «1 октября, 14:00» / «1 October, 14:00» / «հոկտեմբերի 1, 14:00» */
export function formatWhen(local: string, locale: Locale): string {
  const month = MONTHS[locale][Number(local.slice(5, 7)) - 1] ?? '';
  const day = String(Number(local.slice(8, 10)));
  const time = local.slice(11, 16);
  return locale === 'ru' ? `${day} ${month}, ${time}` : `${month} ${day}, ${time}`;
}

function pickText(v: unknown, locale: Locale): string | undefined {
  const o = v as Record<string, string> | null | undefined;
  if (!o) return undefined;
  if (typeof v === 'string') return v;
  return o[locale] || o.ru || o.hy || o.en || undefined;
}

export interface BookingCard {
  businessName: string;
  slug?: string;
  when: string;
  service: string;
  master: string;
  /** Кому звонить, если бот не может отменить: мастер → филиал → бизнес */
  phone?: string;
}

export async function bookingCard(prisma: PrismaService, b: BookingRow, locale: Locale): Promise<BookingCard> {
  const serviceId = (b.services as { serviceId?: string }[] | null)?.[0]?.serviceId;
  const [business, location, staff, service] = await Promise.all([
    prisma.business.findUnique({ where: { id: b.businessId }, select: { name: true, brandName: true, slug: true, phone: true } }),
    prisma.location.findUnique({ where: { id: b.locationId }, select: { tz: true, phone: true } }),
    prisma.staff.findUnique({ where: { id: b.staffId }, select: { name: true, phone: true } }),
    serviceId ? prisma.service.findUnique({ where: { id: serviceId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  const tz = location?.tz || DEFAULT_TZ;
  return {
    businessName: business?.brandName || business?.name || 'BookTime',
    slug: business?.slug || undefined,
    when: formatWhen(utcToLocal(b.startAt, tz), locale),
    service: pickText(service?.name, locale) ?? '',
    master: staff?.name ?? '',
    phone: staff?.phone || location?.phone || business?.phone || undefined,
  };
}

export function cardText(card: BookingCard): string {
  return [card.businessName, `📅 ${card.when}`, card.service ? `💅 ${card.service}` : '', card.master ? `👤 ${card.master}` : ''].filter(Boolean).join('\n');
}

/** Кнопки под напоминанием: «Приду» (только пока не подтверждено), «Отменить», «Перенести» (ссылка на страницу бизнеса) */
export function bookingKeyboard(b: Pick<BookingRow, 'id' | 'status'>, card: BookingCard, locale: Locale): InlineKeyboard {
  const row1: InlineButton[] = [
    ...(b.status === 'scheduled' ? [{ text: t(locale, 'tg.btnConfirm'), callback_data: `c:${b.id}` }] : []),
    { text: t(locale, 'tg.btnCancel'), callback_data: `x:${b.id}` },
  ];
  const rows: InlineButton[][] = [row1];
  if (card.slug) rows.push([{ text: t(locale, 'tg.btnReschedule'), url: `${env.PUBLIC_SITE_URL}/b/${encodeURIComponent(card.slug)}` }]);
  return { inline_keyboard: rows };
}
