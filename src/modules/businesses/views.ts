import type { Business, Location, Network, Position, Staff, StaffInvite } from '../../generated/prisma/client.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';

/**
 * Представления бизнеса, филиала, сети и сотрудника для КАБИНЕТА своего бизнеса (docs/backend/03 §3, «вид — свой бизнес»).
 * Форма — как типы фронта (src/domain/core.ts: Business, Location, Network, Staff), чтобы экраны не менялись.
 * Необязательные поля без значения не отдаются (как в моке: «нет поля»). Юр. данные, права и настройки доступа
 * сотрудника — только отдельными маршрутами с правом staff.manage.
 */

type Json = unknown;
const arr = <T = string>(v: Json): T[] => (Array.isArray(v) ? (v as T[]) : []);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function businessView(b: Business, locationIds: string[]) {
  return {
    id: b.id,
    kind: b.kind as 'individual' | 'salon',
    name: b.name,
    slug: b.slug,
    sphereIds: arr(b.sphereIds),
    networkId: opt(b.networkId),
    ownerStaffId: b.ownerStaffId ?? '',
    locationIds,
    phone: b.phone,
    description: opt(b.description as Record<string, string> | null),
    logoUrl: opt(b.logoUrl),
    photos: arr(b.photos),
    status: b.status as 'active' | 'frozen' | 'moderation' | 'draft',
    createdAt: utcToLocal(b.createdAt),
    forbidHomeBookingsDuringShift: b.forbidHomeBookingsDuringShift,
    socials: opt(b.socials as Record<string, unknown> | null),
    bookingRules: opt(b.bookingRules as Record<string, unknown> | null),
    brandName: opt(b.brandName),
    version: b.version,
  };
}
export type BusinessView = ReturnType<typeof businessView>;

export function locationView(l: Location) {
  return {
    id: l.id,
    businessId: l.businessId,
    name: l.name as Record<string, string>,
    address: l.address as Record<string, string>,
    district: l.district,
    yandexMapsUrl: opt(l.yandexMapsUrl),
    coords: l.lat !== null && l.lng !== null ? { lat: Number(l.lat), lng: Number(l.lng) } : undefined,
    phone: opt(l.phone),
    extraPhones: opt(l.extraPhones as string[] | null),
    hoursText: opt(l.hoursText),
    openHours: opt(l.openHours as Record<string, unknown> | null),
    journalKind: opt(l.journalKind as 'individual' | 'mixed' | 'group' | null),
    timezone: l.tz,
    version: l.version,
  };
}

export function networkView(n: Network, businessIds: string[]) {
  return {
    id: n.id,
    name: n.name,
    ownerStaffId: n.ownerStaffId ?? '',
    businessIds,
    createdAt: utcToLocal(n.createdAt),
    mainBusinessId: opt(n.mainBusinessId),
    version: n.version,
  };
}

export function staffView(s: Staff & { locations?: { locationId: string }[] }) {
  return {
    id: s.id,
    businessId: s.businessId,
    locationIds: (s.locations ?? []).map((l) => l.locationId),
    name: s.name,
    phone: s.phone,
    email: opt(s.email),
    role: s.role as 'owner' | 'admin' | 'master',
    position: opt(s.position as Record<string, string> | null),
    specialty: opt(s.specialty as Record<string, string> | null),
    sphereIds: arr(s.sphereIds),
    avatarUrl: opt(s.avatarUrl),
    bio: opt(s.bio as Record<string, string> | null),
    photos: arr(s.photos),
    materials: arr(s.materials),
    workplaces: arr(s.workplaces),
    homeAddress: opt(s.homeAddress),
    homeDistrict: opt(s.homeDistrict),
    visitDistricts: opt(s.visitDistricts as string[] | null),
    accepts: s.accepts,
    calendarVisibility: s.calendarVisibility,
    calendarMode: s.calendarMode,
    confirmMode: s.confirmMode,
    colorIndex: s.colorIndex,
    serviceIds: arr(s.serviceIds),
    status: s.status as 'active' | 'invited' | 'disabled' | 'fired',
    /** Логин администратора (F-00-034) — из staff_logins */
    login: undefined as string | undefined,
    callHours: opt(s.callHours as { from: string; to: string } | null),
    hiredAt: s.hiredAt,
    onlineBookingEnabled: s.onlineBookingEnabled,
    hiddenInJournal: s.hiddenInJournal || undefined,
    assistantOnly: s.assistantOnly || undefined,
    journalMarkupMin: opt(s.journalMarkupMin),
    prepayment: opt(s.prepayment as Record<string, unknown> | null),
    bookingRules: opt(s.bookingRules as Record<string, unknown> | null),
    contacts: opt(s.contacts as Record<string, unknown> | null),
    // Стадия 21 (лейн client+online): нужно `client.ts::canRestoreStaff` (F-14-118) — поле у Staff уже было
    // (раздел staff, F-10-044), только не отдавалось видом; опциональное добавление, старые потребители целы.
    firedAt: s.firedAt ? utcToLocal(s.firedAt) : undefined,
    version: s.version,
  };
}
export type StaffView = ReturnType<typeof staffView>;

export function staffViewWithLogin(s: Staff & { locations?: { locationId: string }[]; logins?: { login: string; disabledAt: Date | null }[] }) {
  const v = staffView(s);
  const login = s.logins?.find((l) => !l.disabledAt)?.login;
  return login ? { ...v, login } : v;
}

export function positionView(p: Position) {
  return {
    id: p.id,
    businessId: p.businessId ?? '',
    name: p.name as Record<string, string>,
    description: opt(p.description),
    order: p.sortOrder,
    createdAt: utcToLocalDate(p.createdAt),
  };
}

export function inviteView(i: StaffInvite) {
  return {
    id: i.id,
    businessId: i.businessId,
    staffId: i.staffId,
    role: i.role as 'admin' | 'master',
    phone: opt(i.phone),
    email: opt(i.email),
    // Во фронте три состояния; «отклонено» и «истекло» экран показывает как отозванное
    status: (i.status === 'pending' || i.status === 'accepted' ? i.status : 'revoked') as 'pending' | 'accepted' | 'revoked',
    createdAt: utcToLocalDate(i.sentAt),
  };
}

/** Доступ сотрудника (StaffAccessInfo фронта) */
export function accessView(s: Staff) {
  return {
    enabled: s.role === 'owner' ? true : s.accessEnabled,
    info: opt(s.accessInfo),
    roleTemplateId: (s.roleTemplateId ?? defaultRoleTemplate(s.role)) as string,
    ipRestriction: opt(s.ipRestriction as { enabled: boolean; ranges: string[] } | null),
  };
}

export function defaultRoleTemplate(role: string): string {
  if (role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  return 'specialist';
}
