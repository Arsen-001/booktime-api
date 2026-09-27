import { z } from 'zod';

export const payoutValueBody = z.object({ unit: z.enum(['percent', 'amount']), value: z.number().min(0).max(1_000_000) });

export const payoutOverrideBody = z.object({ targetType: z.enum(['category', 'item']), targetId: z.string().min(1), payout: payoutValueBody });

export const consumablesSettingsBody = z.object({ mode: z.enum(['off', 'full', 'proportional']), applyClientDiscount: z.boolean() });

export const loyaltyAdjustmentBody = z.object({
  enabled: z.boolean(),
  includeDiscount: z.boolean(),
  includeBonus: z.boolean(),
  includeMembership: z.boolean(),
  includeClientAccount: z.boolean(),
  includeCertificate: z.boolean(),
  includePromotion: z.boolean(),
  promoPayout: payoutValueBody,
  promoOverrides: z.array(z.object({ promotionId: z.string(), payout: payoutValueBody })),
});

export const groupEventsBody = z.object({
  enabled: z.boolean(),
  minPayoutOn: z.boolean(),
  minPayout: payoutValueBody,
  atLeastOneOn: z.boolean(),
  atLeastOnePayout: payoutValueBody,
  perAttendeeMode: z.enum(['none', 'each', 'aboveThreshold']),
  threshold: z.number().min(0),
});

export const personalServicesBlockBody = z.object({
  enabled: z.boolean(),
  defaultPayout: payoutValueBody,
  overrides: z.array(payoutOverrideBody),
  demoConsumablesPercent: z.number().min(0).max(100).optional(),
  consumables: consumablesSettingsBody,
  loyaltyAdjustment: loyaltyAdjustmentBody,
  groupEvents: groupEventsBody,
});

export const productSalesBlockBody = z.object({
  enabled: z.boolean(),
  defaultPayout: payoutValueBody,
  overrides: z.array(payoutOverrideBody),
  demoCostPercent: z.number().min(0).max(100).optional(),
  costBasis: z.object({ enabled: z.boolean(), order: z.enum(['discountFirst', 'costFirst']) }),
  loyaltyAdjustment: loyaltyAdjustmentBody,
});

export const workdayBlockBody = z.object({
  enabled: z.boolean(),
  baseAmount: z.number().min(0),
  basePeriod: z.enum(['hour', 'day', 'month']),
  guaranteedMinimum: z.object({ enabled: z.boolean(), amount: z.number().min(0), period: z.enum(['month', 'day']) }),
});

export const recordsBlockBody = z.object({
  enabled: z.boolean(),
  perServicePayout: payoutValueBody,
  perServiceOverrides: z.array(payoutOverrideBody),
  onlineWidgetEnabled: z.boolean(),
  onlineWidgetPayout: payoutValueBody,
});

export const extraRevenueBlockBody = z.object({ enabled: z.boolean(), percent: z.number().min(0).max(100), base: z.enum(['turnover', 'profit']) });

/** Общие шесть блоков — форма PayrollScheme мока (staffId/createdAt/updatedAt — колонки строки, не тело) */
export const schemeBlocksBody = z.object({
  personalServices: personalServicesBlockBody,
  productSales: productSalesBlockBody,
  workday: workdayBlockBody,
  records: recordsBlockBody,
  extraServiceRevenue: extraRevenueBlockBody,
  extraProductRevenue: extraRevenueBlockBody,
});
export type SchemeBlocksBody = z.infer<typeof schemeBlocksBody>;

export const generalSettingsBody = z.object({
  accrualDateBasis: z.enum(['visit', 'received']),
  bankCommissionSplit: z.enum(['staffAssistBusiness', 'staffBusiness', 'staffAssist', 'staffOnly', 'businessOnly']),
  assistCompensationEnabled: z.boolean(),
  multipleAssistantsAllowed: z.boolean(),
  assistantSplitRule: z.enum(['fullEach', 'shared']),
  payrollModel: z.enum(['simplified', 'classic']),
  statementApprovalEnabled: z.boolean(),
  payrollFundTargetPct: z.number().min(0).max(100),
  payrollFundWarnPct: z.number().min(0).max(100),
});
export type GeneralSettingsBody = z.infer<typeof generalSettingsBody>;

export const ruleBody = z.object({ name: z.string().min(1).max(120) }).extend({
  ...schemeBlocksBody.shape,
  serviceCostBasis: z.object({ enabled: z.boolean(), order: z.enum(['discountFirst', 'costFirst']) }),
});
export type RuleBody = z.infer<typeof ruleBody>;

export const criterionBody = z.object({
  name: z.string().min(1).max(120),
  period: z.enum(['month', 'day']),
  metric: z.enum(['turnover', 'profit', 'count']),
  scope: z.enum(['staff', 'location']),
  byServices: z.boolean(),
  byProducts: z.boolean(),
  threshold: z.number().min(0),
  includeDiscounts: z.boolean(),
  countCategoryIds: z.array(z.string()),
  countItemIds: z.array(z.string()),
});
export type CriterionBody = z.infer<typeof criterionBody>;

export const chartBody = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['standard', 'planned']),
  standardRuleId: z.string().nullable().optional(),
  planRows: z.array(z.object({ criterionId: z.string(), ruleId: z.string() })),
});
export type ChartBody = z.infer<typeof chartBody>;

export const assignmentBody = z.object({ chartId: z.string().min(1), staffId: z.string().min(1), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export type AssignmentBody = z.infer<typeof assignmentBody>;

export const bonusPenaltyTypeBody = z.object({ kind: z.enum(['bonus', 'penalty']), name: z.string().min(1).max(120), defaultAmount: z.number().min(0) });
export type BonusPenaltyTypeBody = z.infer<typeof bonusPenaltyTypeBody>;

export const settlementSheetBody = z.object({
  staffId: z.string().min(1),
  locationId: z.string().min(1),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  comment: z.string().max(400).optional(),
  draft: z.boolean().optional(),
});
export type SettlementSheetBody = z.infer<typeof settlementSheetBody>;

export const settlementEntryBody = z.object({
  staffId: z.string().min(1),
  kind: z.enum(['bonus', 'penalty', 'adjustment']),
  label: z.string().min(1).max(200),
  amount: z.number().min(0),
  comment: z.string().max(400).optional(),
});
export type SettlementEntryBody = z.infer<typeof settlementEntryBody>;

export const payoutBody = z.object({
  staffId: z.string().min(1),
  locationId: z.string().min(1),
  accountId: z.string().min(1),
  amount: z.number().min(1),
  comment: z.string().max(400).optional(),
});
export type PayoutBody = z.infer<typeof payoutBody>;

export const bulkApplySchemeBody = z.object({ staffIds: z.array(z.string().min(1)).min(1), defaultPercent: z.number().min(0).max(100) });
export type BulkApplySchemeBody = z.infer<typeof bulkApplySchemeBody>;

/** F-09-085…089: права на раздел «Зарплата» одного сотрудника (этап 21, лейн services+rest) */
export const payrollStaffRightsBody = z.object({
  staffId: z.string().min(1),
  schemesAccess: z.boolean(),
  calcAccess: z.enum(['none', 'today', 'all']),
  accrueAccess: z.enum(['none', 'today', 'all']),
  ownOnlyStaffId: z.string().min(1).optional(),
});
export type PayrollStaffRightsBody = z.infer<typeof payrollStaffRightsBody>;

export const payrollStaffRightsBatchBody = z.object({ list: z.array(payrollStaffRightsBody).min(1) });
export type PayrollStaffRightsBatchBody = z.infer<typeof payrollStaffRightsBatchBody>;
