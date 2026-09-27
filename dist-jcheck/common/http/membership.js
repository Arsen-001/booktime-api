var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { effectivePermissions, isPermission } from '../permissions/permissions.js';
import { PrismaService } from '../prisma.service.js';
/** Грубые права, сохранённые владельцем (staff.permissions JSON) — только известные строки */
export function storedPermissions(raw) {
    return Array.isArray(raw) ? raw.filter(isPermission) : null;
}
/** Роль для шаблона прав: владелец индивидуального бизнеса — individual (как персона фронта) */
export function permissionRole(staffRole, kind) {
    if (staffRole === 'owner')
        return kind === 'individual' ? 'individual' : 'owner';
    if (staffRole === 'admin')
        return 'admin';
    return 'master';
}
/**
 * Членство вошедшего в бизнесах (docs/backend/03 §1–2). Читается из базы на КАЖДОМ запросе: снятая галочка,
 * отключённый доступ и увольнение действуют со следующего запроса (F-00-039/040). 500 салонов (Р20) это выдерживают.
 *
 *  - сотрудник: строка staff с user_id = я, status = active, доступ включён (у владельца — всегда), не удалён;
 *  - владелец сети: во всех филиалах сети — роль network (все права), сотрудник — владелец сети;
 *  - вход логином администратора: только его бизнес и его строка staff (F-00-034).
 */
let DbMembership = class DbMembership {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async rows(userId, staffLoginId, onlyBusinessId) {
        let onlyStaffId;
        if (staffLoginId) {
            const sl = await this.prisma.staffLogin.findUnique({ where: { id: staffLoginId }, select: { staffId: true, disabledAt: true } });
            if (!sl?.staffId || sl.disabledAt)
                return [];
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
        const out = new Map();
        for (const s of staff) {
            if (s.role !== 'owner' && !s.accessEnabled)
                continue;
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
            });
        }
        if (staffLoginId)
            return [...out.values()];
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
                if (onlyBusinessId && b.id !== onlyBusinessId)
                    continue;
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
                });
            }
        }
        return [...out.values()];
    }
    async list(userId, staffLoginId) {
        const rows = await this.rows(userId, staffLoginId);
        return rows.map(({ name: _name, ...r }) => r);
    }
    async resolve(session, businessId) {
        const [row] = await this.rows(session.userId, session.staffLoginId, businessId);
        if (!row)
            return null;
        const role = row.role === 'network' ? 'network' : permissionRole(row.role, row.kind);
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
};
DbMembership = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], DbMembership);
export { DbMembership };
/** Живые каналы бизнеса (Р9): biz:{id}:… — член бизнеса; staff:{id} — член бизнеса этого сотрудника */
let DbLiveAccess = class DbLiveAccess {
    constructor(prisma, membership) {
        this.prisma = prisma;
        this.membership = membership;
    }
    async canSubscribe(ctx, channel) {
        const session = ctx.session;
        if (!session)
            return false;
        const biz = /^biz:([\w-]+):/.exec(channel);
        if (biz)
            return Boolean(await this.membership.resolve(session, biz[1]));
        const st = /^staff:([\w-]+)$/.exec(channel);
        if (st) {
            const staff = await this.prisma.staff.findUnique({ where: { id: st[1] }, select: { businessId: true } });
            return Boolean(staff && (await this.membership.resolve(session, staff.businessId)));
        }
        return false;
    }
};
DbLiveAccess = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService,
        DbMembership])
], DbLiveAccess);
export { DbLiveAccess };
//# sourceMappingURL=membership.js.map