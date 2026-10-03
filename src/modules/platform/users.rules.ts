import type { Prisma } from '../../generated/prisma/client.js';
import { localDayRangeUtc } from '../../common/time/time.js';
import type { UsersListQuery } from './users.schemas.js';

/**
 * «Пользователи» нашей панели — чистые правила без базы: фильтры → where, статус человека, маска IP.
 * Тесты — users.test.ts.
 */

export type UserStatus = 'active' | 'blocked' | 'delete_requested' | 'deleted';
export type BusinessRole = 'owner' | 'admin' | 'master';

const DAY_MS = 86_400_000;

/** Действующая роль в бизнесе: строка staff не удалена и не уволена */
export const LIVE_STAFF: Prisma.StaffWhereInput = { deletedAt: null, status: { not: 'fired' } };
const LIVE_NETWORK: Prisma.NetworkWhereInput = { deletedAt: null };

/** Статус: удалён > заблокирован > просил удалить > активен */
export function userStatusOf(u: { blockedAt: Date | null; deleteRequestedAt: Date | null; deletedAt: Date | null }): UserStatus {
  if (u.deletedAt) return 'deleted';
  if (u.blockedAt) return 'blocked';
  if (u.deleteRequestedAt) return 'delete_requested';
  return 'active';
}

export function statusWhere(status: UserStatus): Prisma.UserWhereInput {
  switch (status) {
    case 'deleted':
      return { deletedAt: { not: null } };
    case 'blocked':
      return { deletedAt: null, blockedAt: { not: null } };
    case 'delete_requested':
      return { deletedAt: null, blockedAt: null, deleteRequestedAt: { not: null } };
    default:
      return { deletedAt: null, blockedAt: null, deleteRequestedAt: null };
  }
}

/** Цифры поиска → часть номера '+374XXXXXXXX': «091 12 34 56» → «91123456», «374 91…» → «37491…» */
export function phoneNeedle(q: string): string | null {
  let digits = q.replace(/\D/g, '');
  if (digits.length < 3) return null;
  if (digits.startsWith('0') && digits.length === 9) digits = digits.slice(1);
  return digits;
}

/** Кто подключил Telegram-бота (не отписался): по id человека или по номеру */
export interface TelegramSet {
  userIds: string[];
  phones: string[];
}

export function telegramWhere(tg: TelegramSet, connected: boolean): Prisma.UserWhereInput {
  if (connected) return { OR: [{ id: { in: tg.userIds } }, { phone: { in: tg.phones } }] };
  return { AND: [{ id: { notIn: tg.userIds } }, { OR: [{ phone: null }, { phone: { notIn: tg.phones } }] }] };
}

export function roleWhere(role: Exclude<UsersListQuery['role'], undefined>, multipleIds: string[]): Prisma.UserWhereInput {
  switch (role) {
    case 'client':
      return { staff: { none: LIVE_STAFF }, networks: { none: LIVE_NETWORK } };
    case 'owner':
      return { OR: [{ staff: { some: { ...LIVE_STAFF, role: 'owner' } } }, { networks: { some: LIVE_NETWORK } }] };
    case 'admin':
    case 'master':
      return { staff: { some: { ...LIVE_STAFF, role } } };
    default:
      return { id: { in: multipleIds } };
  }
}

/**
 * Фильтры списка → where для prisma.user. Телеграм и «несколько ролей» нельзя выразить связью User —
 * их множества считает сервис заранее и передаёт сюда.
 */
export function buildUserWhere(q: UsersListQuery, deps: { now: Date; telegram?: TelegramSet; multipleIds?: string[] }): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  const text = q.q?.trim();
  if (text) {
    const digits = phoneNeedle(text);
    and.push({ OR: [{ name: { contains: text } }, ...(digits ? [{ phone: { contains: digits } }] : [])] });
  }
  if (q.role) and.push(roleWhere(q.role, deps.multipleIds ?? []));
  if (q.regFrom || q.regTo) {
    and.push({
      createdAt: {
        ...(q.regFrom ? { gte: localDayRangeUtc(q.regFrom).from } : {}),
        ...(q.regTo ? { lt: localDayRangeUtc(q.regTo).to } : {}),
      },
    });
  }
  if (q.activeDays) and.push({ sessions: { some: { lastSeenAt: { gte: new Date(deps.now.getTime() - q.activeDays * DAY_MS) } } } });
  if (q.telegram) and.push(telegramWhere(deps.telegram ?? { userIds: [], phones: [] }, q.telegram === 'yes'));
  if (q.google) and.push({ identities: q.google === 'yes' ? { some: { provider: 'google' } } : { none: { provider: 'google' } } });
  if (q.status) and.push(statusWhere(q.status));
  return and.length ? { AND: and } : {};
}

/** IP входа — без последних двух частей: '93.184.216.34' → '93.184.•.•', IPv6 — первые две группы */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  const parts = v4.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return `${parts[0]}.${parts[1]}.•.•`;
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean);
    return groups.length >= 2 ? `${groups[0]}:${groups[1]}:…` : '…';
  }
  return '…';
}

/** Роли человека в бизнесах без повторов, в порядке «владелец → администратор → мастер» */
export function rolesOf(staff: { role: string }[], ownsNetwork: boolean): BusinessRole[] {
  const set = new Set<BusinessRole>();
  if (ownsNetwork) set.add('owner');
  for (const s of staff) if (s.role === 'owner' || s.role === 'admin' || s.role === 'master') set.add(s.role);
  return (['owner', 'admin', 'master'] as const).filter((r) => set.has(r));
}

/** Сортировка в памяти по числу/дате (null — в конце при любом направлении), затем по id для устойчивости */
export function sortIds<T extends { id: string; value: number | null }>(rows: T[], dir: 'asc' | 'desc'): T[] {
  return [...rows].sort((a, b) => {
    if (a.value === null && b.value === null) return a.id.localeCompare(b.id);
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    const d = dir === 'asc' ? a.value - b.value : b.value - a.value;
    return d || a.id.localeCompare(b.id);
  });
}
