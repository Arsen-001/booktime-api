import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type Staff } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { SessionStore } from '../../common/http/sessions.js';
import { newId } from '../../common/ids/ids.js';
import { LiveService } from '../../common/live/live.service.js';
import { isPermission } from '../../common/permissions/permissions.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { norm } from '../../common/text.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { hashPassword, isWeakPassword } from '../auth/passwords.js';
import { accessView, defaultRoleTemplate, inviteView, positionView, staffViewWithLogin } from '../businesses/views.js';
import type { AddStaffBody, PatchStaffBody } from './staff.schemas.js';

type Tx = Prisma.TransactionClient;

const STAFF_INCLUDE = {
  locations: { select: { locationId: true } },
  logins: { select: { login: true, disabledAt: true } },
} as const;

const INVITE_TTL_DAYS = 14;
const HOUR = 36e5;

/** Правило восстановления (F-10-044): 24 ч — сразу; до 30 дней — нельзя; дальше — снова можно (как restoreWindowFromDates фронта) */
function restoreWindow(since: Date, now = new Date()): 'immediate' | 'blocked' | 'available' {
  const hours = (now.getTime() - since.getTime()) / HOUR;
  if (hours <= 24) return 'immediate';
  if (hours <= 24 * 30) return 'blocked';
  return 'available';
}

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Поля, которые мастер правит в своей карточке сам (свой профиль — 02 §7), без staff.manage */
const SELF_FIELDS = new Set<keyof PatchStaffBody>([
  'avatarUrl',
  'bio',
  'workplaces',
  'contacts',
  'callHours',
  'materials',
  'photos',
  'homeAddress',
  'homeDistrict',
  'visitDistricts',
  'accepts',
  'calendarVisibility',
  'calendarMode',
  'confirmMode',
  'prepayment',
  'bookingRules',
]);

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionStore,
    private readonly live: LiveService,
  ) {}

  // ─────────── чтение ───────────

  private async find(businessId: string, staffId: string, opts: { withDeleted?: boolean } = {}) {
    const s = await this.prisma.staff.findFirst({
      where: { id: staffId, businessId, ...(opts.withDeleted ? {} : { deletedAt: null }) },
      include: STAFF_INCLUDE,
    });
    if (!s) throw new ApiError('not_found', 'Staff not found');
    return s;
  }

  /** Все сотрудники бизнеса (и уволенные — фильтр «уволенные» на экране, F-10-007), без удалённых */
  async list(businessId: string) {
    const rows = await this.prisma.staff.findMany({
      where: { businessId, deletedAt: null },
      include: STAFF_INCLUDE,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((s) => ({ staff: staffViewWithLogin(s), order: s.sortOrder }));
  }

  async get(businessId: string, staffId: string) {
    return staffViewWithLogin(await this.find(businessId, staffId));
  }

  private async publish(businessId: string, staffId: string) {
    await this.live.publish(`staff:${staffId}`, { type: 'staff.changed', data: { businessId, staffId } });
  }

  // ─────────── добавить (F-10-015…023) ───────────

  async add(ctx: RequestContext, businessId: string, input: AddStaffBody) {
    const name = input.name.trim();
    if (!name) throw new ApiError('invalid_field', 'name required', { name: 'required' });
    let phone = '';
    if (input.phone?.trim()) {
      const p = normalizePhone(input.phone);
      if (!p) throw new ApiError('invalid_field', 'invalid phone', { phone: 'invalid' });
      phone = p;
    } else if (input.role === 'master') {
      throw new ApiError('invalid_field', 'phone required', { phone: 'required' });
    }
    if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) throw new ApiError('invalid_field', 'invalid email', { email: 'invalid' });
    if (input.role === 'owner') throw new ApiError('forbidden', 'Owner is set by transfer of ownership');
    const locations = await this.prisma.location.findMany({ where: { businessId, deletedAt: null }, select: { id: true } });
    const locationIds = input.locationIds.filter((id) => locations.some((l) => l.id === id));
    if (!locationIds.length && locations[0]) locationIds.push(locations[0].id);
    const grantAccess = input.grantAccess ?? true;
    const id = newId('staff');
    let inviteToken: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      const siblings = await tx.staff.count({ where: { businessId } });
      const position = input.position?.trim() ? await this.ensurePosition(tx, ctx, businessId, input.position.trim()) : null;
      await tx.staff.create({
        data: {
          id,
          businessId,
          name,
          phone,
          email: input.email?.trim() || null,
          role: input.role,
          roleTemplateId: input.roleTemplateId ?? defaultRoleTemplate(input.role),
          // Как в моке: сотрудник с входом ждёт согласия (F-00-042); без входа — тоже «приглашён», пока нет аккаунта
          status: 'invited',
          position: position ? (position.name as Prisma.InputJsonValue) : undefined,
          positionId: position?.id ?? null,
          specialty: input.specialty?.trim() ? { ru: input.specialty.trim() } : undefined,
          sphereIds: input.sphereIds,
          photos: [],
          materials: [],
          workplaces: input.asAssistant ? [] : ['salon'],
          serviceIds: [],
          confirmMode: 'manual', // В-03
          colorIndex: (siblings % 8) + 1,
          hiredAt: utcToLocalDate(new Date()),
          sortOrder: siblings,
          accessEnabled: grantAccess,
          assistantOnly: Boolean(input.asAssistant),
          createdBy: ctx.member!.staffId,
          updatedBy: ctx.member!.staffId,
          locations: { create: locationIds.map((locationId) => ({ locationId })) },
        },
      });
      if (grantAccess && (phone || input.email)) inviteToken = await this.createInvite(tx, ctx, businessId, id, input.role === 'admin' ? 'admin' : 'master', phone || null, input.email ?? null);
      await this.audit.record(tx, ctx, { action: 'created', entityType: 'staff', entityId: id, businessId, after: { name, role: input.role } });
    });
    await this.publish(businessId, id);
    return { staff: await this.get(businessId, id), inviteLink: inviteToken ? inviteUrl(inviteToken) : null };
  }

  private async ensurePosition(tx: Tx, ctx: RequestContext, businessId: string, name: string) {
    const existing = await tx.position.findFirst({ where: { businessId, nameNorm: norm(name) } });
    if (existing) return existing;
    const count = await tx.position.count({ where: { businessId } });
    const p = await tx.position.create({
      data: { id: newId('position'), businessId, name: { ru: name }, nameNorm: norm(name), sortOrder: count, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId },
    });
    await this.audit.record(tx, ctx, { action: 'created', entityType: 'staffPosition', entityId: p.id, businessId, after: { name } });
    return p;
  }

  // ─────────── правка карточки (F-10-024…039) ───────────

  async patch(ctx: RequestContext, businessId: string, staffId: string, input: PatchStaffBody, version: number | undefined) {
    const member = ctx.member!;
    const self = member.staffId === staffId;
    const manage = member.permissions.has('staff.manage');
    const keys = Object.keys(input) as (keyof PatchStaffBody)[];
    if (!manage && !(self && keys.every((k) => SELF_FIELDS.has(k)))) throw new ApiError('forbidden', 'Missing permission: staff.manage');
    const before = await this.find(businessId, staffId);
    const data: Record<string, unknown> = { updatedBy: member.staffId };
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new ApiError('invalid_field', 'name required', { name: 'required' });
      data.name = input.name.trim();
    }
    if (input.phone !== undefined) {
      if (input.phone.trim()) {
        const p = normalizePhone(input.phone);
        if (!p) throw new ApiError('invalid_field', 'invalid phone', { phone: 'invalid' });
        data.phone = p;
      } else if (before.role === 'master') {
        throw new ApiError('invalid_field', 'phone required', { phone: 'required' });
      } else data.phone = '';
    }
    if (input.email !== undefined) {
      if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) throw new ApiError('invalid_field', 'invalid email', { email: 'invalid' });
      data.email = input.email?.trim() || null;
    }
    const jsonFields = [
      'specialty',
      'bio',
      'sphereIds',
      'photos',
      'materials',
      'workplaces',
      'visitDistricts',
      'callHours',
      'prepayment',
      'bookingRules',
      'contacts',
      'serviceIds',
    ] as const;
    for (const f of jsonFields) if (input[f] !== undefined) data[f] = input[f] ?? null;
    const plain = [
      'avatarUrl',
      'homeAddress',
      'homeDistrict',
      'accepts',
      'calendarVisibility',
      'calendarMode',
      'confirmMode',
      'colorIndex',
      'hiredAt',
      'onlineBookingEnabled',
      'hiddenInJournal',
      'assistantOnly',
      'journalMarkupMin',
    ] as const;
    for (const f of plain) if (input[f] !== undefined) data[f] = input[f] ?? null;

    await this.prisma.$transaction(async (tx) => {
      if (input.position !== undefined) {
        const name = input.position?.trim();
        if (name) {
          const p = await this.ensurePosition(tx, ctx, businessId, name);
          data.position = p.name;
          data.positionId = p.id;
        } else {
          data.position = null;
          data.positionId = null;
        }
      }
      // JSON null в Prisma — отдельное значение; «нет поля» у экрана = SQL NULL
      for (const [k, v] of Object.entries(data)) if (v === null && isJsonField(k)) data[k] = DbNull;
      const res = await tx.staff.updateMany({
        where: version === undefined ? { id: staffId, businessId } : { id: staffId, businessId, version },
        data: { ...data, version: { increment: 1 } } as Prisma.StaffUpdateManyMutationInput,
      });
      if (res.count !== 1) throw new ApiError('conflict', 'Changed by someone else');
      if (input.locationIds) {
        const allowed = await tx.location.findMany({ where: { businessId, id: { in: input.locationIds }, deletedAt: null }, select: { id: true } });
        await tx.staffLocation.deleteMany({ where: { staffId } });
        if (allowed.length) await tx.staffLocation.createMany({ data: allowed.map((l) => ({ staffId, locationId: l.id })) });
      }
      if (input.serviceIds) {
        // Услуга ↔ мастер хранится дважды (01 §4): держим Service.staffIds в паре со Staff.serviceIds
        const prevIds = new Set(before.serviceIds as string[]);
        const nextIds = new Set(input.serviceIds);
        const added = input.serviceIds.filter((id) => !prevIds.has(id));
        const removed = [...prevIds].filter((id) => !nextIds.has(id));
        if (added.length) {
          const rows = await tx.service.findMany({ where: { id: { in: added }, businessId }, select: { id: true, staffIds: true } });
          for (const r of rows) {
            const ids = new Set(Array.isArray(r.staffIds) ? (r.staffIds as string[]) : []);
            if (!ids.has(staffId)) await tx.service.update({ where: { id: r.id }, data: { staffIds: [...ids, staffId] } });
          }
        }
        if (removed.length) {
          const rows = await tx.service.findMany({ where: { id: { in: removed }, businessId }, select: { id: true, staffIds: true } });
          for (const r of rows) {
            const ids = (Array.isArray(r.staffIds) ? (r.staffIds as string[]) : []).filter((x) => x !== staffId);
            await tx.service.update({ where: { id: r.id }, data: { staffIds: ids } });
          }
          await tx.staffServiceTerm.deleteMany({ where: { staffId, serviceId: { in: removed } } });
        }
      }
      const after = await tx.staff.findUniqueOrThrow({ where: { id: staffId }, include: STAFF_INCLUDE });
      await this.audit.record(tx, ctx, {
        action: 'update',
        entityType: 'staff',
        entityId: staffId,
        businessId,
        before: auditFields(staffViewWithLogin(before)),
        after: auditFields(staffViewWithLogin(after)),
      });
    });
    await this.publish(businessId, staffId);
    return this.get(businessId, staffId);
  }

  async reorder(ctx: RequestContext, businessId: string, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const [idx, id] of ids.entries()) {
        await tx.staff.updateMany({ where: { id, businessId }, data: { sortOrder: idx, updatedBy: ctx.member!.staffId } });
      }
    });
  }

  // ─────────── увольнение, восстановление, удаление (F-10-040…045) ───────────

  private async assertNotLastOwner(tx: Tx, s: Staff) {
    if (s.role !== 'owner') return;
    const owners = await tx.staff.count({ where: { businessId: s.businessId, role: 'owner', status: { not: 'fired' }, deletedAt: null } });
    if (owners <= 1) throw new ApiError('last_owner', 'The last owner cannot leave');
  }

  /** Всё, что даёт вход этому сотруднику, гаснет сразу (F-00-040): логины администратора и их сессии */
  private async revokeAccess(tx: Tx, staffId: string) {
    const logins = await tx.staffLogin.findMany({ where: { staffId, disabledAt: null }, select: { id: true } });
    if (logins.length) await tx.staffLogin.updateMany({ where: { id: { in: logins.map((l) => l.id) } }, data: { disabledAt: new Date() } });
    return logins.map((l) => l.id);
  }

  /** C4: портфолио, дипломы, материалы уходят с мастером — копия в master_profiles человека */
  private async keepPortfolio(tx: Tx, s: Staff) {
    if (!s.userId) return;
    const photos = Array.isArray(s.photos) ? s.photos : [];
    const materials = Array.isArray(s.materials) ? s.materials : [];
    if (!photos.length && !materials.length) return;
    await tx.masterProfile.upsert({
      where: { userId: s.userId },
      create: { userId: s.userId, photos, materials, diplomas: [] },
      update: { photos, materials, version: { increment: 1 } },
    });
  }

  async dismiss(ctx: RequestContext, businessId: string, staffId: string, input: { date: string; reason: string }) {
    let revoked: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null } });
      if (!s) throw new ApiError('not_found', 'Staff not found');
      await this.assertNotLastOwner(tx, s);
      await tx.staff.update({
        where: { id: staffId },
        data: { status: 'fired', firedOn: input.date, fireReason: input.reason || null, firedAt: new Date(), updatedBy: ctx.member!.staffId, version: { increment: 1 } },
      });
      revoked = await this.revokeAccess(tx, staffId);
      await this.keepPortfolio(tx, s);
      await tx.staffInvite.updateMany({ where: { staffId, status: 'pending' }, data: { status: 'revoked' } });
      await this.audit.record(tx, ctx, { action: 'fired', entityType: 'staff', entityId: staffId, businessId, before: { status: s.status }, after: { status: 'fired', date: input.date, reason: input.reason } });
    });
    for (const id of revoked) await this.sessions.revokeAllOfStaffLogin(id, 'disabled');
    await this.publish(businessId, staffId);
    return this.get(businessId, staffId);
  }

  async dismissal(businessId: string, staffId: string) {
    const s = await this.find(businessId, staffId);
    if (s.status !== 'fired' || !s.firedAt) return null;
    return { staffId, date: s.firedOn ?? utcToLocalDate(s.firedAt), reason: s.fireReason ?? '', firedAt: utcToLocal(s.firedAt), restore: restoreWindow(s.firedAt) };
  }

  async restore(ctx: RequestContext, businessId: string, staffId: string) {
    const s = await this.find(businessId, staffId);
    if (s.status !== 'fired') return this.get(businessId, staffId);
    if (s.firedAt && restoreWindow(s.firedAt) === 'blocked') throw new ApiError('restore_blocked', 'Restore blocked until 30 days after dismissal');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({
        where: { id: staffId },
        data: { status: 'active', firedOn: null, fireReason: null, firedAt: null, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
      });
      await tx.staffLogin.updateMany({ where: { staffId }, data: { disabledAt: null } });
      await this.audit.record(tx, ctx, { action: 'restored', entityType: 'staff', entityId: staffId, businessId });
    });
    await this.publish(businessId, staffId);
    return this.get(businessId, staffId);
  }

  /** Удалить (F-10-041, слово DELETE — на экране): мягко, клиенты и записи остаются бизнесу (C4) */
  async remove(ctx: RequestContext, businessId: string, staffId: string) {
    let revoked: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null } });
      if (!s) throw new ApiError('not_found', 'Staff not found');
      await this.assertNotLastOwner(tx, s);
      await tx.staff.update({ where: { id: staffId }, data: { deletedAt: new Date(), updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      revoked = await this.revokeAccess(tx, staffId);
      await this.keepPortfolio(tx, s);
      await tx.staffInvite.updateMany({ where: { staffId, status: 'pending' }, data: { status: 'revoked' } });
      await this.audit.record(tx, ctx, { action: 'deletedForever', entityType: 'staff', entityId: staffId, businessId, before: { name: s.name } });
    });
    for (const id of revoked) await this.sessions.revokeAllOfStaffLogin(id, 'disabled');
    await this.publish(businessId, staffId);
  }

  async listDeleted(businessId: string) {
    const rows = await this.prisma.staff.findMany({ where: { businessId, deletedAt: { not: null } }, include: STAFF_INCLUDE, orderBy: { deletedAt: 'desc' } });
    return rows.map((s) => ({ id: s.id, businessId, snapshot: staffViewWithLogin(s), access: accessView(s), deletedAt: utcToLocal(s.deletedAt!) }));
  }

  async undelete(ctx: RequestContext, businessId: string, staffId: string) {
    const s = await this.find(businessId, staffId, { withDeleted: true });
    if (!s.deletedAt) return this.get(businessId, staffId);
    if (restoreWindow(s.deletedAt) === 'blocked') throw new ApiError('restore_blocked', 'Restore blocked until 30 days after deletion');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: staffId }, data: { deletedAt: null, status: 'active', updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await tx.staffLogin.updateMany({ where: { staffId }, data: { disabledAt: null } });
      await this.audit.record(tx, ctx, { action: 'restoredFromDeleted', entityType: 'staff', entityId: staffId, businessId });
    });
    await this.publish(businessId, staffId);
    return this.get(businessId, staffId);
  }

  // ─────────── доступ (F-10-019, F-10-031, F-00-038…040) ───────────

  async access(businessId: string, staffId: string) {
    const s = await this.find(businessId, staffId);
    const invite = await this.prisma.staffInvite.findFirst({ where: { staffId, status: { notIn: ['revoked', 'declined', 'expired'] } }, orderBy: { sentAt: 'desc' } });
    return { access: accessView(s), invite: invite ? inviteView(invite) : undefined, staff: staffViewWithLogin(s) };
  }

  /** Тумблер «Предоставить доступ»: выключение закрывает вход сразу (F-00-040), карточка остаётся */
  async setAccessEnabled(ctx: RequestContext, businessId: string, staffId: string, enabled: boolean) {
    let revoked: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.staff.findFirst({ where: { id: staffId, businessId, deletedAt: null } });
      if (!s) throw new ApiError('not_found', 'Staff not found');
      if (s.role === 'owner') throw new ApiError('forbidden', 'Owner access cannot be turned off');
      const status = s.status === 'fired' ? 'fired' : enabled ? (s.userId || s.status === 'active' || s.status === 'disabled' ? 'active' : 'invited') : 'disabled';
      await tx.staff.update({ where: { id: staffId }, data: { accessEnabled: enabled, status, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      if (!enabled) revoked = await this.revokeAccess(tx, staffId);
      else await tx.staffLogin.updateMany({ where: { staffId }, data: { disabledAt: null } });
      await this.audit.record(tx, ctx, { action: enabled ? 'accessGranted' : 'accessRevoked', entityType: 'staff', entityId: staffId, businessId, before: { accessEnabled: s.accessEnabled }, after: { accessEnabled: enabled } });
    });
    for (const id of revoked) await this.sessions.revokeAllOfStaffLogin(id, 'disabled');
    await this.publish(businessId, staffId);
    return this.access(businessId, staffId);
  }

  async setAccessInfo(ctx: RequestContext, businessId: string, staffId: string, info: string) {
    await this.find(businessId, staffId);
    await this.prisma.staff.update({ where: { id: staffId }, data: { accessInfo: info.trim() || null, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    return this.access(businessId, staffId);
  }

  async setRoleTemplate(ctx: RequestContext, businessId: string, staffId: string, roleTemplateId: string) {
    const s = await this.find(businessId, staffId);
    if (s.role === 'owner' && roleTemplateId !== 'owner') throw new ApiError('forbidden', 'Owner role is changed by transfer');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: staffId }, data: { roleTemplateId, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'roleChanged', entityType: 'staff', entityId: staffId, businessId, before: { roleTemplateId: s.roleTemplateId }, after: { roleTemplateId } });
    });
    return this.access(businessId, staffId);
  }

  async setIpRestriction(ctx: RequestContext, businessId: string, staffId: string, r: { enabled: boolean; ranges: string[] }) {
    await this.find(businessId, staffId);
    if (r.enabled && r.ranges.some((x) => !isValidIpRange(x))) throw new ApiError('invalid_ip_range', 'Invalid IP range');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: staffId }, data: { ipRestriction: r, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'ipRestrictionChanged', entityType: 'staff', entityId: staffId, businessId, after: r });
    });
    return r;
  }

  /** Логин и пароль администратора от владельца (F-00-034, F-00-038): смена при первом входе */
  async setLogin(ctx: RequestContext, businessId: string, staffId: string, input: { login: string; password: string }) {
    const s = await this.find(businessId, staffId);
    if (s.role !== 'admin') throw new ApiError('forbidden', 'Only administrators log in with a password');
    const login = input.login.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(login)) throw new ApiError('invalid_field', 'Bad login', { login: 'invalid' });
    if (isWeakPassword(input.password, login)) throw new ApiError('weak_password', 'Password is too weak');
    const taken = await this.prisma.staffLogin.findUnique({ where: { login } });
    if (taken && taken.staffId !== staffId) throw new ApiError('login_taken', 'Login is taken');
    const passwordHash = await hashPassword(input.password);
    let revoked: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      let userId = s.userId;
      if (!userId) {
        // Администратор без телефона — всё равно человек (users), вход только логином
        userId = newId('user');
        await tx.user.create({ data: { id: userId, phone: null, name: s.name, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
        await tx.staff.update({ where: { id: staffId }, data: { userId } });
      }
      const existing = await tx.staffLogin.findFirst({ where: { staffId } });
      if (existing) {
        await tx.staffLogin.update({
          where: { id: existing.id },
          data: { login, passwordHash, mustChangePassword: true, failedAttempts: 0, lockedUntil: null, disabledAt: null, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
        });
        revoked = [existing.id];
      } else {
        await tx.staffLogin.create({ data: { id: newId('staffLogin'), login, passwordHash, userId, staffId, businessId, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      }
      await tx.staff.update({ where: { id: staffId }, data: { accessEnabled: true, status: s.status === 'fired' ? 'fired' : 'active', version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'loginIssued', entityType: 'staff', entityId: staffId, businessId, after: { login } });
    });
    for (const id of revoked) await this.sessions.revokeAllOfStaffLogin(id, 'password_changed');
    return this.access(businessId, staffId);
  }

  // ─────────── приглашения (F-00-042, F-10-020) ───────────

  private async createInvite(tx: Tx, ctx: RequestContext, businessId: string, staffId: string, role: 'admin' | 'master', phone: string | null, email: string | null) {
    const token = randomBytes(24).toString('base64url');
    await tx.staffInvite.updateMany({ where: { staffId, status: 'pending' }, data: { status: 'revoked' } });
    await tx.staffInvite.create({
      data: {
        id: newId('staffInvite'),
        businessId,
        staffId,
        role,
        phone,
        email,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * HOUR),
        createdBy: ctx.member!.staffId,
        updatedBy: ctx.member!.staffId,
      },
    });
    return token;
  }

  /**
   * Новая ссылка-приглашение. В базе только хэш токена, поэтому «Скопировать ссылку» и «Отправить ещё раз» выпускают
   * НОВЫЙ токен, а прежняя ссылка перестаёт работать — действует одна ссылка на сотрудника.
   */
  async reissueInvite(ctx: RequestContext, businessId: string, staffId: string) {
    const s = await this.find(businessId, staffId);
    if (s.userId && s.status === 'active') throw new ApiError('invite_used', 'Already joined');
    if (s.role === 'owner') throw new ApiError('forbidden', 'Owner is not invited');
    const token = await this.prisma.$transaction(async (tx) => {
      const t = await this.createInvite(tx, ctx, businessId, staffId, s.role === 'admin' ? 'admin' : 'master', s.phone || null, s.email);
      await this.audit.record(tx, ctx, { action: 'inviteSent', entityType: 'staff', entityId: staffId, businessId });
      return t;
    });
    const invite = await this.prisma.staffInvite.findFirstOrThrow({ where: { staffId, status: 'pending' }, orderBy: { sentAt: 'desc' } });
    return { invite: inviteView(invite), link: inviteUrl(token) };
  }

  async revokeInvite(ctx: RequestContext, businessId: string, staffId: string) {
    await this.find(businessId, staffId);
    const invite = await this.prisma.staffInvite.findFirst({ where: { staffId }, orderBy: { sentAt: 'desc' } });
    if (!invite) throw new ApiError('not_found', 'No invite');
    await this.prisma.$transaction(async (tx) => {
      await tx.staffInvite.update({ where: { id: invite.id }, data: { status: 'revoked', updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'inviteRevoked', entityType: 'staff', entityId: staffId, businessId });
    });
    return inviteView({ ...invite, status: 'revoked' });
  }

  // ─────────── перенос доступа (F-10-045) и владения (F-10-149) ───────────

  async transferAccess(ctx: RequestContext, businessId: string, input: { fromStaffId: string; toStaffId: string; deleteSource: boolean }) {
    const from = await this.find(businessId, input.fromStaffId);
    const to = await this.find(businessId, input.toStaffId);
    if (to.accessEnabled && (to.userId || to.logins.length)) throw new ApiError('has_access', 'Target already has access');
    if (from.role === 'owner') throw new ApiError('forbidden', 'Owner access is moved by transfer of ownership');
    await this.prisma.$transaction(async (tx) => {
      const userId = from.userId;
      await tx.staff.update({ where: { id: from.id }, data: { userId: null, accessEnabled: false, status: input.deleteSource ? from.status : 'disabled', version: { increment: 1 } } });
      await tx.staff.update({
        where: { id: to.id },
        data: {
          userId,
          accessEnabled: true,
          status: from.status === 'invited' ? 'invited' : 'active',
          roleTemplateId: from.roleTemplateId,
          permissions: (from.permissions ?? DbNull) as Prisma.InputJsonValue,
          rights: (from.rights ?? DbNull) as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      await tx.staffLogin.updateMany({ where: { staffId: from.id }, data: { staffId: to.id } });
      await tx.staffInvite.updateMany({ where: { staffId: from.id, status: 'pending' }, data: { staffId: to.id } });
      await this.audit.record(tx, ctx, { action: 'accessTransferred', entityType: 'staff', entityId: to.id, businessId, before: { from: from.id } });
    });
    if (input.deleteSource) await this.remove(ctx, businessId, from.id);
    await this.publish(businessId, to.id);
  }

  async transferOwnership(ctx: RequestContext, businessId: string, fromStaffId: string, toStaffId: string) {
    const member = ctx.member!;
    const from = await this.find(businessId, fromStaffId);
    const to = await this.find(businessId, toStaffId);
    if (from.role !== 'owner' || member.staffId !== fromStaffId) throw new ApiError('forbidden', 'Only the owner transfers ownership');
    if (to.status === 'fired') throw new ApiError('forbidden', 'Fired staff cannot own');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: to.id }, data: { role: 'owner', roleTemplateId: 'owner', accessEnabled: true, permissions: DbNull, version: { increment: 1 } } });
      await tx.staff.update({ where: { id: from.id }, data: { role: 'admin', roleTemplateId: 'admin', version: { increment: 1 } } });
      await tx.business.update({ where: { id: businessId }, data: { ownerStaffId: to.id, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'ownershipTransferred', entityType: 'staff', entityId: to.id, businessId, before: { ownerStaffId: from.id }, after: { ownerStaffId: to.id } });
    });
    await this.publish(businessId, to.id);
    await this.publish(businessId, from.id);
  }

  // ─────────── права (F-10-032, F-10-062…090, F-00-039) ───────────

  async rights(businessId: string, staffId: string) {
    const s = await this.find(businessId, staffId);
    return {
      fine: Array.isArray(s.rights) ? (s.rights as string[]) : null,
      coarse: Array.isArray(s.permissions) ? (s.permissions as string[]).filter(isPermission) : null,
      scopes: (s.rightScopes ?? {}) as Record<string, unknown>,
    };
  }

  /** Сохранение редактора: тонкий набор + грубые права (действуют со следующего запроса, 03 §2) */
  async setRights(ctx: RequestContext, businessId: string, staffId: string, input: { fine: string[]; coarse: string[] }) {
    const s = await this.find(businessId, staffId);
    if (s.role === 'owner') throw new ApiError('forbidden', 'Owner has all permissions');
    if (staffId === ctx.member!.staffId) throw new ApiError('forbidden', 'Own permissions are set by the owner');
    const coarse = input.coarse.filter(isPermission).filter((p) => p !== 'platform.access');
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: staffId }, data: { rights: input.fine, permissions: coarse, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, {
        action: 'rightsChanged',
        entityType: 'staffRights',
        entityId: staffId,
        businessId,
        before: { rights: s.rights ?? null, permissions: s.permissions ?? null },
        after: { rights: input.fine, permissions: coarse },
      });
    });
    return this.rights(businessId, staffId);
  }

  async setRightScopes(ctx: RequestContext, businessId: string, staffId: string, scopes: Record<string, unknown>) {
    await this.find(businessId, staffId);
    await this.prisma.staff.update({ where: { id: staffId }, data: { rightScopes: scopes as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
  }

  // ─────────── вкладки карточки: юр. данные, настройки, пуши мастера ───────────

  async getJson(businessId: string, staffId: string, field: 'legalInfo' | 'cardSettings' | 'pushPrefs') {
    const s = await this.find(businessId, staffId);
    return (s[field] ?? null) as Record<string, unknown> | null;
  }

  async setJson(ctx: RequestContext, businessId: string, staffId: string, field: 'legalInfo' | 'cardSettings' | 'pushPrefs', value: Record<string, unknown>) {
    const s = await this.find(businessId, staffId);
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({ where: { id: staffId }, data: { [field]: value as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      if (field === 'legalInfo') await this.audit.record(tx, ctx, { action: 'legalInfoUpdated', entityType: 'staff', entityId: staffId, businessId });
    });
    return { ...((s[field] as Record<string, unknown> | null) ?? {}), ...value };
  }

  // ─────────── должности (F-10-046…052) ───────────

  async positions(businessId: string) {
    const [list, staff] = await Promise.all([
      this.prisma.position.findMany({ where: { businessId }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.staff.findMany({ where: { businessId, deletedAt: null, status: { not: 'fired' } }, select: { name: true, position: true } }),
    ]);
    return list.map((p) => {
      const ru = (p.name as { ru?: string }).ru ?? '';
      const holders = staff.filter((s) => ((s.position as { ru?: string } | null)?.ru ?? '') === ru);
      return { ...positionView(p), staffCount: holders.length, staffNames: holders.map((s) => s.name) };
    });
  }

  async addPosition(ctx: RequestContext, businessId: string, input: { name: string; description?: string }) {
    const name = input.name.trim();
    if (!name) throw new ApiError('invalid_field', 'name required', { name: 'required' });
    const p = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.position.findFirst({ where: { businessId, nameNorm: norm(name) } });
      if (existing) return existing;
      const created = await this.ensurePosition(tx, ctx, businessId, name);
      if (input.description?.trim()) return tx.position.update({ where: { id: created.id }, data: { description: input.description.trim() } });
      return created;
    });
    return positionView(p);
  }

  /** Переименование переносится на назначенных сотрудников (имя должности хранится у сотрудника, как во фронте) */
  async renamePosition(ctx: RequestContext, businessId: string, positionId: string, input: { name: string; description?: string }) {
    const name = input.name.trim();
    if (!name) throw new ApiError('invalid_field', 'name required', { name: 'required' });
    const p = await this.prisma.position.findFirst({ where: { id: positionId, businessId } });
    if (!p) throw new ApiError('not_found', 'Position not found');
    const prev = (p.name as { ru?: string }).ru ?? '';
    await this.prisma.$transaction(async (tx) => {
      const nameJson = { ...(p.name as Record<string, string>), ru: name };
      await tx.position.update({
        where: { id: positionId },
        data: {
          name: nameJson,
          nameNorm: norm(name),
          ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
          updatedBy: ctx.member!.staffId,
          version: { increment: 1 },
        },
      });
      if (prev !== name) {
        const holders = await tx.staff.findMany({ where: { businessId }, select: { id: true, position: true } });
        for (const h of holders) {
          const pos = h.position as Record<string, string> | null;
          if (pos?.ru === prev) await tx.staff.update({ where: { id: h.id }, data: { position: { ...pos, ru: name }, positionId, version: { increment: 1 } } });
        }
      }
      await this.audit.record(tx, ctx, { action: 'update', entityType: 'staffPosition', entityId: positionId, businessId, before: { name: prev }, after: { name } });
    });
    return positionView(await this.prisma.position.findUniqueOrThrow({ where: { id: positionId } }));
  }

  async removePosition(ctx: RequestContext, businessId: string, positionId: string) {
    const p = await this.prisma.position.findFirst({ where: { id: positionId, businessId } });
    if (!p) throw new ApiError('not_found', 'Position not found');
    const ru = (p.name as { ru?: string }).ru ?? '';
    const holders = (await this.prisma.staff.findMany({ where: { businessId, deletedAt: null, status: { not: 'fired' } }, select: { name: true, position: true } })).filter(
      (s) => (s.position as { ru?: string } | null)?.ru === ru,
    );
    if (holders.length) throw new ApiError('in_use', holders.map((s) => s.name).join(', '));
    await this.prisma.$transaction(async (tx) => {
      await tx.position.delete({ where: { id: positionId } });
      await this.audit.record(tx, ctx, { action: 'removed', entityType: 'staffPosition', entityId: positionId, businessId, before: { name: ru } });
    });
  }
}

/** SQL NULL в JSON-колонке («нет поля» у экрана) */
const DbNull = Prisma.DbNull;
const JSON_COLUMNS = new Set(['specialty', 'bio', 'sphereIds', 'photos', 'materials', 'workplaces', 'visitDistricts', 'callHours', 'prepayment', 'bookingRules', 'contacts', 'serviceIds', 'position']);
function isJsonField(k: string) {
  return JSON_COLUMNS.has(k);
}

function auditFields(v: ReturnType<typeof staffViewWithLogin>): Record<string, unknown> {
  const { version: _v, ...rest } = v as Record<string, unknown>;
  return rest;
}

/** Ссылка-приглашение: экран принятия во фронте /biz/onboarding/invite/<token> (адрес сайта — из CORS_ORIGINS) */
export function inviteUrl(token: string): string {
  const origin = env.CORS_ORIGINS[0] ?? '';
  return `${origin}/biz/onboarding/invite/${token}`;
}

export function inviteTokenHash(token: string): string {
  return tokenHash(token);
}

function isValidIpRange(range: string): boolean {
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  const ipv6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
  if (ipv4.test(range)) return range.split('/')[0]!.split('.').every((n) => Number(n) <= 255);
  return ipv6.test(range) && range.includes(':');
}
