import type { Service, ServiceCategory } from '../../generated/prisma/client.js';
import { moneyToJson } from '../../common/money/money.js';

/**
 * Представления каталога услуг для КАБИНЕТА своего бизнеса (docs/backend/01 §4). Форма — как во фронте
 * (src/domain/core.ts: ServiceCategory, Service), чтобы экраны не менялись. Пакет «Комплекс» — та же строка
 * Service с заполненным servicePackage/packageExtra (01 §4: «хозяин — services»).
 */

type Json = unknown;
const arr = <T = string>(v: Json): T[] => (Array.isArray(v) ? (v as T[]) : []);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function categoryView(c: ServiceCategory) {
  return {
    id: c.id,
    businessId: c.businessId,
    name: c.name as Record<string, string>,
    order: c.sortOrder,
    version: c.version,
  };
}
export type CategoryView = ReturnType<typeof categoryView>;

export function categoryOnlineNameView(c: ServiceCategory) {
  return { onlineNameEnabled: c.onlineNameEnabled, onlineName: opt(c.onlineName as Record<string, string> | null) };
}

export interface ServicePackageComposition {
  items: { serviceId: string; order: number }[];
  mode: 'parallel' | 'sequentialSame' | 'sequentialAny';
}

export function serviceView(s: Service) {
  return {
    id: s.id,
    businessId: s.businessId,
    // Категория могла быть удалена (F-16-171, деление на сервере — FK SetNull) — «» вместо null, экран ждёт строку
    categoryId: s.categoryId ?? '',
    sphereId: s.sphereId,
    name: s.name as Record<string, string>,
    description: opt(s.description as Record<string, string> | null),
    kind: s.kind as 'individual' | 'group',
    durationMin: s.durationMin,
    durationMax: opt(s.durationMax),
    priceMin: moneyToJson(s.priceMin),
    priceMax: s.priceMax != null ? moneyToJson(s.priceMax) : undefined,
    bufferAfterMin: opt(s.bufferAfterMin),
    repeatIntervalDays: opt(s.repeatIntervalDays),
    winbackReminder: opt(s.winbackReminder as 'off' | 'custom' | null),
    capacity: opt(s.capacity),
    photos: arr<string>(s.photos),
    materials: arr<string>(s.materials),
    staffIds: arr<string>(s.staffIds),
    workplaces: arr<string>(s.workplaces),
    onlineBookable: s.onlineBookable,
    active: s.active,
    order: Number(s.order),
    shadeChoice: opt(s.shadeChoice as 'required' | 'preferred' | null),
    servicePackage: opt(s.servicePackage as ServicePackageComposition | null),
    version: s.version,
  };
}
export type ServiceView = ReturnType<typeof serviceView>;

/** ServiceExtra фронта (F-03-115, F-15-141, F-07-149) — автоперевод, чек, выбор варианта при записи */
export function serviceExtraView(s: Service): Record<string, unknown> {
  return (s.extra as Record<string, unknown> | null) ?? {};
}

/** PackageExtra по умолчанию (defaultPackageExtra фронта, src/domain/resources.ts) */
export function defaultPackageExtra(serviceId: string) {
  return {
    serviceId,
    pricingMethod: 'sumServices' as const,
    availability: { enabled: false, days: 'any' as const },
    prepaymentRequired: false,
    wholePackageResourceIds: [] as string[],
  };
}

export function packageExtraView(s: Service): Record<string, unknown> {
  return (s.packageExtra as Record<string, unknown> | null) ?? defaultPackageExtra(s.id);
}

export function packageWithExtraView(s: Service) {
  return { ...serviceView(s), extra: packageExtraView(s) };
}
