/** Из числа API в bigint; дробное и небезопасное — ошибка программиста/входа, ловит проверка входа раньше */
export function money(value) {
    if (typeof value === 'bigint')
        return value;
    if (!Number.isSafeInteger(value))
        throw new RangeError(`money must be a safe integer of drams, got ${value}`);
    return BigInt(value);
}
/** Для ответа API */
export function moneyToJson(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n))
        throw new RangeError('money is out of the safe range');
    return n;
}
/** Процент от суммы с округлением до драма (половина — вверх), как в моке (Math.round) */
export function percentOf(amount, percent) {
    return BigInt(Math.round((Number(amount) * percent) / 100));
}
//# sourceMappingURL=money.js.map