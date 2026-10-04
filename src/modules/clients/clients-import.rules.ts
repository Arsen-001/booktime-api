/**
 * Правила импорта клиентов (04.10.2026, «переезд за минуту») — порт `src/domain/clients/importRules.ts` фронта.
 * Экран сам разбирает файл и шлёт нормализованные строки, но сервер данным браузера не верит: телефон
 * нормализуется заново, почта и дата проверяются, «дополнить пустые поля» решает только сервер.
 */

/** Строк за один вызов POST /clients/import */
export const IMPORT_BATCH_MAX = 1000;

/**
 * Номер из таблицы → E.164. Армения: «093 000 000», «93000000», «374 93 00 00 00», «+374-93-000-000», число Excel
 * «37493000000» или «3,7493E+10» → '+37493000000'. Иностранный: с «+»/«00» (8–15 цифр) или 11–15 цифр без плюса
 * (так выгружает Altegio) → '+<цифры>', foreign = true.
 */
export function normalizeImportPhone(raw: string | undefined | null): { phone: string; foreign: boolean } | undefined {
  let s = (raw ?? '').trim();
  if (!s) return undefined;
  if (/^\d[.,]\d+e\+?\d+$/i.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n)) s = n.toFixed(0);
  }
  s = s.replace(/[.,]0+$/, '');
  let digits = s.replace(/\D/g, '');
  // «00» — международный выход, только если за ним полный номер с кодом страны («00374…», «0044…»); «000 900 001»
  // — местный номер с кодом 00 (так выглядят выдуманные номера демо-данных)
  const via00 = s.startsWith('00') && digits.length >= 12;
  const international = s.startsWith('+') || via00;
  if (via00) digits = digits.slice(2);
  if (!digits) return undefined;

  if (!international || digits.startsWith('374')) {
    let d = digits;
    if (d.startsWith('374') && d.length >= 11) d = d.slice(3);
    if (d.startsWith('0') && d.length === 9) d = d.slice(1);
    if (d.length === 8) return { phone: `+374${d}`, foreign: false };
    if (international) return undefined;
  }
  if (digits.startsWith('0')) return undefined;
  if (international ? digits.length >= 8 && digits.length <= 15 : digits.length >= 11 && digits.length <= 15) {
    return { phone: `+${digits}`, foreign: true };
  }
  return undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isImportEmail = (v: string) => EMAIL_RE.test(v);

/** 'YYYY-MM-DD', и такая дата существует */
export function isIsoDate(v: string): boolean {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && y <= 2100 && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Строка импорта после проверки схемой (clients.schemas.ts importBatchBody) */
export interface ImportRowInput {
  rowIndex: number;
  name: string;
  lastName?: string;
  phone: string;
  additionalPhone?: string;
  email?: string;
  note?: string;
  birthday?: string;
  gender?: 'male' | 'female';
  tags?: string[];
  discountPercent?: number;
  sold?: number;
  paid?: number;
  cardNumber?: string;
}

/** Поля карточки, которые импорт может заполнить */
export interface ImportableClient {
  lastName: string | null;
  email: string | null;
  note: string | null;
  birthday: string | null;
  gender: string;
  tags: unknown;
  additionalPhone: string | null;
  discountPercent: number;
  cardNumber: string | null;
  importedSold: bigint;
  paidAmount: bigint;
}

export interface ImportPatch {
  lastName?: string;
  email?: string;
  note?: string;
  birthday?: string;
  gender?: 'male' | 'female';
  tags?: string[];
  additionalPhone?: string;
  discountPercent?: number;
  cardNumber?: string;
  importedSold?: bigint;
  paidAmount?: bigint;
}

/**
 * «Дополнить пустые поля»: только то, что в карточке пусто. Имя не трогаем, суммы — только если там 0,
 * поэтому повтор того же файла ничего не удваивает (у Altegio «Продано/Оплачено» складывались, F-04-129).
 */
export function fillEmptyPatch(existing: ImportableClient, row: ImportRowInput): ImportPatch {
  const patch: ImportPatch = {};
  const tags = Array.isArray(existing.tags) ? (existing.tags as unknown[]) : [];
  if (!existing.lastName && row.lastName) patch.lastName = row.lastName;
  if (!existing.email && row.email) patch.email = row.email;
  if (!existing.note && row.note) patch.note = row.note;
  if (!existing.birthday && row.birthday) patch.birthday = row.birthday;
  if (existing.gender === 'unknown' && row.gender) patch.gender = row.gender;
  if (tags.length === 0 && row.tags?.length) patch.tags = row.tags;
  if (!existing.additionalPhone && row.additionalPhone) patch.additionalPhone = row.additionalPhone;
  if (!existing.discountPercent && row.discountPercent) patch.discountPercent = row.discountPercent;
  if (!existing.cardNumber && row.cardNumber) patch.cardNumber = row.cardNumber;
  if (existing.importedSold === 0n && row.sold) patch.importedSold = BigInt(row.sold);
  if (existing.paidAmount === 0n && row.paid) patch.paidAmount = BigInt(row.paid);
  return patch;
}

/** Строку очищаем по правилам сервера: телефон заново, плохая почта/дата/второй номер — выбрасываем, не всю строку */
export function cleanImportRow(row: ImportRowInput): { row: ImportRowInput } | { error: 'noPhone' | 'phoneFormat' } {
  if (!row.phone?.trim()) return { error: 'noPhone' };
  const phone = normalizeImportPhone(row.phone);
  if (!phone) return { error: 'phoneFormat' };
  const extra = row.additionalPhone ? normalizeImportPhone(row.additionalPhone) : undefined;
  const name = (row.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || phone.phone;
  const tags = (row.tags ?? []).map((t) => t.trim().slice(0, 40)).filter(Boolean);
  return {
    row: {
      rowIndex: row.rowIndex,
      name,
      phone: phone.phone,
      ...(row.lastName?.trim() ? { lastName: row.lastName.trim().slice(0, 80) } : {}),
      ...(extra && extra.phone !== phone.phone ? { additionalPhone: extra.phone } : {}),
      ...(row.email && isImportEmail(row.email.trim()) ? { email: row.email.trim().toLowerCase().slice(0, 160) } : {}),
      ...(row.note?.trim() ? { note: row.note.trim().slice(0, 2000) } : {}),
      ...(row.birthday && isIsoDate(row.birthday) ? { birthday: row.birthday } : {}),
      ...(row.gender ? { gender: row.gender } : {}),
      ...(tags.length ? { tags: [...new Set(tags)].slice(0, 10) } : {}),
      ...(row.discountPercent ? { discountPercent: row.discountPercent } : {}),
      ...(row.sold ? { sold: row.sold } : {}),
      ...(row.paid ? { paid: row.paid } : {}),
      ...(row.cardNumber?.trim() ? { cardNumber: row.cardNumber.trim().slice(0, 40) } : {}),
    },
  };
}
