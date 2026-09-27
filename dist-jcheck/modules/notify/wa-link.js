/** wa.me с готовым текстом (F-00-121, F-00-137) — та же схема, что `waLink` фронта (src/lib/phone.ts) */
export function waLink(phone, text) {
    const digits = phone.replace(/\D/g, '');
    return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
//# sourceMappingURL=wa-link.js.map