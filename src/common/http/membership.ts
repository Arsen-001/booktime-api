import { Injectable } from '@nestjs/common';
import { newId } from '../ids/ids.js';
import { logger } from '../logging/logger.js';
import { effectivePermissions, isPermission, type StaffRole } from '../permissions/permissions.js';
import { PrismaService } from '../prisma.service.js';
import type { MemberInfo, RequestContext, SessionInfo } from './context.js';
import type { MembershipLister, MembershipResolver, MembershipSummary } from './resolvers.js';
import { ipAllowedBy, normalizeIp } from './salon-ip.js';

/** Грубые права, сохранённые владельцем (staff.permissions JSON) — только известные строки */
export function storedPermissions(raw: unknown): string[] | null {
  return Array.isArray(raw) ? raw.filter(isPermission) : null;
}

/** Роль для шаблона прав: владелец индивидуального бизнеса — individual (как персона фронта) */
export function permissionRole(staffRole: string, kind: string): StaffRole {
  if (staffRole === 'owner') return kind === 'individual' ? 'individual' : 'owner';
  if (staffRole === 'admin') return 'admin';
  return 'master';
}

interface Row {
  businessId: string;
  businessName: string;
  kind: string;
  networkId: string | null;
  staffId: string;
  role: string;
  name: string;
  locationIds: string[];
  businessIds: string[];
  permissions: string[];
  /** «Вход только с IP салона» (ответ 22): адреса салона, если галочка стоит у этого сотрудника; владельцу и сети — null */
  salonIps: string[] | null;
}

/** Список адресов салона из JSON (businesses.salon_ips): только строки */
export function salonIpList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** Закрыт ли кабинет для этого адреса: галочка есть, а адрес не из списка салона (пустой список — закрыт для всех адресов) */
function ipClosed(salonIps: string[] | null, ip: string): boolean {
  return salonIps !== null && !ipAllowedBy(salonIps, ip);
}

/**
 * Членство вошедшего в бизнесах (docs/backend/03 §1–2). Читается из базы на КАЖДОМ запросе: снятая галочка,
 * отключённый доступ и увольнение действуют со следующего запроса (F-00-039/040). 500 салонов (Р20) это выдерживают.
 *
 *  - сотрудник: строка staff с user_id = я, status = active, доступ включён (у владельца — всегда), не удалён;
 *  - владелец сети: во всех филиалах сети — роль network (все права), сотрудник — владелец сети;
 *  - вход логином администратора: только его бизнес и его строка staff (F-00-034).
 *  - «Вход только с IP салона» (ответ 22, 20.11.2026): у сотрудника с галочкой членство есть только с адресов салона —
 *    на каждом запросе, а не только при входе (сессия могла начаться в салоне). Владельца и сеть не касается никогда.
 */
@Injectable()
export class DbMembership implements MembershipResolver, MembershipLister {
  constructor(private readonly prisma: PrismaService) {}

  private async rows(userId: string, staffLoginId?: string | null, onlyBusinessId?: string): Promise<Row[]> {
    let onlyStaffId: string | undefined;
    if (staffLoginId) {
      const sl = await this.prisma.staffLogin.findUnique({ where: { id: staffLoginId }, select: { staffId: true, disabledAt: true } });
      if (!sl?.staffId || sl.disabledAt) return [];
      onlyStaffId = sl.staffId;
    }
    const staff = await this.prisma.staff.findMany({
      where: {
        ...(onlyStaffId ? { id: onlyStaffId } : { userId }),
        ...(onlyBusinessId ? { businessId: onlyBusinessId } : {}),
        status: 'active',
        deletedAt: null,
        business: { leftAt: null },
      },
      include: { business: { include: { locations: { where: { deletedAt: null }, select: { id: true }, orderBy: { sortOrder: 'asc' } } } } },
      orderBy: { createdAt: 'asc' },
    });
    const out = new Map<string, Row>();
    for (const s of staff) {
      if (s.role !== 'owner' && !s.accessEnabled) continue;
      const role = permissionRole(s.role, s.business.kind);
      out.set(s.businessId, {
        businessId: s.businessId,
        businessName: s.business.name,
        kind: s.business.kind,
        networkId: s.business.networkId,
        staffId: s.id,
        role: s.role,
        name: s.name,
        locationIds: s.business.locations.map((l) => l.id),
        businessIds: [s.businessId],
        permissions: [...effectivePermissions(role, storedPermissions(s.permissions))],
        salonIps: s.role !== 'owner' && s.salonIpOnly ? salonIpList(s.business.salonIps) : null,
      });
    }
    if (staffLoginId) return [...out.values()];

    const networks = await this.prisma.network.findMany({
      where: { ownerUserId: userId, deletedAt: null },
      include: {
        businesses: {
          where: { leftAt: null },
          include: { locations: { where: { deletedAt: null }, select: { id: true }, orderBy: { sortOrder: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        },
        owner: { select: { name: true } },
      },
    });
    for (const n of networks) {
      const businessIds = n.businesses.map((b) => b.id);
      const locationIds = n.businesses.flatMap((b) => b.locations.map((l) => l.id));
      for (const b of n.businesses) {
        if (onlyBusinessId && b.id !== onlyBusinessId) continue;
        const own = out.get(b.id);
        out.set(b.id, {
          businessId: b.id,
          businessName: b.name,
          kind: b.kind,
          networkId: n.id,
          staffId: own?.staffId ?? n.ownerStaffId ?? b.ownerStaffId ?? '',
          role: 'network',
          name: own?.name ?? n.owner.name,
          locationIds,
          businessIds,
          permissions: [...effectivePermissions('network')],
          salonIps: null,
        });
      }
    }
    return [...out.values()];
  }

  async list(userId: string, staffLoginId?: string | null, ip?: string): Promise<MembershipSummary[]> {
    const rows = await this.rows(userId, staffLoginId);
    const out: MembershipSummary[] = [];
    for (const { name: _name, salonIps, ...r } of rows) {
      if (ip !== undefined && ipClosed(salonIps, ip)) {
        await this.recordRefusal(r.businessId, r.staffId, ip);
        out.push({ ...r, blockedIp: normalizeIp(ip) });
      } else out.push(r);
    }
    return out;
  }

  async resolve(session: SessionInfo, businessId: string, ip: string): Promise<MemberInfo | null> {
    const [row] = await this.rows(session.userId, session.staffLoginId, businessId);
    if (!row || ipClosed(row.salonIps, ip)) return null;
    const role: StaffRole = row.role === 'network' ? 'network' : permissionRole(row.role, row.kind);
    return {
      businessId: row.businessId,
      staffId: row.staffId,
      role,
      permissions: new Set(row.permissions.filter(isPermission)),
      name: row.name,
      userId: session.userId,
      kind: row.kind === 'individual' ? 'individual' : 'salon',
      networkId: row.networkId,
    };
  }

  async ipRefusal(session: SessionInfo, businessId: string, ip: string): Promise<string | null> {
    const [row] = await this.rows(session.userId, session.staffLoginId, businessId);
    if (!row || !ipClosed(row.salonIps, ip)) return null;
    await this.recordRefusal(row.businessId, row.staffId, ip);
    return normalizeIp(ip);
  }

  /**
   * Попытка не с адреса салона — владельцу в карточку сотрудника (кнопка «Добавить этот адрес»). Одна строка на
   * сотрудника и адрес: счётчик и время последней; чаще раза в минуту не пишем (экран кабинета шлёт много запросов).
   * Сбой записи не мешает ответу ip_not_allowed — только в лог.
   */
  private async recordRefusal(businessId: string, staffId: string, rawIp: string): Promise<void> {
    const ip = normalizeIp(rawIp).slice(0, 64);
    if (!ip) return;
    const now = new Date();
    try {
      const bumped = await this.prisma.salonIpAttempt.updateMany({
        where: { businessId, staffId, ip, lastAt: { lt: new Date(now.getTime() - 60_000) } },
        data: { attempts: { increment: 1 }, lastAt: now },
      });
      if (bumped.count) return;
      await this.prisma.salonIpAttempt.create({ data: { id: newId('salonIpAttempt'), businessId, staffId, ip, firstAt: now, lastAt: now } });
    } catch (err) {
      // Уже есть и записана меньше минуты назад (уникальный ключ) — так и задумано
      if ((err as { code?: string }).code !== 'P2002') logger.warn({ err, businessId, staffId }, 'salon ip attempt not recorded');
    }
  }
}

/** Живые каналы бизнеса (Р9): biz:{id}:… — член бизнеса; staff:{id} — член бизнеса этого сотрудника */
@Injectable()
export class DbLiveAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: DbMembership,
  ) {}

  async canSubscribe(ctx: Pick<RequestContext, 'session' | 'ip'>, channel: string): Promise<boolean> {
    const session = ctx.session;
    if (!session) return false;
    const biz = /^biz:([\w-]+):/.exec(channel);
    if (biz) return Boolean(await this.membership.resolve(session, biz[1]!, ctx.ip));
    const st = /^staff:([\w-]+)$/.exec(channel);
    if (st) {
      const staff = await this.prisma.staff.findUnique({ where: { id: st[1]! }, select: { businessId: true } });
      return Boolean(staff && (await this.membership.resolve(session, staff.businessId, ctx.ip)));
    }
    return false;
  }
}
