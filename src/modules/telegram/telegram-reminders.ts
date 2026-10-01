import { t } from '../../common/i18n/i18n.js';
import { normalizePhone } from '../../common/phone.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { enqueueOutbox } from '../notify/outbox.js';
import { tgLocale } from './telegram-links.js';
import { bookingCard, bookingKeyboard, cardText } from './telegram-texts.js';

const ACTIVE_FOR_REMINDER = ['scheduled', 'client_confirmed'];
/** «Напоминание о визите» в каталоге типов (notify-type-registry.ts) */
const REMINDER_TYPE_CODE = 1;

/**
 * Напоминания 24ч/2ч в Telegram (30.09.2026) — клиентам БЕЗ нашего приложения (нет живого push-токена app='client'),
 * чей номер привязан к боту. Та же очередь notify_outbox (app='telegram', recipientUserId = chat id), тот же ключ
 * дубля `telegram:<kind>:<booking>:<chat>` — повторный проход задачи ничего не дублирует. Выключенный бизнесом тип
 * (reminder24h/reminder2h) отсекает отправитель очереди (`isKindEnabled`), как и для пушей. Выключатель Telegram у самой
 * записи (Booking.notifyOverride.telegramEnabled === false, окно записи → «Уведомления о визите») — запись пропускается.
 */
export async function enqueueTelegramReminders(prisma: PrismaService, kind: 'reminder24h' | 'reminder2h', from: Date, to: Date): Promise<{ sent: number; candidates: number }> {
  const bookings = await prisma.booking.findMany({ where: { status: { in: ACTIVE_FOR_REMINDER }, deletedAt: null, startAt: { gte: from, lt: to } } });
  if (!bookings.length) return { sent: 0, candidates: 0 };
  const clientIds = [...new Set(bookings.map((b) => b.clientId).filter((v): v is string => Boolean(v)))];
  const clients = clientIds.length ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, phone: true, appUserId: true } }) : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const userIds = [...new Set(bookings.map((b) => b.appUserId ?? (b.clientId ? clientById.get(b.clientId)?.appUserId : null)).filter((v): v is string => Boolean(v)))];
  const [users, tokens] = userIds.length
    ? await Promise.all([
        prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, phone: true } }),
        prisma.pushToken.findMany({ where: { userId: { in: userIds }, app: 'client', invalidAt: null }, select: { userId: true } }),
      ])
    : [[], []];
  const phoneByUser = new Map(users.map((u) => [u.id, u.phone]));
  const withApp = new Set(tokens.map((x) => x.userId));

  // Каталог типов (экран «Уведомления» → «Напоминание о визите», код 1): тип выключен или сценарий Telegram
  // «Не отправлять» — бизнес Telegram-напоминаний не шлёт (01.10.2026). Нет строки — действует реестр: включено.
  const businessIds = [...new Set(bookings.map((b) => b.businessId))];
  const typeRows = await prisma.notifyTypeOverride.findMany({ where: { businessId: { in: businessIds }, code: REMINDER_TYPE_CODE } });
  const telegramOff = new Set(
    typeRows
      .filter((r) => r.enabled === false || (r.channels as { channel: string; scenario: string }[] | null)?.some((c) => c.channel === 'telegram' && c.scenario === 'off'))
      .map((r) => r.businessId),
  );

  let sent = 0;
  let candidates = 0;
  for (const b of bookings) {
    if (telegramOff.has(b.businessId)) continue;
    const client = b.clientId ? clientById.get(b.clientId) : undefined;
    const userId = b.appUserId ?? client?.appUserId ?? null;
    if (userId && withApp.has(userId)) continue; // у человека есть приложение — ему уходит пуш
    // Выключатель «Telegram» в окне записи («Уведомления о визите», 01.10.2026) — PUT …/notify-override
    if ((b.notifyOverride as { telegramEnabled?: boolean } | null)?.telegramEnabled === false) continue;
    const rawPhone = client?.phone || (userId ? phoneByUser.get(userId) : null);
    const phone = rawPhone ? normalizePhone(rawPhone) : undefined;
    if (!phone) continue;
    const links = await prisma.telegramLink.findMany({ where: { phone, blockedAt: null } });
    if (!links.length) continue;
    candidates++;
    for (const link of links) {
      const locale = tgLocale(link.languageCode);
      const card = await bookingCard(prisma, b, locale);
      const body = `${t(locale, kind === 'reminder24h' ? 'tg.reminder24h' : 'tg.reminder2h')}\n\n${cardText(card)}`;
      const created = await enqueueOutbox(prisma, {
        businessId: b.businessId,
        app: 'telegram',
        kind,
        recipientUserId: link.chatId,
        title: card.businessName,
        body,
        dedupeKey: `telegram:${kind}:${b.id}:${link.chatId}`,
        meta: { bookingId: b.id, replyMarkup: bookingKeyboard(b, card, locale) },
      });
      if (created) sent++;
    }
  }
  return { sent, candidates };
}
