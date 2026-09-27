import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

/** «Цифровой журнал» (F-01-155, F-01-165…180) — DEFAULT_JOURNAL_SETTINGS фронта (src/domain/journal.ts) */
export interface JournalSettings {
  recordType: 'auto' | 'individual' | 'mixed' | 'group';
  defaultView: 'staff' | 'resource';
  defaultPositionId: string;
  defaultResourceId: string;
  showOccupiedResourcesForStaff: boolean;
  firstLineMode: 'service' | 'clientName' | 'phone';
  waitlistEnabled: boolean;
  /** F-01-173: «Не пришёл» не блокирует новую запись на то же время */
  allowOverlapOverNoShow: boolean;
  defaultBreakAfterMin: number;
  patronymicEnabled: boolean;
  chatIntegrationConnected: boolean;
  chatPopupEnabled: boolean;
  assistantPayEnabled: boolean;
  loyaltySearchEnabled: boolean;
  hourFormat: '24' | '12';
  /** F-01-121: сколько дней удалённую запись можно вернуть (решение владельца — 7) */
  deletionRestoreWindowDays: number;
  timeZoneCity: string;
}

export const DEFAULT_JOURNAL_SETTINGS: JournalSettings = {
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

export interface BookingCategoryDef {
  id: string;
  name?: string;
  labelKey?: string;
  colorIndex: number;
  system: boolean;
}

/** Четыре системные категории записи (F-01-051) — те же, что сид среза journal фронта; id постоянные */
export const SYSTEM_BOOKING_CATEGORIES: BookingCategoryDef[] = [
  { id: 'bc_sys_full_online', labelKey: 'fullOnlinePayment', colorIndex: 3, system: true },
  { id: 'bc_sys_part_online', labelKey: 'partialOnlinePayment', colorIndex: 7, system: true },
  { id: 'bc_sys_important', labelKey: 'staffImportant', colorIndex: 1, system: true },
  { id: 'bc_sys_not_important', labelKey: 'staffNotImportant', colorIndex: 5, system: true },
];

/** Всё, что раздел «журнал» хранит на бизнес: business_settings(area='journal'), F4 */
export interface JournalArea {
  settings: JournalSettings;
  /** F-01-041/172: интервал склейки записей клиента в визит; 0 — каждая отдельно, 1440 — весь день */
  visitIntervalMin: number;
  bookingCategories: BookingCategoryDef[];
  customFieldDefs: Record<string, unknown>[];
  recurrenceTemplates: { id: string; name: string; rule: unknown }[];
  staffJournalRights: Record<string, unknown>;
  staffWindowRights: Record<string, unknown>;
  /** Разметка сетки сотрудника (F-01-021), 0 — «не выбрано» */
  staffMarkupMin: Record<string, number>;
  breakCombineMode: 'longest' | 'sum';
  splitByResourceEnabled: boolean;
  /** Услуги с автосписанием абонемента (F-01-080) — до раздела «Лояльность» (этап 11) */
  autoWriteoffServiceIds: string[];
  /** В-18: скидка «горящего» окна мастера, % (по умолчанию 0) */
  hotDiscountPct: Record<string, number>;
  // === stage 21 (lane rest) ===
  /** Шаг сетки журнала, минут — общий на локацию (F-01-015): 5 | 10 | 15 */
  zoomMin: number;
  /** Статусы, скрытые фильтром воронки (F-01-014) — только индивидуальные записи */
  hiddenStatuses: string[];
  // === /stage 21 ===
}

export function defaultJournalArea(): JournalArea {
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
    zoomMin: 15,
    hiddenStatuses: [],
  };
}

const AREA = 'journal';

@Injectable()
export class JournalSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(businessId: string, db: Db = this.prisma): Promise<JournalArea> {
    const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: AREA } } });
    const data = (row?.data ?? {}) as Partial<JournalArea>;
    const base = defaultJournalArea();
    return {
      ...base,
      ...data,
      settings: { ...base.settings, ...(data.settings ?? {}) },
      bookingCategories: data.bookingCategories?.length ? data.bookingCategories : base.bookingCategories,
    };
  }

  async update(businessId: string, recipe: (area: JournalArea) => void, updatedBy: string | null, db: Db = this.prisma): Promise<JournalArea> {
    const area = await this.get(businessId, db);
    recipe(area);
    await db.businessSetting.upsert({
      where: { businessId_area: { businessId, area: AREA } },
      create: { businessId, area: AREA, data: area as unknown as Prisma.InputJsonValue, updatedBy },
      update: { data: area as unknown as Prisma.InputJsonValue, updatedBy, version: { increment: 1 } },
    });
    return area;
  }
}
