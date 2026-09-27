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
export const DEFAULT_JOURNAL_SETTINGS = {
    recordType: 'auto',
    defaultView: 'staff',
    defaultPositionId: 'all',
    defaultResourceId: 'all',
    showOccupiedResourcesForStaff: false,
    firstLineMode: 'clientName',
    waitlistEnabled: true,
    allowOverlapOverNoShow: true,
    defaultBreakAfterMin: 0,
    patronymicEnabled: false,
    chatIntegrationConnected: false,
    chatPopupEnabled: true,
    assistantPayEnabled: false,
    loyaltySearchEnabled: false,
    hourFormat: '24',
    timeZoneCity: 'Ереван',
    deletionRestoreWindowDays: 7,
};
/** Четыре системные категории записи (F-01-051) — те же, что сид среза journal фронта; id постоянные */
export const SYSTEM_BOOKING_CATEGORIES = [
    { id: 'bc_sys_full_online', labelKey: 'fullOnlinePayment', colorIndex: 3, system: true },
    { id: 'bc_sys_part_online', labelKey: 'partialOnlinePayment', colorIndex: 7, system: true },
    { id: 'bc_sys_important', labelKey: 'staffImportant', colorIndex: 1, system: true },
    { id: 'bc_sys_not_important', labelKey: 'staffNotImportant', colorIndex: 5, system: true },
];
export function defaultJournalArea() {
    return {
        settings: { ...DEFAULT_JOURNAL_SETTINGS },
        visitIntervalMin: 15,
        bookingCategories: SYSTEM_BOOKING_CATEGORIES.map((c) => ({ ...c })),
        customFieldDefs: [],
        recurrenceTemplates: [],
        staffJournalRights: {},
        staffWindowRights: {},
        staffMarkupMin: {},
        breakCombineMode: 'longest',
        splitByResourceEnabled: false,
        autoWriteoffServiceIds: [],
        hotDiscountPct: {},
    };
}
const AREA = 'journal';
let JournalSettingsService = class JournalSettingsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async get(businessId, db = this.prisma) {
        const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
        const data = (row?.data ?? {});
        const base = defaultJournalArea();
        return {
            ...base,
            ...data,
            settings: { ...base.settings, ...(data.settings ?? {}) },
            bookingCategories: data.bookingCategories?.length ? data.bookingCategories : base.bookingCategories,
        };
    }
    async update(businessId, recipe, updatedBy, db = this.prisma) {
        const area = await this.get(businessId, db);
        recipe(area);
        await db.businessSetting.upsert({
            where: { businessId_area: { businessId, area: AREA } },
            create: { businessId, area: AREA, data: area, updatedBy },
            update: { data: area, updatedBy, version: { increment: 1 } },
        });
        return area;
    }
};
JournalSettingsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [PrismaService])
], JournalSettingsService);
export { JournalSettingsService };
//# sourceMappingURL=journal-settings.js.map