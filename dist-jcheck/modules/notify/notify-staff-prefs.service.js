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
import { PrismaService } from '../../common/prisma.service.js';
/** Событие, о котором сотрудник может получать пуш (05 §3.2) — свой, узкий набор, см. kinds.ts докстринг */
export const STAFF_NOTIFY_EVENTS = ['new_booking', 'client_cancelled', 'client_rescheduled', 'empty_week'];
const DEFAULT_EVENTS = { new_booking: true, client_cancelled: true, client_rescheduled: true, empty_week: true };
/** Что приходит сотруднику (F-05-055…060) — по умолчанию всё включено, владелец/сам сотрудник может выключить */
let NotifyStaffPrefsService = class NotifyStaffPrefsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async get(staffId) {
        const row = await this.prisma.staffNotifyPref.findUnique({ where: { staffId } });
        return { ...DEFAULT_EVENTS, ...(row?.events ?? {}) };
    }
    async update(staffId, patch) {
        const current = await this.get(staffId);
        const next = { ...current, ...patch };
        await this.prisma.staffNotifyPref.upsert({
            where: { staffId },
            create: { staffId, events: next },
            update: { events: next },
        });
        return next;
    }
};
NotifyStaffPrefsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], NotifyStaffPrefsService);
export { NotifyStaffPrefsService };
/** Без DI — читает напрямую (нужно из bookings.service.ts, чтобы не тащить туда весь модуль notify) */
export async function isStaffEventEnabled(prisma, staffId, event) {
    const row = await prisma.staffNotifyPref.findUnique({ where: { staffId }, select: { events: true } });
    const events = row?.events;
    return events?.[event] ?? DEFAULT_EVENTS[event];
}
//# sourceMappingURL=notify-staff-prefs.service.js.map