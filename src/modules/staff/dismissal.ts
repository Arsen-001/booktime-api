import type { Prisma, Staff } from '../../generated/prisma/client.js';
import type { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { nowLocal } from '../../common/time/time.js';

type Tx = Prisma.TransactionClient;

/**
 * Увольнение (F-10-040, С3). Дата сегодня или раньше — сразу; дата в будущем — запланировано: до неё сотрудник работает
 * и остаётся в графике (status не меняется, firedOn = дата, firedAt = null), в этот день увольнение вступает в силу —
 * задача воркера `staff.dismissals` (как applyDueDismissals мока сайта, src/api/staff.ts).
 */

/** Сегодня по Еревану, 'YYYY-MM-DD' */
export const todayLocal = () => nowLocal().slice(0, 10);

/** Запланированное увольнение: дата есть, в силу ещё не вступило */
export function isScheduledDismissal(s: Pick<Staff, 'status' | 'firedOn' | 'firedAt'>): boolean {
  return s.status !== 'fired' && !!s.firedOn && !s.firedAt;
}

export async function assertNotLastOwner(tx: Tx, s: Pick<Staff, 'id' | 'role' | 'businessId'>): Promise<void> {
  if (s.role !== 'owner') return;
  const owners = await tx.staff.count({ where: { businessId: s.businessId, role: 'owner', status: { not: 'fired' }, deletedAt: null } });
  if (owners <= 1) throw new ApiError('last_owner', 'The last owner cannot leave');
}

/** Всё, что даёт вход этому сотруднику, гаснет сразу (F-00-040): логины администратора; сессии гасит вызывающий */
export async function revokeLogins(tx: Tx, staffId: string): Promise<string[]> {
  const logins = await tx.staffLogin.findMany({ where: { staffId, disabledAt: null }, select: { id: true } });
  if (logins.length) await tx.staffLogin.updateMany({ where: { id: { in: logins.map((l) => l.id) } }, data: { disabledAt: new Date() } });
  return logins.map((l) => l.id);
}

/** C4: портфолио, дипломы, материалы уходят с мастером — копия в master_profiles человека */
export async function keepPortfolio(tx: Tx, s: Staff): Promise<void> {
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

/**
 * Увольнение вступает в силу (внутри транзакции): статус «уволен», логины гаснут, портфолио уходит с мастером,
 * приглашения отзываются, событие в журнал. Возвращает id погашенных логинов — их сессии гасит вызывающий.
 */
export async function fireNowTx(
  tx: Tx,
  audit: AuditService,
  ctx: RequestContext | null,
  s: Staff,
  input: { date: string; reason: string },
): Promise<string[]> {
  await assertNotLastOwner(tx, s);
  await tx.staff.update({
    where: { id: s.id },
    data: { status: 'fired', firedOn: input.date, fireReason: input.reason || null, firedAt: new Date(), updatedBy: ctx?.member?.staffId ?? null, version: { increment: 1 } },
  });
  const revoked = await revokeLogins(tx, s.id);
  await keepPortfolio(tx, s);
  await tx.staffInvite.updateMany({ where: { staffId: s.id, status: 'pending' }, data: { status: 'revoked' } });
  await audit.record(tx, ctx, {
    action: 'fired',
    entityType: 'staff',
    entityId: s.id,
    businessId: s.businessId,
    before: { status: s.status },
    after: { status: 'fired', date: input.date, reason: input.reason },
  });
  return revoked;
}

interface DueDb {
  staff: { findMany(args: { where: Prisma.StaffWhereInput }): Promise<Staff[]> };
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Запланированные увольнения, чей день настал (firedOn ≤ сегодня), вступают в силу. Последнего владельца не увольняем —
 * пропуск (в журнал воркера). Сессии погашенных логинов закрываются в той же транзакции.
 */
export async function applyDueDismissals(db: DueDb, audit: AuditService, today: string = todayLocal()): Promise<{ fired: string[]; skipped: string[] }> {
  const due = await db.staff.findMany({ where: { deletedAt: null, status: { not: 'fired' }, firedAt: null, firedOn: { not: null, lte: today } } });
  const fired: string[] = [];
  const skipped: string[] = [];
  for (const s of due) {
    try {
      await db.$transaction(async (tx) => {
        const revoked = await fireNowTx(tx, audit, null, s, { date: s.firedOn!, reason: s.fireReason ?? '' });
        if (revoked.length) {
          await tx.session.updateMany({ where: { staffLoginId: { in: revoked }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'disabled' } });
        }
      });
      fired.push(s.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'last_owner') skipped.push(s.id);
      else throw e;
    }
  }
  return { fired, skipped };
}
