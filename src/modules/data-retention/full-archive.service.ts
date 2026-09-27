import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Все модели схемы (prisma/schema.prisma) со своей колонкой `business_id` — «все таблицы с его business_id»
 * из docs/backend/06 §6 (F-00-183, «выгрузить один бизнес целиком … в архив по запросу»). Список собран
 * `awk '/^model /{name=$2} /businessId\s+String/{print name}'` по схеме на момент этапа 20; новая таблица
 * с business_id, заведённая позже, сюда не попадёт автоматически — дописать при следующей ревизии архива.
 *
 * Осознанно исключены (секреты/токены, не «данные о бизнесе», а ключи к чужим системам):
 * ApiKey (секрет партнёра/токен), StaffLogin (хэш пароля), SavedCard (токен карты), WebhookAddress (HMAC-секрет).
 */
const ARCHIVE_MODELS = [
  'AuditEvent', 'BackupCopy', 'BillingInvoice', 'BizInboxRead', 'BizMeta', 'BizRequest', 'BonusPenaltyType',
  'Booking', 'BookingEvent', 'BookingHistory', 'BookingLink', 'BookingPayment', 'BookingSeries',
  'BusinessSetting', 'BusyBlock', 'CalendarMark', 'CallbackRequest', 'CashRegister', 'Certificate',
  'CertificateType', 'Client', 'ClientAccount', 'ClientAccountType', 'ClientCategory', 'ClientColumnsPref',
  'ClientFineRights', 'ClientImportRun', 'CoinEntry', 'CoinWallet', 'DataExport', 'Equipment',
  'FinCounterparty', 'FinOp', 'FinanceDocument', 'FreePeriodGrant', 'FreedSlot', 'GroupEvent', 'Idea',
  'InboxItem', 'IntegrationConnection', 'Inventory', 'Location', 'LoyaltyCard', 'LoyaltyCardType', 'LoyaltyTx',
  'MedicalCard', 'MedicalVisitNote', 'MembershipSale', 'MembershipType', 'ModerationItem', 'NetworkPlanCell',
  'NewsPost', 'NewsQuota', 'NotifyOutbox', 'OnlineSlotRuleSet', 'PackageGroup', 'PaymentItem', 'PaymentMethod',
  'PayrollChart', 'PayrollChartAssignment', 'PayrollCriterion', 'PayrollRule', 'PayrollScheme',
  'PayrollSettings', 'PayrollSettlementEntry', 'PayrollStatementApproval', 'Position', 'Product',
  'PromoRedemption', 'Promotion', 'ReportExport', 'Resource', 'ResourceBusy', 'SalesVisit', 'ScheduleDay',
  'ScheduleHistory', 'ScheduleTemplate', 'Service', 'ServiceCategory', 'SettingsChangeLog', 'SlotClaim',
  'SphereRequest', 'Staff', 'StaffDayType', 'StaffInvite', 'StockCategory', 'StockOp', 'StockOpLine',
  'StockReminder', 'StockSettings', 'Subscription', 'SubscriptionCharge', 'TechCard', 'TreatmentPlan',
  'WaitlistEntry', 'Warehouse', 'WebhookDelivery', 'WorkSchedule',
] as const;

const toModelKey = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

type PrismaModelDelegate = { findMany: (args: { where: { businessId: string } }) => Promise<Record<string, unknown>[]> };

/** Деньги — BIGINT в базе (PLAN §4.1); JSON.stringify не умеет сериализовать bigint — переводим в number сами */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

/** Наша панель: полный архив одного бизнеса «по запросу» (F-00-183, 06 §6) — не для повседневной выгрузки. */
@Injectable()
export class FullArchiveService {
  constructor(private readonly prisma: PrismaService) {}

  async build(businessId: string, authorId: string, authorName: string) {
    const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } });
    if (!biz) throw new ApiError('not_found', 'Business not found');
    const tables: Record<string, Record<string, unknown>[]> = {};
    let rows = 0;
    for (const model of ARCHIVE_MODELS) {
      const delegate = (this.prisma as unknown as Record<string, PrismaModelDelegate>)[toModelKey(model)];
      if (!delegate) throw new Error(`Unknown Prisma model in ARCHIVE_MODELS: ${model}`);
      const found = await delegate.findMany({ where: { businessId } });
      if (found.length) tables[model] = found.map((row) => jsonSafe(row) as Record<string, unknown>);
      rows += found.length;
    }
    await this.prisma.dataExport.create({ data: { id: newId('dataExport'), businessId, area: 'full-archive', authorId, authorName, count: rows, fileName: `archive-${businessId}.json` } });
    return { businessId, businessName: biz.name, generatedAt: new Date().toISOString(), tables };
  }
}
