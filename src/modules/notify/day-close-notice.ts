import { Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { moneyToJson } from '../../common/money/money.js';
import type { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, localDayRangeUtc, utcToLocal } from '../../common/time/time.js';
import { dayMoneyOf } from '../workday/day-money.js';

/**
 * ⭐ «День закрыт» — уведомление владельцу в колокольчик кабинета (владелец, 01.10.2026). То же, что мок фронта
 * (src/api/notify-dayclose.ts, правила снимка — src/domain/journalWorkday.ts):
 *  · закрытие кассовой смены (CashShiftsService.close) пишет снимок итога дня: выручка («Оказано услуг» — визиты
 *    «Пришёл» дня), наличные за день, излишек/недостача (сумма по сменам, закрытым в этот день), кто закрыл;
 *  · один снимок на бизнес и день (BusinessSetting area 'notify-day-close', без миграции): тот же отпечаток — ничего
 *    не меняется (повторное закрытие не дублирует), другой — заменяет снимок, строка снова «не прочитана»;
 *  · получатели — владельцы бизнеса (role/roleTemplateId 'owner', Business.ownerStaffId, владелец сети) кроме закрывшего;
 *  · лента колокольчика (NotifyInboxService) показывает снимок только получателю, id строки — свой у каждого
 *    (прочитанное общее на бизнес, bizInboxRead, а строки — личные). Галочка «Закрытие дня» (web-popup dayClose) гасит.
 */

const AREA = 'notify-day-close';
const KEEP = 30;

export interface DayCloseNoticeRow {
  date: string;
  /** Местное время закрытия 'YYYY-MM-DDTHH:mm' */
  at: string;
  /** Момент закрытия ISO UTC — время строки ленты, как createdAt событий записей */
  createdAt: string;
  closedBy: string;
  closedByName: string;
  revenue: number;
  cash: number;
  discrepancy: number;
  recipientStaffIds: string[];
  recipientUserIds: string[];
  fingerprint: string;
}

export interface DayCloseInboxEvent {
  id: string;
  createdAt: string;
  date: string;
  kind: 'dayClosed';
  dayClose: { closedByName: string; revenue: number; cash: number; discrepancy: number };
}

/** FNV-1a 32 бита в base36 — как shortHash фронта (id строки ≤ 32 символов: inboxReadBody, biz_inbox_read.event_id) */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function dayCloseFingerprint(n: Pick<DayCloseNoticeRow, 'closedBy' | 'revenue' | 'cash' | 'discrepancy'>): string {
  return shortHash(`${n.closedBy}|${n.revenue}|${n.cash}|${n.discrepancy}`);
}

export function dayCloseInboxId(n: Pick<DayCloseNoticeRow, 'date' | 'fingerprint'>, viewerStaffId: string): string {
  return `dc_${n.date.replace(/-/g, '')}_${shortHash(`${n.fingerprint}|${viewerStaffId}`)}`;
}

const sameList = (a: string[], b: string[]) => a.join(',') === b.join(',');

/** Тот же день с тем же отпечатком и получателями — без изменений; иначе снимок дня заменяется (последние KEEP дней) */
export function upsertDayCloseNotice(list: DayCloseNoticeRow[], next: DayCloseNoticeRow): { list: DayCloseNoticeRow[]; changed: boolean } {
  const prev = list.find((n) => n.date === next.date);
  if (prev && prev.fingerprint === next.fingerprint && sameList(prev.recipientStaffIds, next.recipientStaffIds) && sameList(prev.recipientUserIds, next.recipientUserIds)) {
    return { list, changed: false };
  }
  const out = [...list.filter((n) => n.date !== next.date), next].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, KEEP);
  return { list: out, changed: true };
}

async function readNotices(prisma: PrismaService, businessId: string): Promise<DayCloseNoticeRow[]> {
  const row = await prisma.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
  const data = row?.data as { notices?: DayCloseNoticeRow[] } | null;
  return Array.isArray(data?.notices) ? data.notices : [];
}

async function tzOf(prisma: PrismaService, businessId: string): Promise<string> {
  const loc = await prisma.location.findFirst({ where: { businessId, deletedAt: null }, orderBy: { sortOrder: 'asc' }, select: { tz: true } });
  return loc?.tz ?? DEFAULT_TZ;
}

/** Кому приходит: владельцы бизнеса и сети, роль-шаблон «Владелец» — кроме закрывшего (и его же входа) */
async function recipientsOf(prisma: PrismaService, businessId: string, closedBy: string): Promise<{ staffIds: string[]; userIds: string[] }> {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { ownerStaffId: true, networkId: true } });
  const network = business?.networkId ? await prisma.network.findUnique({ where: { id: business.networkId }, select: { ownerUserId: true, ownerStaffId: true } }) : null;
  const owners = await prisma.staff.findMany({
    where: {
      businessId,
      status: { notIn: ['fired', 'disabled'] },
      OR: [{ role: 'owner' }, { roleTemplateId: 'owner' }, ...(business?.ownerStaffId ? [{ id: business.ownerStaffId }] : [])],
    },
    select: { id: true, userId: true },
  });
  const closer = await prisma.staff.findUnique({ where: { id: closedBy }, select: { userId: true } });
  const staffIds = new Set(owners.map((s) => s.id));
  const userIds = new Set(owners.map((s) => s.userId).filter((u): u is string => Boolean(u)));
  if (network?.ownerStaffId) staffIds.add(network.ownerStaffId);
  if (network?.ownerUserId) userIds.add(network.ownerUserId);
  staffIds.delete(closedBy);
  if (closer?.userId) userIds.delete(closer.userId);
  return { staffIds: [...staffIds].sort(), userIds: [...userIds].sort() };
}

/** Снимок итога дня после закрытия смены. Ошибка не роняет закрытие — только в лог. */
export async function recordDayCloseNotice(prisma: PrismaService, businessId: string, closedBy: string, closedAt: Date): Promise<void> {
  try {
    const recipients = await recipientsOf(prisma, businessId, closedBy);
    if (!recipients.staffIds.length && !recipients.userIds.length) return;
    const tz = await tzOf(prisma, businessId);
    const at = utcToLocal(closedAt, tz);
    const date = at.slice(0, 10);
    const day = localDayRangeUtc(date, tz);
    const money = await dayMoneyOf(prisma, businessId, day);
    const arrived = await prisma.booking.aggregate({
      where: { businessId, deletedAt: null, groupEventId: null, status: 'arrived', startAt: { gte: day.from, lt: day.to } },
      _sum: { total: true },
    });
    const shifts = await prisma.cashShift.findMany({
      where: { businessId, status: 'closed', closedAt: { gte: day.from, lt: day.to } },
      select: { countedCash: true, expectedAtClose: true },
    });
    const discrepancy = shifts.reduce((s, sh) => (sh.countedCash !== null && sh.expectedAtClose !== null ? s + (sh.countedCash - sh.expectedAtClose) : s), 0n);
    const closer = await prisma.staff.findUnique({ where: { id: closedBy }, select: { name: true } });
    const base = { closedBy, revenue: moneyToJson(arrived._sum.total ?? 0n), cash: moneyToJson(money.cash), discrepancy: moneyToJson(discrepancy) };
    const notice: DayCloseNoticeRow = {
      date,
      at,
      createdAt: closedAt.toISOString(),
      closedByName: closer?.name.trim().split(/\s+/)[0] ?? '',
      recipientStaffIds: recipients.staffIds,
      recipientUserIds: recipients.userIds,
      fingerprint: dayCloseFingerprint(base),
      ...base,
    };
    const { list, changed } = upsertDayCloseNotice(await readNotices(prisma, businessId), notice);
    if (!changed) return;
    const data = { notices: list } as unknown as Prisma.InputJsonValue;
    await prisma.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA } },
      create: { businessId, area: AREA, data, updatedBy: closedBy },
      update: { data, updatedBy: closedBy, version: { increment: 1 } },
    });
  } catch (e) {
    new Logger('DayCloseNotice').warn(`day-close notice for ${businessId} failed: ${(e as Error).message}`);
  }
}

/** Строки «День закрыт» ленты колокольчика этого сотрудника (по staffId или по входу — владелец сети в чужом филиале) */
export async function dayCloseInboxEvents(prisma: PrismaService, businessId: string, viewer: { staffId: string; userId: string }): Promise<DayCloseInboxEvent[]> {
  const notices = await readNotices(prisma, businessId);
  return notices
    .filter((n) => n.recipientStaffIds.includes(viewer.staffId) || (viewer.userId && n.recipientUserIds.includes(viewer.userId)))
    .map((n) => ({
      id: dayCloseInboxId(n, viewer.staffId),
      createdAt: n.createdAt,
      date: n.date,
      kind: 'dayClosed' as const,
      dayClose: { closedByName: n.closedByName, revenue: n.revenue, cash: n.cash, discrepancy: n.discrepancy },
    }));
}
