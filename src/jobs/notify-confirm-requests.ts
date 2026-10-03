import { isLocale, t, type Locale } from '../common/i18n/i18n.js';
import { newId } from '../common/ids/ids.js';
import { normalizePhone } from '../common/phone.js';
import type { PrismaService } from '../common/prisma.service.js';
import { DEFAULT_TZ, localToUtc, utcToLocal } from '../common/time/time.js';
import { customTemplateOf } from '../modules/notify/notify-types.service.js';
import { TYPE_REGISTRY, type NotifyScenario } from '../modules/notify/notify-type-registry.js';
import { enqueueClientNotification, enqueueOutbox } from '../modules/notify/outbox.js';
import { tgLocale } from '../modules/telegram/telegram-links.js';
import { bookingCard, bookingKeyboard, cardText } from '../modules/telegram/telegram-texts.js';

/** Вид в очереди (kinds.ts, код 10) — по нему отправитель проверяет isKindEnabled, журнал показывает строку */
export const CONFIRM_KIND = 'confirm_request';
/** «Просим подтвердить визит» в каталоге типов (notify-type-registry.ts) — его включатель, каналы и условия */
const TYPE_CODE = 73;
/**
 * Только «Записан» (scheduled) — это «Ожидание клиента» Altegio (F-05-028: «уходит только при статусе Ожидание клиента»).
 * «Ждёт подтверждения» (awaiting_confirmation) ждёт мастера, а не клиента; клиент подтверждает только из scheduled
 * (rules.ts: scheduled → client_confirmed) — просить подтвердить ещё не принятую мастером заявку бессмысленно.
 */
const STATUS = 'scheduled';
/**
 * Шаг задачи 5 мин (worker.ts, notify.reminders), окно Telegram-напоминаний — 10 мин вперёд (notify-reminders.ts). Запрос
 * уходит до 10 мин раньше своего момента — тем же проходом, что напоминание за сутки, и раньше него (см. replaceReminder24h).
 */
const EARLY_MS = 10 * 60_000;
/** «В выбранное время» накануне — не дальше чем за двое суток; «за N часов» — не больше 24 (F-05-028) */
const MAX_HORIZON_H = 48;

export interface ConfirmConditions {
  timingHours?: number;
  useSpecificTime?: boolean;
  specificTime?: string;
}

export interface ConfirmConfig {
  enabled: boolean;
  push: boolean;
  telegram: boolean;
  conditions: ConfirmConditions;
}

const DEF = TYPE_REGISTRY.find((d) => d.code === TYPE_CODE)!;

/** Настройка бизнеса = реестр + строка NotifyTypeOverride (то, что владелец поменял на экране типа 73) */
export function confirmConfigOf(row?: { enabled: boolean | null; channels: unknown; conditions: unknown } | null): ConfirmConfig {
  const stored = (row?.channels as { channel: string; scenario: NotifyScenario }[] | null | undefined) ?? [];
  const scenario = (channel: 'push' | 'telegram'): NotifyScenario => stored.find((c) => c.channel === channel)?.scenario ?? DEF.defaultScenario[channel] ?? 'off';
  return {
    enabled: row?.enabled ?? DEF.enabledDefault,
    push: scenario('push') !== 'off',
    telegram: scenario('telegram') !== 'off',
    conditions: { ...DEF.conditionsDefault, ...((row?.conditions as ConfirmConditions | null) ?? {}) },
  };
}

function prevDay(date: string): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Момент запроса (F-05-028): за N часов до визита (по умолчанию 24) или, с галочкой «Отправлять в выбранное время»,
 * накануне визита в это время по поясу филиала. Как мок (liveLog.ts) и журнал сервера (notify-log-derive.ts).
 */
export function confirmRequestAt(startAt: Date, tz: string, c: ConfirmConditions): Date {
  if (c.useSpecificTime && /^\d{2}:\d{2}$/.test(c.specificTime ?? '')) {
    const day = utcToLocal(startAt, tz).slice(0, 10);
    return localToUtc(`${prevDay(day)}T${c.specificTime}`, tz);
  }
  return new Date(startAt.getTime() - (c.timingHours ?? 24) * 3_600_000);
}

function horizonHours(c: ConfirmConditions): number {
  return c.useSpecificTime ? MAX_HORIZON_H : Math.min(Math.max(c.timingHours ?? 24, 1), MAX_HORIZON_H);
}

/**
 * ⭐ «Просим подтвердить визит» (тип 73, F-05-028; 03.10.2026). Каждые 5 минут вместе с напоминаниями:
 *  · кому — записи «Записан» с клиентом, у которых наступил момент запроса и которые существовали к этому моменту
 *    (созданная позже запись запроса не получает — правило Altegio, как у мока);
 *  · клиенту с нашим приложением (живой push-токен app='client') — пуш + строка ленты kind 'confirm_request' с кнопкой
 *    «Подтвердить» (POST /v1/me/bookings/:id/confirm → «Клиент подтвердил»);
 *  · без приложения, но с Telegram-ботом на номере — сообщение с карточкой записи и кнопкой «Приду» (callback `c:<id>`,
 *    telegram-bot.service → тот же переход «Клиент подтвердил»), «Отменить», «Перенести». Запрос в Telegram заменяет
 *    напоминание за сутки (replaceReminder24h): одно сообщение в день, а не два подряд с той же кнопкой;
 *  · уважает: тип 73 выключен / сценарий канала «Не отправлять» (NotifyTypeOverride), выключатели записи
 *    (Booking.notifyOverride.pushEnabled / telegramEnabled), вид confirm_request выключен (isKindEnabled — отправитель).
 * Ключ дубля — запись + её время: повторный проход ничего не дублирует, перенесённая запись спрашивается заново.
 */
export async function enqueueConfirmRequests(prisma: PrismaService, now = new Date()): Promise<{ sent: number; candidates: number }> {
  const overrides = await prisma.notifyTypeOverride.findMany({ where: { code: TYPE_CODE } });
  const configByBiz = new Map(overrides.map((o) => [o.businessId, confirmConfigOf(o)]));
  const defaults = confirmConfigOf(null);
  const configOf = (businessId: string) => configByBiz.get(businessId) ?? defaults;

  let horizon = defaults.enabled ? horizonHours(defaults.conditions) : 0;
  for (const c of configByBiz.values()) if (c.enabled) horizon = Math.max(horizon, horizonHours(c.conditions));
  if (!horizon) return { sent: 0, candidates: 0 };
  const off = [...configByBiz].filter(([, c]) => !c.enabled || (!c.push && !c.telegram)).map(([id]) => id);
  const on = [...configByBiz].filter(([, c]) => c.enabled && (c.push || c.telegram)).map(([id]) => id);
  const businessFilter = defaults.enabled ? (off.length ? { businessId: { notIn: off } } : {}) : { businessId: { in: on } };
  if (!defaults.enabled && !on.length) return { sent: 0, candidates: 0 };

  const rows = await prisma.booking.findMany({
    where: { status: STATUS, deletedAt: null, groupEventId: null, clientId: { not: null }, startAt: { gt: now, lte: new Date(now.getTime() + horizon * 3_600_000 + EARLY_MS) }, ...businessFilter },
  });
  if (!rows.length) return { sent: 0, candidates: 0 };

  const locationIds = [...new Set(rows.map((b) => b.locationId))];
  const locations = await prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, tz: true } });
  const tzOf = new Map(locations.map((l) => [l.id, l.tz || DEFAULT_TZ]));
  const due = rows
    .map((b) => ({ b, tz: tzOf.get(b.locationId) ?? DEFAULT_TZ }))
    .map((x) => ({ ...x, at: confirmRequestAt(x.b.startAt, x.tz, configOf(x.b.businessId).conditions) }))
    .filter(({ b, at }) => configOf(b.businessId).enabled && at.getTime() <= now.getTime() + EARLY_MS && at < b.startAt && b.createdAt <= at);
  if (!due.length) return { sent: 0, candidates: 0 };

  const clientIds = [...new Set(due.map(({ b }) => b.clientId!))];
  const clients = await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, phone: true, appUserId: true } });
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const userIds = [...new Set(due.map(({ b }) => b.appUserId ?? clientById.get(b.clientId!)?.appUserId).filter((v): v is string => Boolean(v)))];
  const [users, tokens] = userIds.length
    ? await Promise.all([
        prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, phone: true, locale: true } }),
        prisma.pushToken.findMany({ where: { userId: { in: userIds }, app: 'client', invalidAt: null }, select: { userId: true } }),
      ])
    : [[], []];
  const userById = new Map(users.map((u) => [u.id, u]));
  const withApp = new Set(tokens.map((x) => x.userId));

  let sent = 0;
  let candidates = 0;
  for (const { b, tz } of due) {
    const cfg = configOf(b.businessId);
    const ov = (b.notifyOverride as { pushEnabled?: boolean; telegramEnabled?: boolean } | null) ?? null;
    const client = clientById.get(b.clientId!);
    const userId = b.appUserId ?? client?.appUserId ?? null;
    const local = utcToLocal(b.startAt, tz);

    if (userId && withApp.has(userId)) {
      // С приложением — только пуш (в Telegram не дублируем, как напоминания); пуш выключен — запроса нет
      if (!cfg.push || ov?.pushEnabled === false) continue;
      candidates++;
      const user = userById.get(userId);
      const locale: Locale = isLocale(user?.locale) ? user.locale : 'ru';
      const card = await bookingCard(prisma, b, locale);
      const params = { service: card.service, date: `${local.slice(8, 10)}.${local.slice(5, 7)}`, time: local.slice(11, 16), place: card.businessName };
      const custom = await customTemplateOf(prisma, b.businessId, CONFIRM_KIND, locale);
      const body = custom ? custom.replace(/\{(\w+)\}/g, (_, name: string) => (params as Record<string, string>)[name] ?? `{${name}}`) : t(locale, 'booking.confirmRequest', params);
      const created = await enqueueClientNotification(prisma, {
        businessId: b.businessId,
        kind: CONFIRM_KIND,
        appUserId: userId,
        title: card.businessName,
        body,
        url: `/bookings/${b.id}`,
        dedupeKey: `client:confirm:${b.id}:${local}`,
        inbox: { kind: 'confirm_request', businessId: b.businessId, staffId: b.staffId, bookingId: b.id, params: { start: local } },
      });
      if (created) sent++;
      continue;
    }

    // Без приложения — Telegram-бот, если клиент подключил его на свой номер
    if (!cfg.telegram || ov?.telegramEnabled === false) continue;
    const rawPhone = client?.phone || (userId ? userById.get(userId)?.phone : null);
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;
    if (!phone) continue;
    const links = await prisma.telegramLink.findMany({ where: { phone, blockedAt: null } });
    if (!links.length) continue;
    candidates++;
    for (const link of links) {
      const locale = tgLocale(link.languageCode);
      const card = await bookingCard(prisma, b, locale);
      const created = await enqueueOutbox(prisma, {
        businessId: b.businessId,
        app: 'telegram',
        kind: CONFIRM_KIND,
        recipientUserId: link.chatId,
        title: card.businessName,
        body: `${t(locale, 'tg.confirmRequest')}\n\n${cardText(card)}`,
        dedupeKey: `telegram:${CONFIRM_KIND}:${b.id}:${link.chatId}:${local}`,
        meta: { bookingId: b.id, replyMarkup: bookingKeyboard(b, card, locale) },
      });
      if (!created) continue;
      sent++;
      await replaceReminder24h(prisma, b, link.chatId, card.businessName, now);
    }
  }
  return { sent, candidates };
}

/**
 * Запрос в Telegram ушёл раньше напоминания за сутки (или одновременно с ним) — напоминание за сутки не нужно: у запроса
 * та же карточка и те же кнопки. Занимаем его ключ дубля (`telegram:reminder24h:<запись>:<чат>`, telegram-reminders.ts)
 * строкой «пропущено — заменено запросом подтверждения»: напоминание уже не встанет в очередь, а в журнале отправок видно
 * почему. Напоминание уже в очереди или ушло (запрос позже суток) — ключ занят, ничего не делаем. За 2 часа — уходит всегда.
 */
async function replaceReminder24h(prisma: PrismaService, b: { id: string; businessId: string; startAt: Date }, chatId: string, title: string, now: Date): Promise<void> {
  const reminderAt = b.startAt.getTime() - 24 * 3_600_000;
  if (reminderAt < now.getTime() - EARLY_MS) return; // момент напоминания за сутки прошёл — оно своё уже отработало
  const dedupeKey = `telegram:reminder24h:${b.id}:${chatId}`;
  if (await prisma.notifyOutbox.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
  try {
    await prisma.notifyOutbox.create({
      data: {
        id: newId('notifyOutbox'),
        businessId: b.businessId,
        app: 'telegram',
        kind: 'reminder24h',
        recipientUserId: chatId,
        title: title.slice(0, 200),
        body: '',
        dedupeKey,
        sendAt: now,
        status: 'skipped',
        sentAt: now,
        lastError: 'replaced_by_confirm_request',
        meta: { bookingId: b.id },
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
  }
}
