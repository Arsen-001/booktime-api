import { moneyToJson } from '../../common/money/money.js';
const arr = (v) => (Array.isArray(v) ? v : []);
const opt = (v) => (v === null || v === undefined ? undefined : v);
export function categoryView(c) {
    return {
        id: c.id,
        businessId: c.businessId,
        name: c.name,
        order: c.sortOrder,
        version: c.version,
    };
}
export function categoryOnlineNameView(c) {
    return { onlineNameEnabled: c.onlineNameEnabled, onlineName: opt(c.onlineName) };
}
export function serviceView(s) {
    return {
        id: s.id,
        businessId: s.businessId,
        // Категория могла быть удалена (F-16-171, деление на сервере — FK SetNull) — «» вместо null, экран ждёт строку
        categoryId: s.categoryId ?? '',
        sphereId: s.sphereId,
        name: s.name,
        description: opt(s.description),
        kind: s.kind,
        durationMin: s.durationMin,
        durationMax: opt(s.durationMax),
        priceMin: moneyToJson(s.priceMin),
        priceMax: s.priceMax != null ? moneyToJson(s.priceMax) : undefined,
        bufferAfterMin: opt(s.bufferAfterMin),
        repeatIntervalDays: opt(s.repeatIntervalDays),
        winbackReminder: opt(s.winbackReminder),
        capacity: opt(s.capacity),
        photos: arr(s.photos),
        materials: arr(s.materials),
        staffIds: arr(s.staffIds),
        workplaces: arr(s.workplaces),
        onlineBookable: s.onlineBookable,
        active: s.active,
        order: Number(s.order),
        shadeChoice: opt(s.shadeChoice),
        servicePackage: opt(s.servicePackage),
        version: s.version,
    };
}
/** ServiceExtra фронта (F-03-115, F-15-141, F-07-149) — автоперевод, чек, выбор варианта при записи */
export function serviceExtraView(s) {
    return s.extra ?? {};
}
/** PackageExtra по умолчанию (defaultPackageExtra фронта, src/domain/resources.ts) */
export function defaultPackageExtra(serviceId) {
    return {
        serviceId,
        pricingMethod: 'sumServices',
        availability: { enabled: false, days: 'any' },
        prepaymentRequired: false,
        wholePackageResourceIds: [],
    };
}
export function packageExtraView(s) {
    return s.packageExtra ?? defaultPackageExtra(s.id);
}
export function packageWithExtraView(s) {
    return { ...serviceView(s), extra: packageExtraView(s) };
}
//# sourceMappingURL=services.views.js.map