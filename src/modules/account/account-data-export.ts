/**
 * «Мои данные» (04.10.2026, F-15-154; App Store / GDPR-подобная копия данных): GET /v1/me/data-export отдаёт JSON-файл
 * с данными самого человека — профиль, входы Google/Apple (без токенов и id у провайдера), согласие, свои записи как
 * клиента, избранное, отзывы, дневник, свои карточки сотрудника. Базы клиентов салона здесь нет (у неё своя выгрузка).
 *
 * Только белый список полей: секреты (хеши паролей и сессий, refresh token Apple, accessHash записи, токены пушей)
 * в файл попасть не могут, даже если строку из базы передали целиком — buildMyDataExport берёт поля поимённо.
 */

/** Сколько строк каждого списка максимум (файл остаётся разумного размера) */
export const DATA_EXPORT_LIMIT = 5000;
export const DATA_EXPORT_LOGIN_EVENTS = 100;

type DateLike = Date | null | undefined;
type Num = number | bigint | null | undefined;

export interface RawUser {
  id: string;
  name: string;
  phone: string | null;
  locale: string;
  twoFactorEnabled: boolean;
  createdAt: Date;
  deleteRequestedAt: DateLike;
  dataBlockRequestedAt: DateLike;
}

export interface RawAppProfile {
  gender: string;
  birthday: string | null;
  district: string | null;
  photoUrl: string | null;
  bigFont: boolean;
  timeFormat: string;
  newsPushOptOut: boolean;
  consentAt: DateLike;
  consentVersion: string | null;
}

export interface RawIdentity {
  provider: string;
  email: string | null;
  createdAt: Date;
  lastUsedAt: DateLike;
}

export interface RawBooking {
  id: string;
  businessId: string;
  staffId: string;
  startAt: Date;
  endAt: Date;
  durationMin: number;
  status: string;
  services: unknown;
  total: Num;
  paidAmount: Num;
  source: string;
  forWhom: string;
  visitorName: string | null;
  comment: string | null;
  cancelReason: string | null;
  createdAt: Date;
  deletedAt: DateLike;
}

export interface RawExportInput {
  user: RawUser;
  appProfile: RawAppProfile | null;
  identities: RawIdentity[];
  bookings: RawBooking[];
  /** id → название (бизнесы) и имя (мастера), услуги — id → LocalizedText */
  businessNames: Map<string, string>;
  staffNames: Map<string, string>;
  serviceNames: Map<string, unknown>;
  favorites: { targetType: string; targetId: string; newsMuted: boolean; createdAt: Date }[];
  starRatings: { staffId: string; bookingId: string; createdAt: Date }[];
  staffReviews: { staffId: string; businessId: string; bookingId: string; rating: number; text: string | null; createdAt: Date }[];
  locationReviews: { businessId: string; bookingId: string; text: string; createdAt: Date }[];
  diary: { serviceName: string; masterName: string; date: string; amount: Num; createdAt: Date }[];
  staff: {
    id: string;
    businessId: string;
    name: string;
    phone: string;
    email: string | null;
    role: string;
    status: string;
    firedAt: DateLike;
    deletedAt: DateLike;
  }[];
  sessions: { app: string; device: string; ip: string; createdAt: Date; lastSeenAt: Date }[];
  loginEvents: { at: Date; method: string; channel: string | null; app: string; result: string; device: string; ip: string }[];
  dataExports: { at: Date }[];
}

const iso = (d: DateLike) => (d ? d.toISOString() : null);
const num = (n: Num) => (n == null ? 0 : Number(n));

/** Собрать файл «Мои данные» — только перечисленные поля (см. шапку файла) */
export function buildMyDataExport(input: RawExportInput, now = new Date()) {
  const u = input.user;
  const p = input.appProfile;
  const cap = <T>(rows: T[]) => rows.slice(0, DATA_EXPORT_LIMIT);
  return {
    format: 'booktime-my-data/1',
    exportedAt: now.toISOString(),
    profile: {
      id: u.id,
      name: u.name,
      phone: u.phone,
      locale: u.locale,
      createdAt: iso(u.createdAt),
      twoFactorEnabled: u.twoFactorEnabled,
      deleteRequestedAt: iso(u.deleteRequestedAt),
      dataBlockRequestedAt: iso(u.dataBlockRequestedAt),
    },
    appProfile: p
      ? {
          gender: p.gender,
          birthday: p.birthday,
          district: p.district,
          photoUrl: p.photoUrl,
          bigFont: p.bigFont,
          timeFormat: p.timeFormat,
          newsPushOptOut: p.newsPushOptOut,
        }
      : null,
    consents: p?.consentAt ? [{ document: 'terms', version: p.consentVersion, acceptedAt: iso(p.consentAt) }] : [],
    identities: input.identities.map((i) => ({ provider: i.provider, email: i.email, linkedAt: iso(i.createdAt), lastUsedAt: iso(i.lastUsedAt) })),
    bookings: cap(input.bookings).map((b) => ({
      id: b.id,
      business: input.businessNames.get(b.businessId) ?? null,
      businessId: b.businessId,
      master: input.staffNames.get(b.staffId) ?? null,
      startAt: iso(b.startAt),
      endAt: iso(b.endAt),
      durationMin: b.durationMin,
      status: b.status,
      services: (Array.isArray(b.services) ? (b.services as { serviceId?: string; qty?: number }[]) : []).map((s) => ({
        name: (s.serviceId && input.serviceNames.get(s.serviceId)) ?? null,
        qty: s.qty ?? 1,
      })),
      total: num(b.total),
      paid: num(b.paidAmount),
      currency: 'AMD',
      source: b.source,
      forWhom: b.forWhom,
      visitorName: b.visitorName,
      comment: b.comment,
      cancelReason: b.cancelReason,
      createdAt: iso(b.createdAt),
      deletedAt: iso(b.deletedAt),
    })),
    favorites: cap(input.favorites).map((f) => ({ type: f.targetType, id: f.targetId, newsMuted: f.newsMuted, addedAt: iso(f.createdAt) })),
    reviews: {
      stars: cap(input.starRatings).map((r) => ({ master: input.staffNames.get(r.staffId) ?? null, bookingId: r.bookingId, at: iso(r.createdAt) })),
      masters: cap(input.staffReviews).map((r) => ({
        master: input.staffNames.get(r.staffId) ?? null,
        business: input.businessNames.get(r.businessId) ?? null,
        bookingId: r.bookingId,
        rating: r.rating,
        text: r.text,
        at: iso(r.createdAt),
      })),
      places: cap(input.locationReviews).map((r) => ({ business: input.businessNames.get(r.businessId) ?? null, bookingId: r.bookingId, text: r.text, at: iso(r.createdAt) })),
    },
    diary: cap(input.diary).map((d) => ({ service: d.serviceName, master: d.masterName, date: d.date, amount: num(d.amount), addedAt: iso(d.createdAt) })),
    staffProfiles: input.staff.map((s) => ({
      business: input.businessNames.get(s.businessId) ?? null,
      businessId: s.businessId,
      name: s.name,
      phone: s.phone || null,
      email: s.email,
      role: s.role,
      status: s.status,
      firedAt: iso(s.firedAt),
      deletedAt: iso(s.deletedAt),
    })),
    sessions: input.sessions.map((s) => ({ app: s.app, device: s.device, ip: s.ip, startedAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt) })),
    loginEvents: input.loginEvents.slice(0, DATA_EXPORT_LOGIN_EVENTS).map((e) => ({
      at: iso(e.at),
      method: e.method,
      channel: e.channel,
      app: e.app,
      result: e.result,
      device: e.device,
      ip: e.ip,
    })),
    dataExports: input.dataExports.map((e) => iso(e.at)),
  };
}

export type MyDataExport = ReturnType<typeof buildMyDataExport>;

/** booktime-my-data-2026-10-04.json */
export function dataExportFilename(now = new Date()): string {
  return `booktime-my-data-${now.toISOString().slice(0, 10)}.json`;
}
