import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../common/ids/ids.js';
import type { PrismaService } from '../../common/prisma.service.js';

export type Tx = Prisma.TransactionClient;
export type Db = PrismaService | Tx;

const J = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

export interface OutboxInput {
  businessId?: string | null;
  /** client | business — чьи токены (PushToken.app) слать */
  app: 'client' | 'business';
  kind: string;
  recipientUserId: string;
  title: string;
  body: string;
  url?: string;
  /** Уникально: повторная попытка того же события не создаёт вторую строку (05 §4 «ключ дубля») */
  dedupeKey: string;
  sendAt?: Date;
  meta?: Record<string, unknown>;
}

/**
 * Кладёт строку в очередь отправки (05 §4). `dedupeKey` уникален — вызов с уже известным ключом ничего не
 * делает и возвращает false, поэтому вызывающему безопасно звать это на каждый проход задачи, а не только
 * один раз в жизни события.
 */
export async function enqueueOutbox(db: Db, input: OutboxInput): Promise<boolean> {
  const existing = await db.notifyOutbox.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
  if (existing) return false;
  try {
    await db.notifyOutbox.create({
      data: {
        id: newId('notifyOutbox'),
        businessId: input.businessId ?? null,
        app: input.app,
        kind: input.kind,
        recipientUserId: input.recipientUserId,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 600),
        url: input.url,
        dedupeKey: input.dedupeKey,
        sendAt: input.sendAt ?? new Date(),
        meta: J(input.meta),
      },
    });
    return true;
  } catch (err) {
    // Гонка: два прохода задачи вставили один dedupeKey одновременно — вторая строка не нужна, не сбой
    if ((err as { code?: string }).code === 'P2002') return false;
    throw err;
  }
}

export interface ClientNotificationInput extends Omit<OutboxInput, 'recipientUserId' | 'app'> {
  appUserId: string;
  /** Лента /v1/me/inbox (F-14-055) — пишется в паре с очередью, тем же dedupeKey определяем «уже было» */
  inbox?: {
    kind: string;
    businessId?: string | null;
    staffId?: string | null;
    bookingId?: string | null;
    params?: Record<string, unknown>;
  };
}

/** Клиенту: строка в очередь + (опционально) строка в его ленту — атомарно, одной проверкой dedupeKey */
export async function enqueueClientNotification(db: Db, input: ClientNotificationInput): Promise<boolean> {
  const created = await enqueueOutbox(db, { ...input, app: 'client', recipientUserId: input.appUserId });
  if (created && input.inbox) {
    await db.inboxItem.create({
      data: {
        id: newId('inboxItem'),
        appUserId: input.appUserId,
        kind: input.inbox.kind,
        businessId: input.inbox.businessId ?? null,
        staffId: input.inbox.staffId ?? null,
        bookingId: input.inbox.bookingId ?? null,
        params: J(input.inbox.params),
      },
    });
  }
  return created;
}
