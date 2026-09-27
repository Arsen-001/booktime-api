import { z } from 'zod';

const id32 = z.string().min(1).max(32);
const dateRange = z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() }).partial();
const numberRange = z.object({ from: z.number().optional(), to: z.number().optional() }).partial();

// ─────────── карточка (F-04-044…061) ───────────

export const clientFormBody = z.object({
  name: z.string().min(1).max(160),
  lastName: z.string().max(80).optional(),
  middleName: z.string().max(80).optional(),
  phone: z.string().min(1).max(32),
  additionalPhone: z.string().max(32).optional(),
  email: z.string().max(160).optional(),
  birthday: z.string().max(10).optional(),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  importanceClass: z.enum(['gold', 'silver', 'bronze']).optional(),
  cardNumber: z.string().max(40).optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  blocked: z.boolean().optional(),
  note: z.string().max(2000).optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  /** F-07-056: «Продано» из формы — целиком, сохраняется как есть при создании */
  paidAmount: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000).optional(),
  importedSold: z.number().int().min(0).max(1_000_000_000_000).optional(),
  avatar: z.string().max(4_000_000).optional(),
  customFieldValues: z.record(z.string(), z.string().max(2000)).optional(),
  nationalId: z.string().max(20).optional(),
  birthdayGreetingOptOut: z.boolean().optional(),
  locale: z.enum(['ru', 'hy', 'en']).optional(),
  preferredContact: z.enum(['call', 'wa', 'tg', 'viber']).optional(),
});
export type ClientFormBody = z.infer<typeof clientFormBody>;

export const createClientBody = clientFormBody;
export const updateClientBody = clientFormBody;

// ─────────── список / поиск (F-04-001…035, K8: фильтр и подсчёт — на сервере) ───────────

const visitsFilters = z
  .object({
    presence: z.enum(['has', 'none']).optional(),
    presenceRange: dateRange.optional(),
    status: z.array(z.string().max(30)).optional(),
    visitsCount: numberRange.optional(),
    period: dateRange.optional(),
    staffIds: z.array(id32).optional(),
    serviceIds: z.array(id32).optional(),
    serviceAmount: numberRange.optional(),
  })
  .partial();

const clientsFilters = z
  .object({
    gender: z.array(z.enum(['female', 'male', 'unknown', 'unset'])).optional(),
    hasMobileApp: z.enum(['yes', 'no']).optional(),
    categoryTags: z.array(z.string().max(80)).optional(),
    sold: numberRange.optional(),
    balance: numberRange.optional(),
    broadcastPeriod: dateRange.optional(),
    importance: z.array(z.enum(['gold', 'silver', 'bronze', 'none'])).optional(),
    birthdayPeriod: dateRange.optional(),
    age: numberRange.optional(),
  })
  .partial();

const certificateFilter = z
  .object({
    name: z.string().max(200).optional(),
    used: z.enum(['yes', 'no']).optional(),
    balance: numberRange.optional(),
    expiringSoon: z.boolean().optional(),
    soldAt: dateRange.optional(),
  })
  .partial();

const subscriptionFilter = z
  .object({
    name: z.string().max(200).optional(),
    used: z.enum(['yes', 'no']).optional(),
    status: z.enum(['active', 'expired']).optional(),
    frozen: z.boolean().optional(),
    expiringSoon: z.boolean().optional(),
    soldAt: dateRange.optional(),
    remainingVisits: numberRange.optional(),
  })
  .partial();

const salesFilters = z
  .object({
    productNames: z.array(z.string().max(200)).optional(),
    certificate: certificateFilter.optional(),
    subscription: subscriptionFilter.optional(),
  })
  .partial();

export const filterState = z.object({
  logic: z.object({ visits: z.enum(['and', 'or']), clients: z.enum(['and', 'or']), sales: z.enum(['and', 'or']) }),
  visits: visitsFilters,
  clients: clientsFilters,
  sales: salesFilters,
});
export type FilterState = z.infer<typeof filterState>;

export const clientsSort = z.object({
  columnId: z.enum(['name', 'phone', 'email', 'sold', 'balance', 'visits', 'discount', 'lastVisit', 'firstVisit']),
  dir: z.enum(['asc', 'desc']),
});
export type ClientsSort = z.infer<typeof clientsSort>;

export const quickPick = z.enum(['new', 'repeat', 'lost', 'subscriptionEnding', 'chatLeads', 'noShow']);
export type QuickPick = z.infer<typeof quickPick>;

export const searchBody = z.object({
  locationIds: z.array(id32).max(50).optional(),
  search: z.string().max(200).optional(),
  pick: quickPick.nullable().optional(),
  filters: filterState.optional(),
  sort: clientsSort.nullable().optional(),
  onlyStaffId: id32.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
  revealId: id32.optional(),
});
export type SearchBody = z.infer<typeof searchBody>;

export const countMatchingBody = z.object({ locationIds: z.array(id32).max(50).optional(), filters: filterState.optional() });

// ─────────── колонки (F-04-004/005) ───────────

export const clientColumnId = z.enum(['name', 'phone', 'email', 'sold', 'balance', 'visits', 'discount', 'lastVisit', 'firstVisit']);
export const setColumnsBody = z.object({ staffId: id32.optional(), visible: z.array(clientColumnId).max(9) });
export const togglePinBody = z.object({ staffId: id32.optional(), id: clientColumnId });

// ─────────── категории (F-04-109/110) ───────────

export const categoryUpsertBody = z.object({ name: z.string().min(1).max(80), color: z.string().min(1).max(20) });

// ─────────── комментарии (F-04-070) ───────────

export const addCommentBody = z.object({ text: z.string().min(1).max(2000) });

// ─────────── файлы (F-04-086) ───────────

export const addFileBody = z.object({
  name: z.string().min(1).max(200),
  ext: z.string().min(1).max(10),
  size: z.number().int().min(1),
  dataUrl: z.string().min(1).max(20_000_000),
});

// ─────────── согласие на рекламу / анкета (F-04-153/154/227) ───────────

export const adConsentBody = z.object({ given: z.boolean(), method: z.enum(['widget', 'paper', 'link']) });
export const consentFormBody = z.object({ name: z.string().max(160).optional(), birthday: z.string().max(10).optional(), adConsentGiven: z.boolean() });

// ─────────── массовые действия (F-04-037…042) ───────────

export const bulkIdsBody = z.object({ clientIds: z.array(id32).min(1).max(5000) });
export const bulkCategoryBody = z.object({ clientIds: z.array(id32).min(1).max(5000), category: z.string().min(1).max(80), color: z.string().max(20).optional() });
export const mergeBody = z.object({ keepId: id32, duplicateId: id32 });

// ─────────── доп. поля (F-04-060, 139…145) ───────────

export const customFieldType = z.enum(['text', 'number', 'list', 'date']);
export const addCustomFieldDefBody = z.object({
  label: z.string().min(1).max(80),
  type: customFieldType.optional(),
  options: z.array(z.string().max(80)).optional(),
  required: z.boolean().optional(),
  editableByClient: z.boolean().optional(),
  alwaysShowInClientCard: z.boolean().optional(),
  alwaysShowInBookingWindow: z.boolean().optional(),
});

// ─────────── настройки базы (arch-a1 №2) ───────────

export const showFullNameBody = z.object({ value: z.boolean() });
export const showLoyaltySearchBody = z.object({ value: z.boolean() });
export const autoSaveChatLeadsBody = z.object({ value: z.boolean() });
export const lostAfterDaysBody = z.object({ days: z.number().int().min(7).max(365) });

// ─────────── тонкие права (F-04-194…204) ───────────

export const fineRightsBody = z.record(z.string(), z.boolean());

// ─────────── импорт / выгрузка (F-04-126…130) ───────────

export const importColumnTarget = z.enum([
  'ignore',
  'name',
  'lastName',
  'phone',
  'additionalPhone',
  'email',
  'comment',
  'birthday',
  'gender',
  'sold',
  'paid',
  'balance',
  'discount',
  'card',
]);
export const runImportBody = z.object({
  authorName: z.string().min(1).max(120),
  mapping: z.array(importColumnTarget).max(30),
  rows: z.array(z.array(z.string().max(500)).max(30)).max(500),
  method: z.enum(['paste', 'file']).default('paste'),
});

export const exportClientsBody = z.object({
  locationIds: z.array(id32).max(50).optional(),
  ids: z.array(id32).min(1).max(20_000),
  authorName: z.string().min(1).max(120),
  fileName: z.string().min(1).max(200),
});

// ─────────── ответы (OpenAPI) ───────────

export const clientRowOut = z
  .object({
    id: z.string(),
    businessId: z.string(),
    name: z.string(),
    phone: z.string(),
    gender: z.enum(['male', 'female', 'unknown']),
    tags: z.array(z.string()),
    noShowCount: z.number(),
    cancelCount: z.number(),
    createdAt: z.string(),
    discount: z.number(),
    sold: z.number(),
    paid: z.number(),
    balance: z.number(),
    visits: z.number(),
    broadcastDates: z.array(z.string()),
    version: z.number(),
  })
  .catchall(z.unknown());
export const clientListPageOut = z.object({
  rows: z.array(clientRowOut),
  total: z.number(),
  baseTotal: z.number(),
  ids: z.array(z.string()),
  pickCounts: z.record(z.string(), z.number()),
  page: z.number(),
});
export const columnsPrefsOut = z.object({ visible: z.array(clientColumnId), pinned: z.array(clientColumnId) });
export const categoryOut = z.object({ name: z.string(), color: z.string(), count: z.number() });
export const commentOut = z.object({ id: z.string(), clientId: z.string(), authorId: z.string().optional(), authorName: z.string(), text: z.string(), createdAt: z.string() });
export const fileOut = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  ext: z.string(),
  size: z.number(),
  dataUrl: z.string(),
  uploadedAt: z.string(),
  uploadedBy: z.string(),
});
export const changeLogEntryOut = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  action: z.enum(['created', 'updated', 'deleted', 'merged', 'purged']),
  authorId: z.string().optional(),
  authorName: z.string(),
  summary: z.string(),
  at: z.string(),
});
export const importRunOut = z.object({
  id: z.string(),
  at: z.string(),
  authorName: z.string(),
  method: z.enum(['paste', 'file']),
  totalRows: z.number(),
  createdCount: z.number(),
  updatedCount: z.number(),
  rejectedCount: z.number(),
});
export const importRowResultOut = z.object({ rowIndex: z.number(), raw: z.array(z.string()), ok: z.boolean(), error: z.string().optional(), clientId: z.string().optional(), created: z.boolean().optional() });
export const exportLogEntryOut = z.object({ id: z.string(), at: z.string(), authorName: z.string(), count: z.number(), method: z.enum(['download', 'email']) });
