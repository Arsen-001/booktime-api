import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../common/ids/ids.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { typeDefByCode } from './notify-type-registry.js';

/**
 * ⭐ Честный журнал отправок (06.10.2026, охват ТЗ 06.10 п. 4 №3, F-05-107/108/130): в журнал попадает только то, что
 * действительно поставлено в очередь отправки (notify_outbox: пуш в приложение, пуш администратору, Telegram-бот), и со
 * статусом очереди — «Отправляется» (ждёт отправителя или тихие часы), «Отправлено» (push-сервис / Telegram приняли),
 * «Не доставлено» (нет живого токена, бот остановлен, 5 неудачных попыток). «Доставлено» и «Прочитано» не пишем: отчётов
 * о доставке у нас нет. Раньше строки выводились из записей по каталогу экрана со статусом из хэша (notify-log-derive.ts,
 * source 'live') — салон видел «доставлено» у того, что никуда не уходило; такие строки журнал больше не показывает.
 *
 * Не попадает строкой из очереди:
 *  · то, что пишет журнал само (у строки журнала свой ключ, очередь — ключ с тем же началом): автоуведомления клиенту
 *    (`auto:`), разовые сообщения (`oneOff:`), рассылки (`ml:`) и их тесты, предложения окон (`slotOffer:`, `hotSlot:`) — их
 *    статус обновляет `refreshSendingRows` по строкам очереди с тем же ключом;
 *  · пропущенное намеренно: тип выключен, клиент выключил тип, напоминание заменено запросом подтверждения — это не
 *    попытка отправки, «не доставлено» тут было бы неправдой;
 *  · личные сообщения без бизнеса (подписка платформы).
 */

/** Ключи очереди, у которых строку журнала пишет сам отправитель */
export const SELF_LOGGED_PREFIXES = ['auto:', 'oneOff:', 'ml:', 'mailing:', 'mailingTest:', 'slotOffer:', 'hotSlot:'] as const;

/** Пропуски «не по вине доставки» — не попытка отправки, в журнал не идут */
const INTENDED_SKIPS = new Set(['type_disabled', 'replaced_by_confirm_request', 'client_type_off', 'client_push_off']);

type LText = { ru: string; en?: string; hy?: string };

/** Вид очереди → тип каталога экрана (код Altegio-нумерации, notify-type-registry.ts) */
const KIND_TYPE: Record<string, number> = {
  reminder24h: 1,
  reminder2h: 1,
  confirm_request: 73,
  booking_created: 8,
  online_booked: 2,
  salon_confirmed: 9,
  salon_moved: 74,
  salon_deleted: 4,
  cancelled_by_master: 4,
  staff_new_booking: 10,
  staff_client_cancelled: 12,
  staff_client_rescheduled: 41,
  staff_colleague_booked: 56,
  staff_assigned: 57,
  staff_booking_moved: 42,
  staff_booking_cancelled: 13,
  staff_client_no_show: 76,
  billing_ending: 43,
  clientBroadcast: 15,
};

/** Виды без типа каталога — своё название в журнале */
const KIND_LABEL: Record<string, LText> = {
  prepayment_expired: { ru: 'Предоплата не внесена', en: 'Prepayment not received', hy: 'Կանխավճարը չի վճարվել' },
  waitlist_available: { ru: 'Освободилось время', en: 'A slot opened up', hy: 'Ժամ է ազատվել' },
  news: { ru: 'Новость', en: 'News', hy: 'Նորություն' },
  order_ready: { ru: 'Заказ готов', en: 'Order ready', hy: 'Պատվերը պատրաստ է' },
  order_pickup_reminder: { ru: 'Заказ ждёт вас', en: 'Your order is waiting', hy: 'Պատվերը սպասում է ձեզ' },
  order_estimate: { ru: 'Смета по заказу', en: 'Order estimate', hy: 'Պատվերի նախահաշիվ' },
  order_estimate_reminder: { ru: 'Ждём ответа по смете', en: 'Estimate awaiting reply', hy: 'Սպասում ենք նախահաշվի պատասխանին' },
  staff_empty_week: { ru: 'Откройте окна на неделю', en: 'Open slots for the week', hy: 'Բացեք շաբաթվա ժամերը' },
  staff_request_reminder: { ru: 'Заявка ждёт ответа', en: 'Request awaiting reply', hy: 'Հայտը սպասում է պատասխանի' },
  staff_visit_mark: { ru: 'Пришёл или не пришёл', en: 'Arrived or no-show', hy: 'Եկավ թե չեկավ' },
};

export function outboxTypeOf(kind: string, meta: unknown): { typeCode?: number; typeLabel: LText } {
  const m = (meta as { typeCode?: unknown } | null) ?? {};
  const code = typeof m.typeCode === 'number' ? m.typeCode : KIND_TYPE[kind];
  const def = code !== undefined ? typeDefByCode(code) : undefined;
  if (def) return { typeCode: code, typeLabel: { ru: def.nameRu, en: def.nameEn, hy: def.nameHy } };
  if (code === 15) return { typeCode: 15, typeLabel: { ru: 'Сообщение из карточки клиента', en: 'Message from client card', hy: 'Հաղորդագրություն հաճախորդի քարտից' } };
  return { typeLabel: KIND_LABEL[kind] ?? { ru: kind, en: kind } };
}

/** Статус очереди → статус журнала; null — строку не показываем (намеренный пропуск) */
export function logStatusOf(row: { status: string; lastError: string | null }): 'sending' | 'sent' | 'notDelivered' | null {
  if (row.status === 'queued') return 'sending';
  if (row.status === 'sent') return 'sent';
  if (row.status === 'skipped' && INTENDED_SKIPS.has(row.lastError ?? '')) return null;
  return 'notDelivered';
}

const CHANNEL: Record<string, string> = { client: 'push', business: 'adminApp', telegram: 'telegram' };

export const isSelfLogged = (dedupeKey: string) => SELF_LOGGED_PREFIXES.some((p) => dedupeKey.startsWith(p));

type OutboxRow = {
  id: string;
  businessId: string | null;
  app: string;
  kind: string;
  recipientUserId: string;
  body: string;
  dedupeKey: string;
  sendAt: Date;
  status: string;
  lastError: string | null;
  meta: unknown;
  createdAt: Date;
  sentAt: Date | null;
};

/**
 * Строки очереди бизнеса, поставленные с `from`, — в журнал (ключ `ob:<id>`, повтор ничего не дублирует). Получатель:
 * телефон человека приложения / сотрудника / чата Telegram; клиент и мастер — из meta (bookingId, clientId, staffId) или по
 * номеру среди клиентов бизнеса.
 */
export async function materializeOutbox(db: PrismaService, businessId: string, from: Date, now: Date): Promise<number> {
  const rows = (await db.notifyOutbox.findMany({
    where: { businessId, createdAt: { gte: from, lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  })) as OutboxRow[];
  const fresh = rows.filter((r) => !isSelfLogged(r.dedupeKey) && logStatusOf(r) !== null);
  if (!fresh.length) return 0;
  const known = new Set(
    (await db.notifyLogEntry.findMany({ where: { dedupeKey: { in: fresh.map((r) => `ob:${r.id}`) } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey),
  );
  const todo = fresh.filter((r) => !known.has(`ob:${r.id}`));
  if (!todo.length) return 0;

  const metaOf = (r: OutboxRow) => (r.meta as { bookingId?: string; clientId?: string; staffId?: string } | null) ?? {};
  const userIds = [...new Set(todo.filter((r) => r.app !== 'telegram').map((r) => r.recipientUserId))];
  const chatIds = [...new Set(todo.filter((r) => r.app === 'telegram').map((r) => r.recipientUserId))];
  const bookingIds = [...new Set(todo.map((r) => metaOf(r).bookingId).filter((v): v is string => Boolean(v)))];
  const [users, chats, bookings, staff] = await Promise.all([
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, phone: true, locale: true } }) : [],
    chatIds.length ? db.telegramLink.findMany({ where: { chatId: { in: chatIds } }, select: { chatId: true, phone: true, languageCode: true } }) : [],
    bookingIds.length ? db.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, clientId: true, staffId: true } }) : [],
    userIds.length ? db.staff.findMany({ where: { businessId, userId: { in: userIds } }, select: { id: true, userId: true } }) : [],
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const chatById = new Map(chats.map((c) => [c.chatId, c]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const staffByUser = new Map(staff.map((s) => [s.userId, s.id]));
  const phones = [...new Set([...users.map((u) => u.phone), ...chats.map((c) => c.phone)].filter((p): p is string => Boolean(p)))];
  const clients = phones.length ? await db.client.findMany({ where: { businessId, phone: { in: phones }, deletedAt: null }, select: { id: true, phone: true } }) : [];
  const clientByPhone = new Map(clients.map((c) => [c.phone, c.id]));

  const data: Prisma.NotifyLogEntryCreateManyInput[] = todo.map((r) => {
    const meta = metaOf(r);
    const booking = meta.bookingId ? bookingById.get(meta.bookingId) : undefined;
    const user = r.app === 'telegram' ? undefined : userById.get(r.recipientUserId);
    const chat = r.app === 'telegram' ? chatById.get(r.recipientUserId) : undefined;
    const phone = user?.phone ?? chat?.phone ?? '';
    const toClient = r.app !== 'business';
    const { typeCode, typeLabel } = outboxTypeOf(r.kind, r.meta);
    const lang = (chat?.languageCode ?? user?.locale ?? 'ru').slice(0, 2);
    const sentLanguage = ['ru', 'hy', 'en'].includes(lang) ? lang : 'ru';
    const status = logStatusOf(r)!;
    return {
      id: newId('notifyLogEntry'),
      businessId,
      dedupeKey: `ob:${r.id}`,
      sentAt: r.sentAt ?? r.sendAt,
      typeCode: typeCode ?? null,
      typeLabel: typeLabel as Prisma.InputJsonValue,
      channel: CHANNEL[r.app] ?? 'push',
      status,
      contact: (phone || '—').slice(0, 160),
      // Ушло одним текстом на языке получателя — его и показываем (перевода, которого никто не получал, не выдумываем)
      text: { ru: r.body, [sentLanguage]: r.body } as Prisma.InputJsonValue,
      clientId: toClient ? (meta.clientId ?? booking?.clientId ?? (phone ? clientByPhone.get(phone) : undefined) ?? null) : null,
      staffId: meta.staffId ?? (toClient ? booking?.staffId : staffByUser.get(r.recipientUserId)) ?? booking?.staffId ?? null,
      bookingId: meta.bookingId ?? null,
      sentLanguage,
      costAmd: 0,
      smsParts: null,
      deferredFrom: r.sendAt.getTime() - r.createdAt.getTime() > 60_000 ? r.createdAt : null,
      source: 'outbox',
    };
  });
  const res = await db.notifyLogEntry.createMany({ data, skipDuplicates: true });
  return res.count;
}

/**
 * «Отправляется» → настоящий итог: строки очереди с ключом журнала (`ob:<id>` — сама строка; иначе ключ журнала целиком
 * или его продолжение `<ключ>:…` — каналы и чаты одного события). Хоть одна ушла — «Отправлено»; все закончились и ни
 * одна не ушла (в том числе пропущены настройками) — «Не доставлено»; хоть одна ещё ждёт — остаётся «Отправляется».
 */
export async function refreshSendingRows(db: PrismaService, businessId: string, now: Date, limit = 300): Promise<number> {
  const rows = await db.notifyLogEntry.findMany({
    where: { businessId, status: 'sending', sentAt: { gte: new Date(now.getTime() - 14 * 24 * 3_600_000) } },
    select: { id: true, dedupeKey: true },
    orderBy: { sentAt: 'asc' },
    take: limit,
  });
  let changed = 0;
  for (const row of rows) {
    const key = row.dedupeKey;
    const outbox = key.startsWith('ob:')
      ? await db.notifyOutbox.findMany({ where: { id: key.slice(3) }, select: { status: true, lastError: true, sentAt: true } })
      : await db.notifyOutbox.findMany({ where: { OR: [{ dedupeKey: key }, { dedupeKey: { startsWith: `${key}:` } }] }, select: { status: true, lastError: true, sentAt: true } });
    if (!outbox.length) continue;
    const states = outbox.map(logStatusOf);
    let next: 'sent' | 'notDelivered' | null = null;
    if (states.includes('sent')) next = 'sent';
    else if (!states.includes('sending')) next = 'notDelivered';
    if (!next) continue;
    const sentAt = outbox.map((o) => o.sentAt).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0];
    await db.notifyLogEntry.update({ where: { id: row.id }, data: { status: next, ...(key.startsWith('ob:') && sentAt ? { sentAt } : {}) } });
    changed++;
  }
  return changed;
}
