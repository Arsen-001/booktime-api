/**
 * Места показа рекламы (F-00-163…166) — статичный справочник, не таблица: 1:1 с PLACEMENTS мока
 * (src/api/platform/ads.ts), меняются редко, правки — код-ревью, не панель.
 */
export interface AdPlacementDef {
  id: string;
  kind: 'banner' | 'supplier';
  audience: 'client' | 'business';
  name: { ru: string; en: string };
  pricePerDay: number;
  active: boolean;
}

export const AD_PLACEMENTS: AdPlacementDef[] = [
  { id: 'pl_banner_home', kind: 'banner', audience: 'client', name: { ru: 'Главная приложения, вверху', en: 'App home, top' }, pricePerDay: 5000, active: true },
  { id: 'pl_banner_search', kind: 'banner', audience: 'client', name: { ru: 'Поиск, над результатами', en: 'Search, above results' }, pricePerDay: 4000, active: true },
  { id: 'pl_supplier_masters', kind: 'supplier', audience: 'business', name: { ru: 'Кабинет мастера: предложения', en: 'Business workspace: offers' }, pricePerDay: 3000, active: true },
  { id: 'pl_stock', kind: 'supplier', audience: 'business', name: { ru: 'Склад: рядом с товаром на исходе', en: 'Stock: next to a running-low item' }, pricePerDay: 2000, active: true },
];

export function adState(ad: { paused: boolean; startDate: string; endDate: string }, today: string): 'scheduled' | 'running' | 'paused' | 'finished' {
  if (ad.paused) return 'paused';
  if (ad.endDate < today) return 'finished';
  if (ad.startDate > today) return 'scheduled';
  return 'running';
}
