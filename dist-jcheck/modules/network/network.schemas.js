import { z } from 'zod';
import { localized } from '../businesses/business.schemas.js';
/**
 * Права пользователя сети (F-11-024…035) — СВОЙ список, отдельный от 39 прав бизнеса (common/permissions.ts):
 * это доступ к сетевым разделам человека БЕЗ строки staff ни в одном филиале, как ALL_NETWORK_PERMISSIONS
 * фронта (src/domain/network.ts). Не сверяется npm run check:permissions — та сверка про права бизнеса.
 */
export const NETWORK_PERMISSION_KEYS = [
    'settings',
    'users',
    'clients',
    'records',
    'staff',
    'services',
    'goods',
    'loyalty',
    'accounts',
    'onlineSales',
    'telephony',
    'plans',
    'analytics',
    'fields',
    'subdivisions',
    'migrations',
    'payroll',
];
export const networkPermissionKey = z.enum(NETWORK_PERMISSION_KEYS);
export function isNetworkPermission(v) {
    return typeof v === 'string' && NETWORK_PERMISSION_KEYS.includes(v);
}
export const id32 = z.string().min(1).max(32);
export const phoneAm = z.string().regex(/^\+374\d{8}$/, 'phone must be +374XXXXXXXX');
// ─────────────────────── Пользователи сети (F-11-024…036) ───────────────────────
export const networkUserOut = z.object({
    id: z.string(),
    networkId: z.string(),
    name: z.string(),
    phone: z.string(),
    email: z.string().optional(),
    permissions: z.array(networkPermissionKey),
    lastVisitAt: z.string().optional(),
    isOwner: z.boolean().optional(),
    pending: z.boolean().optional(),
    planReportFrequency: z.enum(['off', 'daily', 'weekly', 'monthly']).optional(),
    version: z.number(),
});
export const inviteExistingBody = z.object({ phone: phoneAm, permissions: z.array(networkPermissionKey).max(20).default([]) });
export const addNewUserBody = z.object({ phone: phoneAm, name: z.string().min(1).max(160), email: z.string().max(160).optional(), permissions: z.array(networkPermissionKey).max(20).default([]) });
export const setPermissionsBody = z.object({ permissions: z.array(networkPermissionKey).max(20) });
export const setPlanReportFreqBody = z.object({ frequency: z.enum(['off', 'daily', 'weekly', 'monthly']) });
// ─────────────────────── Общая база клиентов сети (F-11-040…053) ───────────────────────
export const networkClientSearchBody = z.object({
    search: z.string().max(200).optional(),
    businessIds: z.array(id32).max(50).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(200).default(20),
});
// ─────────────────────── Рассылки (F-11-054…061) ───────────────────────
export const broadcastBody = z.object({
    channel: z.enum(['sms', 'push']),
    scope: z.enum(['selected', 'found']),
    text: z.string().min(1).max(600),
    businessIds: z.array(id32).max(50).optional(),
    search: z.string().max(200).optional(),
    clientKeys: z.array(z.object({ businessId: id32, clientId: id32 })).max(5000).optional(),
});
// ─────────────────────── Аналитика и планы (F-11-062…078) ───────────────────────
/** businessIds — через запятую в query-строке (как utilizationQuery раздела schedule), не z.array() */
export const analyticsQuery = z.object({ from: z.string(), to: z.string(), businessIds: z.string().max(2000).optional() });
export const lostClientDaysBody = z.object({ days: z.number().int().min(1).max(3650) });
export const planCellBody = z.object({ businessId: id32, kind: z.enum(['revenue', 'clients', 'avgCheck']), month: z.string().regex(/^\d{4}-\d{2}$/), value: z.number().int().min(0).max(1_000_000_000_000) });
// ─────────────────────── Сетевые каталоги: услуги/категории (F-11-079…093) ───────────────────────
export const networkServiceCategoryBody = z.object({
    key: z.string().max(160).optional(),
    name: localized,
    onlineName: localized.optional(),
    subdivisionId: id32.optional(),
    businessIds: z.array(id32).min(1).max(50),
});
export const networkServiceBody = z.object({
    key: z.string().max(160).optional(),
    name: localized,
    onlineName: localized.optional(),
    categoryKey: z.string().max(160),
    kind: z.enum(['individual', 'group']),
    description: localized.optional(),
    priceMin: z.number().int().min(0).max(1_000_000_000_000),
    priceMax: z.number().int().min(0).max(1_000_000_000_000).optional(),
    durationMin: z.number().int().min(0).max(1440),
    capacity: z.number().int().min(1).max(500).optional(),
    priceLocked: z.boolean().default(false),
    descriptionLocked: z.boolean().default(false),
    businessIds: z.array(id32).min(1).max(50),
});
export const businessIdsBody = z.object({ businessIds: z.array(id32).min(1).max(50) });
// ─────────────────────── Сетевые каталоги: товары (F-11-111…118) ───────────────────────
export const networkGoodsCategoryBody = z.object({ id: id32.optional(), name: z.string().min(1).max(160), parentId: id32.optional(), businessIds: z.array(id32).max(50).default([]) });
export const networkGoodsProductBody = z.object({
    groupId: id32.optional(),
    name: z.string().min(1).max(200),
    categoryId: id32,
    salePrice: z.number().int().min(0).max(1_000_000_000_000),
    costPrice: z.number().int().min(0).max(1_000_000_000_000),
    comment: z.string().max(400).optional(),
    businessIds: z.array(id32).min(1).max(50),
});
export const migrateGoodsBody = z.object({ fromBusinessId: id32, goodIds: z.union([z.array(id32).max(2000), z.literal('all')]) });
// ─────────────────────── Сетевые должности (простые, Position.networkId — этап 3) ───────────────────────
export const networkPositionBody = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() });
// ─────────────────────── Поля записи/клиента сети (F-11-126…134) ───────────────────────
export const FIELD_API_KEY_RE = /^[a-zA-Z0-9._-]+$/;
export const networkFieldBody = z.object({
    kind: z.enum(['booking', 'client']),
    name: z.string().min(1).max(160),
    dataType: z.enum(['text', 'number', 'list', 'date', 'datetime']),
    apiKey: z.string().min(1).max(60).regex(FIELD_API_KEY_RE),
    listOptions: z.array(z.string().max(160)).max(100).default([]),
    editableByUser: z.boolean().default(false),
    showInAdmin: z.boolean().default(true),
    alwaysShowInBookingWindow: z.boolean().default(false),
    requiredOnCreate: z.boolean().default(false),
    requiredOnArrived: z.boolean().default(false),
    alwaysShowInClientCard: z.boolean().default(false),
    showInWidget: z.boolean().default(false),
    requiredInWidget: z.boolean().default(false),
    businessIds: z.array(id32).max(50).default([]),
});
//# sourceMappingURL=network.schemas.js.map