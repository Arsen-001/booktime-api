import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { maskPhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { LIVE_STAFF, buildUserWhere, maskIp, rolesOf, sortIds, userStatusOf, type BusinessRole, type TelegramSet, type UserStatus } from './users.rules.js';
import type { UserBlockBody, UsersListQuery } from './users.schemas.js';

/**
 * Наша панель → «Пользователи» (03.10.2026): все зарегистрированные люди. Секретов в ответах нет: ни хэшей, ни токенов,
 * ни кодов, ни id аккаунта Google; IP входов — с маской. Телефон в списке — с маской, полностью — в карточке.
 * Блокировка и «завершить все сессии» — только роль admin команды платформы (reviewer видит, но не действует).
 */

const DAY_MS = 86_400_000;
const RECENT_BOOKINGS = 10;
const RECENT_LOGINS = 20;

export interface PlatformUserRow {
  id: string;
  name: string;
  /** '+374 91 1•• •56' — полный номер только в карточке */
  phoneMasked: string | null;
  locale: string;
  createdAt: string;
  lastLoginAt: string | null;
  lastActiveAt: string | null;
  roles: BusinessRole[];
  telegram: boolean;
  google: boolean;
  status: UserStatus;
  bookingsCount: number;
  /** Человек из нашей команды (вход в панель) */
  team: boolean;
}

export interface PlatformUsersPage {
  rows: PlatformUserRow[];
  total: number;
  page: number;
  pageSize: number;
  counters: { total: number; new7d: number; active7d: number; telegram: number };
}

export interface PlatformUserCard {
  id: string;
  name: string;
  phone: string | null;
  locale: string;
  createdAt: string;
  status: UserStatus;
  blockedAt: string | null;
  blockReason: string | null;
  deleteRequestedAt: string | null;
  deletedAt: string | null;
  lastLogin: { at: string; method: string } | null;
  lastActiveAt: string | null;
  team: { role: string; disabled: boolean } | null;
  roles: Array<{ businessId: string; businessName: string; businessSlug: string; kind: string; role: BusinessRole; fired: boolean }>;
  networks: Array<{ id: string; name: string }>;
  telegram: { connected: boolean; since: string | null; stopped: boolean };
  google: { linked: boolean; email: string | null; since: string | null; lastUsedAt: string | null };
  bookings: { total: number; recent: Array<{ id: string; businessId: string; businessName: string; start: string; status: string }> };
  logins: Array<{ at: string; method: string; app: string; result: string; ip: string | null }>;
  activeSessions: number;
}

const local = (d: Date | null | undefined) => (d ? utcToLocal(d) : null);

@Injectable()
export class PlatformUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────── список ───────────

  async list(q: UsersListQuery, now = new Date()): Promise<PlatformUsersPage> {
    const telegram = await this.telegramSet();
    const multipleIds = q.role === 'multiple' ? await this.multipleRoleIds() : undefined;
    const where = buildUserWhere(q, { now, telegram, multipleIds });
    const skip = (q.page - 1) * q.pageSize;

    let total: number;
    let pageIds: string[];
    if (q.sort === 'registered') {
      const [count, rows] = await Promise.all([
        this.prisma.user.count({ where }),
        this.prisma.user.findMany({ where, select: { id: true }, orderBy: [{ createdAt: q.dir }, { id: q.dir }], skip, take: q.pageSize }),
      ]);
      total = count;
      pageIds = rows.map((r) => r.id);
    } else {
      // Последний вход и число записей — не поля User: считаем по всем подходящим, сортируем, режем страницу
      const all = await this.prisma.user.findMany({ where, select: { id: true } });
      const ids = all.map((r) => r.id);
      const values = q.sort === 'last_login' ? await this.lastLoginTimes(ids) : await this.bookingCounts(ids);
      const sorted = sortIds(
        ids.map((id) => ({ id, value: values.get(id) ?? (q.sort === 'bookings' ? 0 : null) })),
        q.dir,
      );
      total = ids.length;
      pageIds = sorted.slice(skip, skip + q.pageSize).map((r) => r.id);
    }

    const [rows, counters] = await Promise.all([this.rowsFor(pageIds, telegram), this.counters(now, telegram)]);
    return { rows, total, page: q.page, pageSize: q.pageSize, counters };
  }

  private async counters(now: Date, tg: TelegramSet): Promise<PlatformUsersPage['counters']> {
    const week = new Date(now.getTime() - 7 * DAY_MS);
    const [total, new7d, active7d, telegram] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: week } } }),
      this.prisma.user.count({ where: { deletedAt: null, sessions: { some: { lastSeenAt: { gte: week } } } } }),
      this.prisma.user.count({ where: { deletedAt: null, OR: [{ id: { in: tg.userIds } }, { phone: { in: tg.phones } }] } }),
    ]);
    return { total, new7d, active7d, telegram };
  }

  /** Подключённые к боту (не отписались /stop) — по id человека и по номеру */
  private async telegramSet(): Promise<TelegramSet> {
    const links = await this.prisma.telegramLink.findMany({ where: { blockedAt: null }, select: { appUserId: true, phone: true } });
    return {
      userIds: [...new Set(links.map((l) => l.appUserId).filter((x): x is string => Boolean(x)))],
      phones: [...new Set(links.map((l) => l.phone))],
    };
  }

  /** Люди с двумя и более разными ролями в бизнесах (владелец сети — тоже «владелец») */
  private async multipleRoleIds(): Promise<string[]> {
    const [staff, networks] = await Promise.all([
      this.prisma.staff.groupBy({ by: ['userId', 'role'], where: { ...LIVE_STAFF, userId: { not: null } } }),
      this.prisma.network.findMany({ where: { deletedAt: null }, select: { ownerUserId: true } }),
    ]);
    const roles = new Map<string, Set<string>>();
    const add = (userId: string, role: string) => roles.set(userId, (roles.get(userId) ?? new Set()).add(role));
    for (const s of staff) if (s.userId) add(s.userId, s.role);
    for (const n of networks) add(n.ownerUserId, 'owner');
    return [...roles].filter(([, set]) => set.size >= 2).map(([id]) => id);
  }

  private async lastLoginTimes(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.loginEvent.groupBy({ by: ['userId'], where: { userId: { in: ids }, result: 'ok' }, _max: { at: true } });
    return new Map(rows.filter((r) => r.userId && r._max.at).map((r) => [r.userId!, r._max.at!.getTime()]));
  }

  private async bookingCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.booking.groupBy({ by: ['appUserId'], where: { appUserId: { in: ids }, deletedAt: null }, _count: { _all: true } });
    return new Map(rows.filter((r) => r.appUserId).map((r) => [r.appUserId!, r._count._all]));
  }

  private async rowsFor(ids: string[], tg: TelegramSet): Promise<PlatformUserRow[]> {
    if (!ids.length) return [];
    const [users, lastLogins, lastSeen, bookings] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          phone: true,
          locale: true,
          createdAt: true,
          blockedAt: true,
          deleteRequestedAt: true,
          deletedAt: true,
          staff: { where: LIVE_STAFF, select: { role: true } },
          networks: { where: { deletedAt: null }, select: { id: true } },
          identities: { where: { provider: 'google' }, select: { id: true } },
          platformMember: { select: { id: true } },
        },
      }),
      this.lastLoginTimes(ids),
      this.prisma.session.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _max: { lastSeenAt: true } }),
      this.bookingCounts(ids),
    ]);
    const seenOf = new Map(lastSeen.map((s) => [s.userId, s._max.lastSeenAt]));
    const tgIds = new Set(tg.userIds);
    const tgPhones = new Set(tg.phones);
    const byId = new Map(users.map((u) => [u.id, u]));
    return ids
      .map((id) => byId.get(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => {
        const loginAt = lastLogins.get(u.id);
        return {
          id: u.id,
          name: u.name,
          phoneMasked: u.phone ? maskPhone(u.phone) : null,
          locale: u.locale,
          createdAt: utcToLocal(u.createdAt),
          lastLoginAt: loginAt ? utcToLocal(new Date(loginAt)) : null,
          lastActiveAt: local(seenOf.get(u.id)),
          roles: rolesOf(u.staff, u.networks.length > 0),
          telegram: tgIds.has(u.id) || (u.phone ? tgPhones.has(u.phone) : false),
          google: u.identities.length > 0,
          status: userStatusOf(u),
          bookingsCount: bookings.get(u.id) ?? 0,
          team: Boolean(u.platformMember),
        };
      });
  }

  // ─────────── карточка ───────────

  async card(id: string, now = new Date()): Promise<PlatformUserCard> {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        phone: true,
        locale: true,
        createdAt: true,
        blockedAt: true,
        deleteRequestedAt: true,
        deletedAt: true,
        staff: {
          where: { deletedAt: null },
          select: { role: true, status: true, business: { select: { id: true, name: true, slug: true, kind: true } } },
          orderBy: { createdAt: 'asc' },
        },
        networks: { where: { deletedAt: null }, select: { id: true, name: true } },
        identities: { where: { provider: 'google' }, select: { email: true, createdAt: true, lastUsedAt: true } },
        platformMember: { select: { role: true, disabledAt: true } },
      },
    });
    if (!u) throw new ApiError('not_found', 'User not found');

    const [tgLinks, bookingsTotal, recent, logins, activeSessions, lastSeen, blockEvent] = await Promise.all([
      this.prisma.telegramLink.findMany({
        where: { OR: [{ appUserId: u.id }, ...(u.phone ? [{ phone: u.phone }] : [])] },
        select: { createdAt: true, blockedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.booking.count({ where: { appUserId: u.id, deletedAt: null } }),
      this.prisma.booking.findMany({
        where: { appUserId: u.id, deletedAt: null },
        select: { id: true, businessId: true, startAt: true, status: true },
        orderBy: { startAt: 'desc' },
        take: RECENT_BOOKINGS,
      }),
      this.prisma.loginEvent.findMany({
        where: { userId: u.id },
        select: { at: true, method: true, app: true, result: true, ip: true },
        orderBy: { at: 'desc' },
        take: RECENT_LOGINS,
      }),
      this.prisma.session.count({ where: { userId: u.id, revokedAt: null, expiresAt: { gt: now } } }),
      this.prisma.session.findFirst({ where: { userId: u.id }, select: { lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } }),
      u.blockedAt
        ? this.prisma.auditEvent.findFirst({ where: { entityType: 'user', entityId: u.id, action: 'block' }, select: { diff: true }, orderBy: { at: 'desc' } })
        : Promise.resolve(null),
    ]);
    const bizIds = [...new Set(recent.map((b) => b.businessId))];
    const bizNames = bizIds.length ? await this.prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(bizNames.map((b) => [b.id, b.name]));
    const lastOk = await this.prisma.loginEvent.findFirst({ where: { userId: u.id, result: 'ok' }, select: { at: true, method: true }, orderBy: { at: 'desc' } });
    const activeLink = tgLinks.find((l) => !l.blockedAt);
    const google = u.identities[0];

    return {
      id: u.id,
      name: u.name,
      phone: u.phone,
      locale: u.locale,
      createdAt: utcToLocal(u.createdAt),
      status: userStatusOf(u),
      blockedAt: local(u.blockedAt),
      blockReason: reasonFrom(blockEvent?.diff),
      deleteRequestedAt: local(u.deleteRequestedAt),
      deletedAt: local(u.deletedAt),
      lastLogin: lastOk ? { at: utcToLocal(lastOk.at), method: lastOk.method } : null,
      lastActiveAt: local(lastSeen?.lastSeenAt),
      team: u.platformMember ? { role: u.platformMember.role, disabled: Boolean(u.platformMember.disabledAt) } : null,
      roles: u.staff
        .filter((s) => s.role === 'owner' || s.role === 'admin' || s.role === 'master')
        .map((s) => ({
          businessId: s.business.id,
          businessName: s.business.name,
          businessSlug: s.business.slug,
          kind: s.business.kind,
          role: s.role as BusinessRole,
          fired: s.status === 'fired',
        })),
      networks: u.networks.map((n) => ({ id: n.id, name: n.name })),
      telegram: { connected: Boolean(activeLink), since: local((activeLink ?? tgLinks[0])?.createdAt), stopped: !activeLink && tgLinks.length > 0 },
      google: { linked: Boolean(google), email: google?.email ?? null, since: local(google?.createdAt), lastUsedAt: local(google?.lastUsedAt) },
      bookings: {
        total: bookingsTotal,
        recent: recent.map((b) => ({ id: b.id, businessId: b.businessId, businessName: nameOf.get(b.businessId) ?? '', start: utcToLocal(b.startAt), status: b.status })),
      },
      logins: logins.map((l) => ({ at: utcToLocal(l.at), method: l.method, app: l.app, result: l.result, ip: maskIp(l.ip) })),
      activeSessions,
    };
  }

  // ─────────── действия (только admin команды) ───────────

  async setBlocked(ctx: RequestContext, id: string, body: UserBlockBody): Promise<{ status: UserStatus; revokedSessions: number }> {
    await this.assertAdmin(ctx);
    if (ctx.session!.userId === id) throw new ApiError('conflict', 'Cannot block yourself');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id }, select: { id: true, blockedAt: true, deleteRequestedAt: true, deletedAt: true } });
      if (!u) throw new ApiError('not_found', 'User not found');
      if (u.deletedAt) throw new ApiError('conflict', 'User is deleted');
      const reason = body.reason?.trim() || null;
      if (body.blocked === Boolean(u.blockedAt)) return { status: userStatusOf(u), revokedSessions: 0 };
      const at = new Date();
      let revokedSessions = 0;
      if (body.blocked) {
        await tx.user.update({ where: { id }, data: { blockedAt: at, sessionsRevokedAt: at, updatedBy: ctx.session!.userId, version: { increment: 1 } } });
        // Сессии отзываем сразу: резолвер и так не пускает заблокированного, но строки должны быть закрыты (журнал устройств)
        const res = await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: at, revokeReason: 'blocked' } });
        revokedSessions = res.count;
      } else {
        await tx.user.update({ where: { id }, data: { blockedAt: null, updatedBy: ctx.session!.userId, version: { increment: 1 } } });
      }
      await this.audit.record(tx, ctx, {
        action: body.blocked ? 'block' : 'unblock',
        entityType: 'user',
        entityId: id,
        before: { blockedAt: u.blockedAt?.toISOString() ?? null, blockReason: null },
        after: { blockedAt: body.blocked ? at.toISOString() : null, blockReason: reason, revokedSessions: body.blocked ? revokedSessions : null },
      });
      return { status: userStatusOf({ ...u, blockedAt: body.blocked ? at : null }), revokedSessions };
    });
  }

  async revokeSessions(ctx: RequestContext, id: string): Promise<{ revoked: number }> {
    await this.assertAdmin(ctx);
    if (ctx.session!.userId === id) throw new ApiError('conflict', 'Use your own account settings');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id }, select: { id: true } });
      if (!u) throw new ApiError('not_found', 'User not found');
      const at = new Date();
      const res = await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: at, revokeReason: 'logout_all' } });
      await tx.user.update({ where: { id }, data: { sessionsRevokedAt: at } });
      await this.audit.record(tx, ctx, { action: 'sessions_revoke', entityType: 'user', entityId: id, before: { activeSessions: res.count }, after: { activeSessions: 0 } });
      return { revoked: res.count };
    });
  }

  /** Более строгое право панели: действия над людьми — только роль admin (reviewer — только смотреть) */
  private async assertAdmin(ctx: RequestContext): Promise<void> {
    const memberId = ctx.session?.platformMemberId;
    const m = memberId ? await this.prisma.platformMember.findUnique({ where: { id: memberId }, select: { role: true, disabledAt: true } }) : null;
    if (!m || m.disabledAt || m.role !== 'admin') throw new ApiError('forbidden', 'Platform admin role required');
  }
}

/** Причина блокировки — из последнего события журнала { blockReason: [было, стало] } */
function reasonFrom(diff: Prisma.JsonValue | undefined): string | null {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return null;
  const pair = (diff as Record<string, unknown>).blockReason;
  return Array.isArray(pair) && typeof pair[1] === 'string' ? pair[1] : null;
}
