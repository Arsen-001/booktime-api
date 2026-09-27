import { z } from 'zod';

const id32 = z.string().min(1).max(32);
const money = z.number().int().min(0).max(1_000_000_000_000);
const qty = z.number().min(-1_000_000).max(1_000_000);
const positiveQty = z.number().min(0.001).max(1_000_000);
const name200 = z.string().min(1).max(200);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ─────────────────────────── Склады (F-08-004…009) ───────────────────────────

export const warehouseBody = z.object({
  locationId: id32,
  name: z.string().min(1).max(120),
  type: z.enum(['writeoff', 'sale']),
  comment: z.string().max(400).optional(),
});
export type WarehouseBody = z.infer<typeof warehouseBody>;
/** НЕ `.partial()` — `warehouseBody` не носит `.default()`, но патч-тело держим явным по правилу этапа 12
 * (проверять патчем одного поля до сдачи, не полагаться на `.partial()` поверх схемы создания). */
export const warehousePatchBody = z.object({
  locationId: id32.optional(),
  name: z.string().min(1).max(120).optional(),
  type: z.enum(['writeoff', 'sale']).optional(),
  comment: z.string().max(400).optional(),
});
export type WarehousePatchBody = z.infer<typeof warehousePatchBody>;
export const reorderBody = z.object({ orderedIds: z.array(id32).min(1).max(200) });

// ─────────────────────────── Категории (F-08-010…014) ───────────────────────────

export const categoryBody = z.object({
  locationId: id32,
  name: z.string().min(1).max(160),
  parentId: id32.optional(),
  sku: z.string().max(60).optional(),
  comment: z.string().max(400).optional(),
});
export type CategoryBody = z.infer<typeof categoryBody>;
export const categoryPatchBody = z.object({
  name: z.string().min(1).max(160).optional(),
  parentId: id32.nullable().optional(),
  sku: z.string().max(60).optional(),
  comment: z.string().max(400).optional(),
});
export type CategoryPatchBody = z.infer<typeof categoryPatchBody>;
export const idsBody = z.object({ ids: z.array(id32).min(1).max(500) });

// ─────────────────────────── Товары (F-08-015…027, F-00-134, F-00-140, F-00-144) ───────────────────────────

export const goodBody = z.object({
  locationId: id32,
  categoryId: id32,
  name: name200,
  receiptName: z.string().max(200).optional(),
  sku: z.string().max(60).optional(),
  barcode: z.string().max(64).optional(),
  markingCode: z.string().max(64).optional(),
  saleUnit: z.string().min(1).max(16).default('pcs'),
  writeoffUnit: z.string().min(1).max(16).default('pcs'),
  unitRatio: z.number().min(0.0001).max(1_000_000).default(1),
  massNetG: z.number().int().min(0).max(1_000_000).optional(),
  massGrossG: z.number().int().min(0).max(1_000_000).optional(),
  salePrice: money.default(0),
  costPrice: money.default(0),
  taxSystem: z.enum(['default', 'general']).default('default'),
  taxRate: z.enum(['default', 'rate20', 'none']).default('default'),
  criticalStock: z.number().min(0).max(1_000_000).default(0),
  desiredStock: z.number().min(0).max(1_000_000).default(0),
  brand: z.string().max(120).optional(),
  shade: z.string().max(80).optional(),
  shadeColorIndex: z.number().int().min(0).max(1000).optional(),
  expiryDate: localDate.optional(),
  purchaseDate: localDate.optional(),
  shelfLifeAfterOpenDays: z.number().int().min(0).max(3650).optional(),
  showToClients: z.boolean().default(false),
  clientName: z.record(z.string(), z.string()).optional(),
  comment: z.string().max(400).optional(),
});
export type GoodBody = z.infer<typeof goodBody>;
/** Явное патч-тело (не `.partial()` — см. предупреждение этапа 12 о `.default()` под `.partial()`) */
export const goodPatchBody = z.object({
  categoryId: id32.optional(),
  name: name200.optional(),
  receiptName: z.string().max(200).optional(),
  sku: z.string().max(60).optional(),
  barcode: z.string().max(64).optional(),
  markingCode: z.string().max(64).optional(),
  saleUnit: z.string().min(1).max(16).optional(),
  writeoffUnit: z.string().min(1).max(16).optional(),
  unitRatio: z.number().min(0.0001).max(1_000_000).optional(),
  massNetG: z.number().int().min(0).max(1_000_000).optional(),
  massGrossG: z.number().int().min(0).max(1_000_000).optional(),
  salePrice: money.optional(),
  costPrice: money.optional(),
  taxSystem: z.enum(['default', 'general']).optional(),
  taxRate: z.enum(['default', 'rate20', 'none']).optional(),
  criticalStock: z.number().min(0).max(1_000_000).optional(),
  desiredStock: z.number().min(0).max(1_000_000).optional(),
  brand: z.string().max(120).optional(),
  shade: z.string().max(80).optional(),
  shadeColorIndex: z.number().int().min(0).max(1000).optional(),
  expiryDate: localDate.nullable().optional(),
  purchaseDate: localDate.nullable().optional(),
  shelfLifeAfterOpenDays: z.number().int().min(0).max(3650).nullable().optional(),
  showToClients: z.boolean().optional(),
  clientName: z.record(z.string(), z.string()).optional(),
  comment: z.string().max(400).optional(),
});
export type GoodPatchBody = z.infer<typeof goodPatchBody>;
export const quickUpdateGoodsBody = z.object({
  ids: z.array(id32).min(1).max(500),
  salePrice: money.optional(),
  criticalStock: z.number().min(0).max(1_000_000).optional(),
  desiredStock: z.number().min(0).max(1_000_000).optional(),
});
export const restoreGoodsBody = z.object({ ids: z.array(id32).min(1).max(500), markRestored: z.boolean().default(false) });

// ─────────────────────────── Операции (F-08-046…061) ───────────────────────────

export const opLineBody = z.object({
  goodId: id32,
  qtySale: positiveQty,
  unitPrice: money,
  discountPct: z.number().int().min(0).max(100).optional(),
});
export type OpLineBody = z.infer<typeof opLineBody>;

export const incomeBody = z.object({
  locationId: id32,
  date: localDateTime,
  warehouseId: id32,
  counterpartyName: z.string().max(160).optional(),
  paid: z.boolean().default(false),
  paymentMethod: z.enum(['cash', 'card']).default('cash'),
  comment: z.string().max(400).optional(),
  lines: z.array(opLineBody).min(1).max(200),
});
export type IncomeBody = z.infer<typeof incomeBody>;

export const writeoffBody = z.object({
  locationId: id32,
  date: localDateTime,
  warehouseId: id32,
  reason: z.enum(['norm', 'manual', 'defect', 'expired']).default('manual'),
  comment: z.string().max(400).optional(),
  lines: z.array(opLineBody).min(1).max(200),
});
export type WriteoffBody = z.infer<typeof writeoffBody>;

export const moveBody = z.object({
  locationId: id32,
  date: localDateTime,
  fromWarehouseId: id32,
  toWarehouseId: id32,
  lines: z.array(z.object({ goodId: id32, qty: positiveQty })).min(1).max(200),
  comment: z.string().max(400).optional(),
});
export type MoveBody = z.infer<typeof moveBody>;

export const saleLineBody = z.object({
  goodId: id32,
  qtySale: positiveQty,
  unitPrice: money,
  discountPct: z.number().int().min(0).max(100).optional(),
});
export const saleBody = z.object({
  locationId: id32,
  warehouseId: id32,
  clientId: id32.optional(),
  staffId: id32.optional(),
  bookingId: id32.optional(),
  paymentMethod: z.enum(['cash', 'card', 'loyalty', 'unpaid']).default('cash'),
  comment: z.string().max(400).optional(),
  lines: z.array(saleLineBody).min(1).max(200),
});
export type SaleBody = z.infer<typeof saleBody>;

export const opDocPatchBody = z.object({
  date: localDateTime.optional(),
  warehouseId: id32.optional(),
  counterpartyName: z.string().max(160).optional(),
  paid: z.boolean().optional(),
  reason: z.enum(['norm', 'manual', 'defect', 'expired']).optional(),
  comment: z.string().max(400).optional(),
  lines: z.array(opLineBody).min(1).max(200).optional(),
});
export type OpDocPatchBody = z.infer<typeof opDocPatchBody>;

export const opFilterQuery = z.object({
  type: z.string().optional(),
  warehouseId: id32.optional(),
  goodId: id32.optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

// ─────────────────────────── Техкарты (F-08-036…045) ───────────────────────────

export const techCardLineBody = z.object({ goodId: id32, warehouseId: id32, qtyWriteoff: positiveQty });
export const techCardBody = z.object({
  locationId: id32,
  serviceId: id32,
  staffId: id32,
  lines: z.array(techCardLineBody).max(200).default([]),
});
export type TechCardBody = z.infer<typeof techCardBody>;
/** Тело `PUT …/staff/:staffId/services/:serviceId/tech-card` — id идут из пути, не дублируются в теле */
export const techCardPutBody = z.object({ locationId: id32, lines: z.array(techCardLineBody).max(200).default([]) });

// ─────────────────────────── Инвентаризация (F-08-079…089) ───────────────────────────

export const inventoryCreateBody = z.object({
  locationId: id32,
  warehouseId: id32,
  categoryId: id32.optional(),
  comment: z.string().max(400).optional(),
});
export type InventoryCreateBody = z.infer<typeof inventoryCreateBody>;
/** F-08-088: правка комментария/даты/категории черновика (этап 21, лейн finance+stock). categoryId: null — «Все категории» */
export const inventoryMetaBody = z.object({
  categoryId: id32.nullable().optional(),
  comment: z.string().max(400).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/).optional(),
});
export type InventoryMetaBody = z.infer<typeof inventoryMetaBody>;
export const inventoryLineBody = z.object({ goodId: id32, actualQty: z.number().min(0).max(1_000_000) });
export type InventoryLineBody = z.infer<typeof inventoryLineBody>;
export const inventorySetLinesBody = z.object({ lines: z.array(inventoryLineBody).min(1).max(2000) });

// ─────────────────────────── Оборудование (⭐ F-00-141) ───────────────────────────

export const equipmentBody = z.object({
  locationId: id32,
  name: z.string().min(1).max(160),
  category: z.string().max(80).optional(),
  purchaseDate: localDate,
  warrantyUntil: localDate.optional(),
  serviceIntervalMonths: z.number().int().min(1).max(120).optional(),
  lastServiceDate: localDate.optional(),
  replaceReminderDate: localDate.optional(),
  comment: z.string().max(400).optional(),
});
export type EquipmentBody = z.infer<typeof equipmentBody>;
export const equipmentPatchBody = equipmentBody.partial();

// ─────────────────────────── Напоминания (⭐ F-00-142) ───────────────────────────

export const reminderBody = z.object({
  locationId: id32,
  staffId: id32.optional(),
  text: z.string().min(1).max(500),
  date: localDate,
});
export type ReminderBody = z.infer<typeof reminderBody>;

// ─────────────────────────── Настройки (F-08-096…100) ───────────────────────────

export const stockSettingsPatchBody = z.object({
  costMethod: z.enum(['lastPurchase', 'average', 'fromGoodSettings']).optional(),
  forbidOnShortage: z.boolean().optional(),
  expiryWarningDays: z.number().int().min(1).max(365).optional(),
  adsOptIn: z.boolean().optional(),
});
export type StockSettingsPatchBody = z.infer<typeof stockSettingsPatchBody>;

export { qty };
