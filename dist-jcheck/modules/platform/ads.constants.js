export const AD_PLACEMENTS = [
    { id: 'pl_banner_home', kind: 'banner', audience: 'client', name: { ru: 'Главная приложения, вверху', en: 'App home, top' }, pricePerDay: 5000, active: true },
    { id: 'pl_banner_search', kind: 'banner', audience: 'client', name: { ru: 'Поиск, над результатами', en: 'Search, above results' }, pricePerDay: 4000, active: true },
    { id: 'pl_supplier_masters', kind: 'supplier', audience: 'business', name: { ru: 'Кабинет мастера: предложения', en: 'Business workspace: offers' }, pricePerDay: 3000, active: true },
    { id: 'pl_stock', kind: 'supplier', audience: 'business', name: { ru: 'Склад: рядом с товаром на исходе', en: 'Stock: next to a running-low item' }, pricePerDay: 2000, active: true },
];
export function adState(ad, today) {
    if (ad.paused)
        return 'paused';
    if (ad.endDate < today)
        return 'finished';
    if (ad.startDate > today)
        return 'scheduled';
    return 'running';
}
//# sourceMappingURL=ads.constants.js.map