/**
 * Цены и сроки платформы (В-01: «цены храним в таблице, не в коде», пересмотр после показа салонам).
 * Значения ниже — только запас на случай пустой таблицы (сид кладёт те же числа в `platform_prices`);
 * экран и расчёт читают таблицу, наша панель меняет её (`PUT /v1/platform/prices`).
 */
export const DEFAULT_PRICES = {
    /** Индивидуал, ֏/мес (В-01) */
    individual: 5000,
    /** Мастер салона, ֏/мес (В-01) */
    masterSeat: 4000,
    /** Каждый администратор сверх первого бесплатного (В-12, 06 §3.1) */
    adminExtraSeat: 2000,
    /** Минимум платных мастеров у салона */
    minPaidMasters: 2,
    /** 1 монета = 10 ֏ (В-15) */
    coinPrice: 10,
    /** Отсрочка после неоплаты, дней (В-02) */
    graceDays: 3,
    /** Бесплатный месяц при подключении на визите (F-00-019) */
    freeMonthDays: 30,
    /** Срок промокода, дней (В-13) */
    promoValidDays: 30,
    /** Траты монет — «цены трат как предложено» (В-15): место под фото сверх 6 навсегда (F-00-086) */
    photoSlotCoins: 50,
    /** Пуш сверх лимита новостей (E5) */
    pushExtraCoins: 30,
    /** Выделить горящее окно */
    hotSlotCoins: 20,
    /** «Выше в поиске» в районе, в день */
    searchBoostCoins: 100,
    /** Место сторис (В-25: 200 монет, последние 3 места ×1,5) */
    storyPlaceCoins: 200,
};
export const PRICE_NOTES = {
    individual: 'Индивидуал, ֏/мес (В-01)',
    masterSeat: 'Мастер салона, ֏/мес (В-01)',
    adminExtraSeat: 'Администратор сверх первого, ֏/мес',
    minPaidMasters: 'Минимум платных мастеров салона',
    coinPrice: '1 монета, ֏ (В-15)',
    graceDays: 'Отсрочка после неоплаты, дней (В-02)',
    freeMonthDays: 'Бесплатный месяц с визита, дней (F-00-019)',
    promoValidDays: 'Срок промокода, дней (В-13)',
    photoSlotCoins: 'Место под фото сверх 6, монет (F-00-086)',
    pushExtraCoins: 'Пуш сверх лимита новостей, монет (В-15)',
    hotSlotCoins: 'Выделить горящее окно, монет (В-15)',
    searchBoostCoins: '«Выше в поиске» в районе, монет в день (В-15)',
    storyPlaceCoins: 'Место сторис, монет (В-25)',
};
export async function loadPrices(db) {
    const rows = await db.platformPrice.findMany();
    const out = { ...DEFAULT_PRICES };
    for (const r of rows)
        if (r.key in out)
            out[r.key] = Number(r.value);
    return out;
}
/** Ступени промокода по умолчанию (В-13): 10 / 15 / 25 % за 3 / 6 / 12 месяцев */
export const DEFAULT_PROMO_TIERS = [
    { months: 3, percent: 10 },
    { months: 6, percent: 15 },
    { months: 12, percent: 25 },
];
/** Скидка за выбранный срок: лучшая ступень, чей срок ≤ выбранного; короче первой ступени — без скидки */
export function tierPercent(tiers, months) {
    let best = 0;
    for (const t of tiers ?? [])
        if (t.months <= months && t.percent > best)
            best = t.percent;
    return best;
}
//# sourceMappingURL=billing-prices.js.map