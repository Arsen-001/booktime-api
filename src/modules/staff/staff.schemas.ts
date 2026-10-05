import { z } from 'zod';
import { localized, staffOut } from '../businesses/business.schemas.js';

const strList = z.array(z.string().max(4_000_000)).max(50);

export const addStaffBody = z.object({
  locationIds: z.array(z.string().max(32)).max(50).default([]),
  name: z.string().max(120),
  role: z.enum(['owner', 'admin', 'master']),
  phone: z.string().max(40).optional(),
  email: z.string().max(160).optional(),
  position: z.string().max(120).optional(),
  specialty: z.string().max(120).optional(),
  sphereIds: z.array(z.string().max(40)).max(20).default([]),
  asAssistant: z.boolean().optional(),
  grantAccess: z.boolean().optional(),
  roleTemplateId: z.enum(['systemManager', 'viewer', 'specialist', 'admin', 'callCenter', 'accountant', 'manager', 'owner']).optional(),
});
export type AddStaffBody = z.infer<typeof addStaffBody>;

export const patchStaffBody = z
  .object({
    name: z.string().max(120),
    phone: z.string().max(40),
    email: z.string().max(160).nullable(),
    /** Название должности; нет в каталоге — создаётся (F-10-048); '' — снять */
    position: z.string().max(120).nullable(),
    specialty: localized.nullable(),
    bio: localized.nullable(),
    sphereIds: z.array(z.string().max(40)).max(20),
    avatarUrl: z.string().max(4_000_000).nullable(),
    photos: strList,
    materials: z.array(z.string().max(200)).max(100),
    workplaces: z.array(z.enum(['salon', 'home', 'visit', 'gym', 'online'])).max(5),
    homeAddress: z.string().max(300).nullable(),
    homeDistrict: z.string().max(40).nullable(),
    visitDistricts: z.array(z.string().max(40)).max(40).nullable(),
    accepts: z.enum(['all', 'women', 'men']),
    calendarVisibility: z.enum(['all', 'link', 'mine']),
    calendarMode: z.enum(['free', 'busy']),
    confirmMode: z.enum(['instant', 'manual']),
    colorIndex: z.number().int().min(1).max(8),
    serviceIds: z.array(z.string().max(32)).max(500),
    callHours: z.object({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).nullable(),
    hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    onlineBookingEnabled: z.boolean(),
    hiddenInJournal: z.boolean(),
    assistantOnly: z.boolean(),
    journalMarkupMin: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(90), z.literal(120)]).nullable(),
    prepayment: z.object({ amount: z.number().int().min(0), percent: z.number().int().min(1).max(100).optional(), timeoutMin: z.number().int().min(0), requisites: z.string().max(300), onlyAfterNoShows: z.object({ count: z.number().int().min(1).max(10), months: z.number().int().min(1).max(24) }).optional() }).nullable(),
    bookingRules: z.record(z.string(), z.unknown()).nullable(),
    contacts: z.record(z.string(), z.unknown()).nullable(),
    locationIds: z.array(z.string().max(32)).max(50),
  })
  .partial();
export type PatchStaffBody = z.infer<typeof patchStaffBody>;

export const orderBody = z.object({ ids: z.array(z.string().max(32)).max(500) });
export const dismissBody = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().max(500).default('') });
export const accessBody = z.object({ enabled: z.boolean() });
export const accessInfoBody = z.object({ info: z.string().max(500) });
export const roleTemplateBody = z.object({ roleTemplateId: z.enum(['systemManager', 'viewer', 'specialist', 'admin', 'callCenter', 'accountant', 'manager', 'owner']) });
export const ipBody = z.object({ enabled: z.boolean(), ranges: z.array(z.string().max(64)).max(50) });
export const loginBody = z.object({ login: z.string().max(64), password: z.string().max(128) });
export const transferAccessBody = z.object({ fromStaffId: z.string().max(32), toStaffId: z.string().max(32), deleteSource: z.boolean().default(false) });
export const transferOwnerBody = z.object({ toStaffId: z.string().max(32) });
export const rightsBody = z.object({ fine: z.array(z.string().max(80)).max(500), coarse: z.array(z.string().max(40)).max(60) });
export const scopesBody = z.object({ scopes: z.record(z.string(), z.unknown()) });
export const jsonBody = z.object({ value: z.record(z.string(), z.unknown()) });
export const positionBody = z.object({ name: z.string().max(120), description: z.string().max(500).optional() });
export const exportLogBody = z.object({
  reportType: z.enum(['clients', 'bookings', 'loyaltyCards', 'memberships', 'deposits', 'certificates', 'staffReport', 'customReport']),
  isImport: z.boolean().default(false),
  operationType: z.enum(['fileUpload', 'excelCopy', 'emailLink', 'browserDownload']),
});

// ─────────── ответы ───────────

export const staffRowOut = z.object({ staff: staffOut, order: z.number() });
export const inviteOut = z.object({
  id: z.string(),
  businessId: z.string(),
  staffId: z.string(),
  role: z.enum(['admin', 'master']),
  phone: z.string().optional(),
  email: z.string().optional(),
  status: z.enum(['pending', 'accepted', 'revoked']),
  createdAt: z.string(),
});
export const accessOut = z.object({
  access: z.object({ enabled: z.boolean(), info: z.string().optional(), roleTemplateId: z.string(), ipRestriction: ipBody.optional() }),
  invite: inviteOut.optional(),
  staff: staffOut,
  /** Вход по логину администратора (F-00-034/038): пароль не отдаётся; mustChangePassword — выданный ещё не сменён */
  passwordLogin: z.object({ login: z.string(), mustChangePassword: z.boolean(), changedAt: z.string().optional(), issuedAt: z.string() }).optional(),
});
export const addStaffOut = z.object({ staff: staffOut, inviteLink: z.string().nullable() });
export const reissueOut = z.object({ invite: inviteOut, link: z.string() });
export const dismissalOut = z
  .object({ staffId: z.string(), date: z.string(), reason: z.string(), firedAt: z.string(), restore: z.enum(['immediate', 'blocked', 'available']) })
  .nullable();
export const deletedOut = z.object({ id: z.string(), businessId: z.string(), snapshot: staffOut, access: z.unknown(), deletedAt: z.string() });
export const rightsOut = z.object({ fine: z.array(z.string()).nullable(), coarse: z.array(z.string()).nullable(), scopes: z.record(z.string(), z.unknown()) });
export const positionOut = z.object({
  id: z.string(),
  businessId: z.string(),
  name: localized,
  description: z.string().optional(),
  order: z.number(),
  createdAt: z.string(),
});
export const positionRowOut = positionOut.extend({ staffCount: z.number(), staffNames: z.array(z.string()) });
export const auditOut = z.object({
  id: z.string(),
  businessId: z.string(),
  entity: z.string(),
  entityId: z.string(),
  action: z.string(),
  actorStaffId: z.string().optional(),
  actorLabel: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  at: z.string(),
});
export const exportOut = z.object({
  id: z.string(),
  businessId: z.string(),
  actorStaffId: z.string().optional(),
  actorLabel: z.string(),
  reportType: z.string(),
  isImport: z.boolean(),
  operationType: z.string(),
  at: z.string(),
});
export const loginRowOut = z.object({
  id: z.string(),
  businessId: z.string(),
  staffId: z.string(),
  staffLabel: z.string(),
  at: z.string(),
  device: z.string(),
  ip: z.string(),
  newDevice: z.boolean(),
});
