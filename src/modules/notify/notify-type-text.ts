import type { Locale } from '../../common/i18n/i18n.js';

/**
 * Свой текст салона для канала «Пуш» — то, что владелец правит во вкладке «Шаблоны уведомлений» (каталог типов,
 * NotifyTypeOverride.templates.push). Нет правки — undefined: остаётся прежний путь (старые «Тексты», наш текст).
 * Проход 17.11: правка шаблона «Администратор записал клиента» сохранялась, а клиент получал текст по умолчанию —
 * отправитель читал только старое хранилище. Так уже работает «Просим подтвердить визит» (notify-confirm-requests).
 */
type Db = { notifyTypeOverride: { findUnique: (args: { where: { businessId_code: { businessId: string; code: number } }; select: { templates: true } }) => Promise<{ templates: unknown } | null> } };

/**
 * Свой текст салона для канала типа: «Пуш» — клиенту, «Приложение администратора» (adminApp) — сотрудникам,
 * «Telegram» — боту (хвосты 17.11: правка уходила только у 1, 4, 8, 73, 74). Нет правки — undefined.
 */
export async function typeTemplateOf(db: Db, businessId: string, code: number, channel: 'push' | 'adminApp' | 'telegram', locale: Locale): Promise<string | undefined> {
  const row = await db.notifyTypeOverride.findUnique({ where: { businessId_code: { businessId, code } }, select: { templates: true } });
  const tpl = (row?.templates as Record<string, Partial<Record<Locale, string>>> | null | undefined)?.[channel];
  const text = tpl?.[locale]?.trim() || tpl?.ru?.trim();
  return text || undefined;
}

export function typePushTemplateOf(db: Db, businessId: string, code: number, locale: Locale): Promise<string | undefined> {
  return typeTemplateOf(db, businessId, code, 'push', locale);
}

/**
 * Имя мастера клиенту — на языке клиента (владелец 17.11.2026, ответ 8 и уточнение «К 8»: сайт, запись, приложение и
 * уведомления клиенту — на языке клиента). staff.name_i18n[locale] → имя, как вписали (в кабинете — всегда оно).
 */
export function staffNameFor(staff: { name: string; nameI18n?: unknown } | null | undefined, locale: string): string {
  if (!staff) return '';
  const i18n = staff.nameI18n && typeof staff.nameI18n === 'object' ? (staff.nameI18n as Record<string, unknown>) : {};
  const v = i18n[locale];
  return typeof v === 'string' && v.trim() ? v.trim() : staff.name;
}

/** Переменные шаблона записи — те же имена, что в редакторе и журнале отправок ({companyName} {service} {date} {time} {staff} {link}) */
export function bookingTemplateVars(input: { businessName: string; service: string; staff: string; local: string; link: string }): Record<string, string> {
  const date = `${input.local.slice(8, 10)}.${input.local.slice(5, 7)}`;
  const time = input.local.slice(11, 16);
  return {
    companyName: input.businessName,
    place: input.businessName,
    date,
    time,
    dateTime: `${date} ${time}`,
    service: input.service,
    visitServices: input.service,
    staff: input.staff,
    link: input.link,
  };
}
