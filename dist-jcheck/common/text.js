/**
 * Латинский адрес /b/<slug> из названия — ТА ЖЕ транслитерация, что во фронте (booking-platform/src/lib/text.ts slugify):
 * «Салон Ани» → «salon-ani», «Նուռ Սթուդիո» → «nur-studio». Уникальность — в сервисе бизнеса.
 */
const RU_LATIN = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const HY_LATIN = {
    ա: 'a', բ: 'b', գ: 'g', դ: 'd', ե: 'e', զ: 'z', է: 'e', ը: 'y', թ: 't', ժ: 'zh', ի: 'i', լ: 'l', խ: 'kh', ծ: 'ts',
    կ: 'k', հ: 'h', ձ: 'dz', ղ: 'gh', ճ: 'ch', մ: 'm', յ: 'y', ն: 'n', շ: 'sh', ո: 'o', չ: 'ch', պ: 'p', ջ: 'j', ռ: 'r',
    ս: 's', վ: 'v', տ: 't', ր: 'r', ց: 'ts', ւ: 'v', փ: 'p', ք: 'k', օ: 'o', ֆ: 'f', և: 'ev',
};
export function slugify(value) {
    const lower = value.toLowerCase().replace(/ու/g, 'u');
    let out = '';
    for (const ch of lower)
        out += RU_LATIN[ch] ?? HY_LATIN[ch] ?? ch;
    return out
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
}
/** Нижний регистр без крайних пробелов — ключ «такое имя уже есть» */
export function norm(value) {
    return value.trim().toLowerCase().replace(/ё/g, 'е');
}
//# sourceMappingURL=text.js.map