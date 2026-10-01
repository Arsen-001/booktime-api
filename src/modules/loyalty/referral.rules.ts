/**
 * «Пригласи подругу» — правила, копия booking-platform/src/domain/rules/referral.ts (там тесты; правите там —
 * поправьте и здесь). Код ссылки, «можно ли привязать», статус приглашённой, имя для чужих глаз.
 */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 6;

export function normalizeReferralCode(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== REFERRAL_CODE_LENGTH) return undefined;
  for (const ch of code) if (!REFERRAL_CODE_ALPHABET.includes(ch)) return undefined;
  return code;
}

export function makeReferralCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) out += REFERRAL_CODE_ALPHABET[Math.floor(random() * REFERRAL_CODE_ALPHABET.length) % REFERRAL_CODE_ALPHABET.length];
  return out;
}

export function referralInvitePath(slug: string, code: string): string {
  return `/b/${encodeURIComponent(slug)}?ref=${encodeURIComponent(code)}`;
}

export type ReferralDenied = 'inactive' | 'unknown_code' | 'self' | 'already_referred' | 'not_new';

interface Person {
  id: string;
  phone: string;
  appUserId?: string | null;
  deletedAt?: unknown;
}

export function referralDenied(c: { programActive: boolean; referrer?: Person | null; invitee: Person & { referredByClientId?: string | null }; priorBookings: number }): ReferralDenied | null {
  if (!c.programActive) return 'inactive';
  if (!c.referrer || c.referrer.deletedAt) return 'unknown_code';
  const samePhone = Boolean(c.referrer.phone) && c.referrer.phone === c.invitee.phone;
  const sameUser = Boolean(c.referrer.appUserId) && c.referrer.appUserId === c.invitee.appUserId;
  if (c.referrer.id === c.invitee.id || samePhone || sameUser) return 'self';
  if (c.invitee.referredByClientId) return 'already_referred';
  if (c.priorBookings > 0) return 'not_new';
  return null;
}

export type ReferralInviteeStatus = 'booked' | 'visited' | 'rewarded' | 'cancelled';

const CANCELLED = new Set(['cancelled_by_client', 'cancelled_by_master']);

export function referralInviteeStatus(bookings: { status: string }[], rewarded: boolean): ReferralInviteeStatus {
  if (rewarded) return 'rewarded';
  if (bookings.some((b) => b.status === 'arrived')) return 'visited';
  if (bookings.length > 0 && bookings.every((b) => CANCELLED.has(b.status) || b.status === 'no_show')) return 'cancelled';
  return 'booked';
}

export function referralPublicName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[1]![0]}.`;
}
