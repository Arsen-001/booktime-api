import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';

/** Событие, о котором сотрудник может получать пуш (05 §3.2) — свой, узкий набор, см. kinds.ts докстринг */
export const STAFF_NOTIFY_EVENTS = ['new_booking', 'client_cancelled', 'client_rescheduled', 'empty_week'] as const;
export type StaffNotifyEvent = (typeof STAFF_NOTIFY_EVENTS)[number];
export type StaffNotifyEvents = Record<StaffNotifyEvent, boolean>;

const DEFAULT_EVENTS: StaffNotifyEvents = { new_booking: true, client_cancelled: true, client_rescheduled: true, empty_week: true };

/** Что приходит сотруднику (F-05-055…060) — по умолчанию всё включено, владелец/сам сотрудник может выключить */
@Injectable()
export class NotifyStaffPrefsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(staffId: string): Promise<StaffNotifyEvents> {
    const row = await this.prisma.staffNotifyPref.findUnique({ where: { staffId } });
    return { ...DEFAULT_EVENTS, ...((row?.events as Partial<StaffNotifyEvents>) ?? {}) };
  }

  async update(staffId: string, patch: Partial<StaffNotifyEvents>): Promise<StaffNotifyEvents> {
    const current = await this.get(staffId);
    const next = { ...current, ...patch };
    await this.prisma.staffNotifyPref.upsert({
      where: { staffId },
      create: { staffId, events: next as Prisma.InputJsonValue },
      update: { events: next as Prisma.InputJsonValue },
    });
    return next;
  }
}

/** Без DI — читает напрямую (нужно из bookings.service.ts, чтобы не тащить туда весь модуль notify) */
export async function isStaffEventEnabled(prisma: PrismaService, staffId: string, event: StaffNotifyEvent): Promise<boolean> {
  const row = await prisma.staffNotifyPref.findUnique({ where: { staffId }, select: { events: true } });
  const events = row?.events as Partial<StaffNotifyEvents> | undefined;
  return events?.[event] ?? DEFAULT_EVENTS[event];
}
