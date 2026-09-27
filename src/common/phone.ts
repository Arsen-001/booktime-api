/**
 * Телефоны Армении (В-37: только +374): хранение '+374XXXXXXXX', как normalizePhone во фронте (src/lib/phone.ts).
 */
export const PHONE_PREFIX = '+374';
const PHONE_DIGITS = 8;

/** Любой ввод → '+374XXXXXXXX' или undefined, если цифр не 8 */
export function normalizePhone(input: string): string | undefined {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('374')) digits = digits.slice(3);
  if (digits.startsWith('0') && digits.length === PHONE_DIGITS + 1) digits = digits.slice(1);
  return digits.length === PHONE_DIGITS ? `${PHONE_PREFIX}${digits}` : undefined;
}

/** '+37400123456' → '+374 00 1•• •56' — для ответов, где номер виден не владельцу */
export function maskPhone(phone: string): string {
  const d = phone.slice(PHONE_PREFIX.length);
  if (d.length !== PHONE_DIGITS) return '•••';
  return `${PHONE_PREFIX} ${d.slice(0, 2)} ${d[2]}•• •${d.slice(6)}`;
}
