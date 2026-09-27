import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { redeemPromo } from '../billing/promo.js';
import { grantFreeDays } from '../billing/subscription.js';
import { uniqueSlug } from '../businesses/business.service.js';
import { defaultRoleTemplate } from '../businesses/views.js';
import { inviteTokenHash } from '../staff/staff.service.js';
import type { ConnectDraftPatchBody } from './platform.schemas.js';

type Tx = Prisma.TransactionClient;
type DraftRow = Prisma.ConnectDraftGetPayload<object>;

interface LocalizedText {
  ru: string;
  [k: string]: unknown;
}
interface ServiceLine {
  templateId: string;
  name: LocalizedText;
  durationMin: number;
  price: number;
  selected: boolean;
}
interface StoredInvite {
  id: string;
  name: string;
  phone: string;
}
type WeekTemplate = Record<string, { from: string; to: string }[]>;

const FREE_DAYS = 30; // F-00-019: всем, кого подключили на визите
const INVITE_TTL_DAYS = 14; // как staff.service.ts createInvite
const HOUR = 36e5;

/** Готовые услуги сферы (F-00-083) — скопировано с фронта (src/api/platform/connect.ts): статичный контент,
 * репозитории разные, тот же приём, что FIRST_AWARD_SPHERES/PLACEMENTS в этом же этапе. */
const SPHERE_SERVICE_TEMPLATES: Record<string, Omit<ServiceLine, 'selected'>[]> = {
  nails: [
    { templateId: 'nails_manicure', name: { ru: 'Маникюр классический', en: 'Classic manicure' }, durationMin: 60, price: 6000 },
    { templateId: 'nails_gel', name: { ru: 'Покрытие гель-лаком', en: 'Gel polish' }, durationMin: 90, price: 9000 },
    { templateId: 'nails_pedicure', name: { ru: 'Педикюр', en: 'Pedicure' }, durationMin: 75, price: 8000 },
  ],
  barber: [
    { templateId: 'barber_cut', name: { ru: 'Стрижка мужская', en: "Men's haircut" }, durationMin: 40, price: 5000 },
    { templateId: 'barber_beard', name: { ru: 'Оформление бороды', en: 'Beard trim' }, durationMin: 25, price: 3000 },
  ],
  hair: [
    { templateId: 'hair_cut', name: { ru: 'Стрижка', en: 'Haircut' }, durationMin: 50, price: 6000 },
    { templateId: 'hair_color', name: { ru: 'Окрашивание', en: 'Coloring' }, durationMin: 150, price: 20000 },
  ],
  cosmetology: [
    { templateId: 'cosm_clean', name: { ru: 'Чистка лица', en: 'Facial cleansing' }, durationMin: 60, price: 12000 },
    { templateId: 'cosm_peel', name: { ru: 'Пилинг', en: 'Peeling' }, durationMin: 45, price: 10000 },
  ],
  massage: [
    { templateId: 'mass_relax', name: { ru: 'Массаж расслабляющий', en: 'Relaxing massage' }, durationMin: 60, price: 10000 },
    { templateId: 'mass_sport', name: { ru: 'Спортивный массаж', en: 'Sports massage' }, durationMin: 60, price: 12000 },
  ],
  dental: [
    { templateId: 'dental_check', name: { ru: 'Консультация', en: 'Check-up' }, durationMin: 30, price: 5000 },
    { templateId: 'dental_clean', name: { ru: 'Профессиональная чистка', en: 'Professional cleaning' }, durationMin: 60, price: 15000 },
  ],
  fitness: [{ templateId: 'fit_single', name: { ru: 'Персональная тренировка', en: 'Personal training' }, durationMin: 60, price: 8000 }],
  carwash: [
    { templateId: 'wash_full', name: { ru: 'Полная мойка кузова', en: 'Full body wash' }, durationMin: 45, price: 4000 },
    { templateId: 'wash_interior', name: { ru: 'Химчистка салона', en: 'Interior deep clean' }, durationMin: 90, price: 15000 },
  ],
  general: [{ templateId: 'general_basic', name: { ru: 'Услуга', en: 'Service' }, durationMin: 60, price: 5000 }],
};

function templateLines(sphereId: string | undefined): ServiceLine[] {
  const tpl = sphereId ? SPHERE_SERVICE_TEMPLATES[sphereId] : undefined;
  return tpl ? tpl.map((t) => ({ ...t, selected: true })) : [];
}

/** Часы по умолчанию: пн–пт 10–19, сб 11–17, вс выходной (как defaultConnectWeek фронта, 0 = пн) */
function defaultWeek(): WeekTemplate {
  const workday = [{ from: '10:00', to: '19:00' }];
  return { '0': workday, '1': workday, '2': workday, '3': workday, '4': workday, '5': [{ from: '11:00', to: '17:00' }], '6': [] };
}

function view(row: DraftRow) {
  return {
    id: row.id,
    status: row.status as 'draft' | 'done',
    step: row.step,
    kind: row.kind as 'individual' | 'salon',
    name: row.name,
    sphereId: row.sphereId ?? undefined,
    ownerName: row.ownerName,
    ownerPhone: row.ownerPhone,
    district: row.district ?? undefined,
    address: row.address,
    yandexMapsUrl: row.yandexMapsUrl,
    coords: row.lat !== null && row.lng !== null ? { lat: Number(row.lat), lng: Number(row.lng) } : undefined,
    coordsAt: row.coordsAt ? utcToLocal(row.coordsAt) : undefined,
    photos: (row.photos ?? []) as unknown as string[],
    invites: (row.invites ?? []) as unknown as StoredInvite[],
    services: (row.services ?? []) as unknown as ServiceLine[],
    hours: (row.hours ?? {}) as unknown as WeekTemplate,
    calendarMode: (row.calendarMode ?? undefined) as 'free' | 'busy' | undefined,
    promoCodeId: row.promoCodeId ?? undefined,
    visitId: row.visitId ?? undefined,
    responsibleId: row.responsibleId,
    businessId: row.businessId ?? undefined,
    startedAt: utcToLocal(row.startedAt),
    finishedAt: row.finishedAt ? utcToLocal(row.finishedAt) : undefined,
  };
}

/** Черновик + патч последнего шага слиты в один набор плоских значений — читает и `save`, и `finish` (F-00-176) */
interface Derived {
  step: number;
  kind: 'individual' | 'salon';
  name: string;
  sphereId?: string;
  ownerName: string;
  ownerPhone: string;
  district?: string;
  address: string;
  yandexMapsUrl: string;
  coords?: { lat: number; lng: number };
  coordsAt?: Date;
  photos: string[];
  invites: StoredInvite[];
  services: ServiceLine[];
  hours: WeekTemplate;
  calendarMode?: 'free' | 'busy';
  promoCodeId?: string;
  responsibleId: string;
  visitId?: string;
}

function derive(row: DraftRow, patch: ConnectDraftPatchBody): Derived {
  const kind = (patch.kind ?? row.kind) as 'individual' | 'salon';
  const sphereId = patch.sphereId !== undefined ? patch.sphereId || undefined : (row.sphereId ?? undefined);
  const sphereChanged = patch.sphereId !== undefined && patch.sphereId !== (row.sphereId ?? undefined);
  return {
    step: patch.step ?? row.step,
    kind,
    name: patch.name ?? row.name,
    sphereId,
    ownerName: patch.ownerName ?? row.ownerName,
    ownerPhone: patch.ownerPhone ?? row.ownerPhone,
    district: patch.district !== undefined ? patch.district || undefined : (row.district ?? undefined),
    address: patch.address ?? row.address,
    yandexMapsUrl: patch.yandexMapsUrl ?? row.yandexMapsUrl,
    coords: patch.coords ?? (row.lat !== null && row.lng !== null ? { lat: Number(row.lat), lng: Number(row.lng) } : undefined),
    coordsAt: patch.coords !== undefined ? new Date() : (row.coordsAt ?? undefined),
    photos: patch.photos ?? ((row.photos ?? []) as unknown as string[]),
    invites: (row.invites ?? []) as unknown as StoredInvite[], // управляется только addInvite/removeInvite, не патчем
    // Сменили сферу — типовые услуги новой сферы, все отмечены (F-00-083); прежние не годятся
    services: sphereChanged ? templateLines(sphereId) : ((patch.services as ServiceLine[] | undefined) ?? ((row.services ?? []) as unknown as ServiceLine[])),
    hours: (patch.hours as unknown as WeekTemplate | undefined) ?? ((row.hours ?? {}) as unknown as WeekTemplate),
    // F-00-052: салону календарь всегда 'free' — снимается независимо от патча, как во фронте
    calendarMode: kind === 'salon' ? undefined : ((patch.calendarMode as 'free' | 'busy' | undefined) ?? (row.calendarMode as 'free' | 'busy' | null | undefined) ?? undefined),
    promoCodeId: patch.promoCodeId !== undefined ? patch.promoCodeId || undefined : (row.promoCodeId ?? undefined),
    responsibleId: patch.responsibleId ?? row.responsibleId,
    visitId: row.visitId ?? undefined,
  };
}

/** Чего не хватает, чтобы подключить (connectIssues фронта, F-00-052) */
function issuesOf(f: Derived): string[] {
  const issues: string[] = [];
  if (!f.name.trim()) issues.push('name');
  if (!f.sphereId) issues.push('sphere');
  if (!normalizePhone(f.ownerPhone)) issues.push('ownerPhone');
  if (!f.services.some((s) => s.selected)) issues.push('services');
  if (f.kind === 'individual' && !f.calendarMode) issues.push('calendarMode');
  return issues;
}

function toColumns(f: Derived): Prisma.ConnectDraftUpdateInput {
  return {
    step: f.step,
    kind: f.kind,
    name: f.name,
    sphereId: f.sphereId ?? null,
    ownerName: f.ownerName,
    ownerPhone: f.ownerPhone,
    district: f.district ?? null,
    address: f.address,
    yandexMapsUrl: f.yandexMapsUrl,
    lat: f.coords ? f.coords.lat.toFixed(6) : null,
    lng: f.coords ? f.coords.lng.toFixed(6) : null,
    coordsAt: f.coordsAt ?? null,
    photos: f.photos as unknown as Prisma.InputJsonValue,
    services: f.services as unknown as Prisma.InputJsonValue,
    hours: f.hours as unknown as Prisma.InputJsonValue,
    calendarMode: f.calendarMode ?? null,
    promoCodeId: f.promoCodeId ?? null,
    responsibleId: f.responsibleId,
  };
}

/**
 * Подключение салона на визите за 10 минут (docs/backend/02 §19, 06 §1; F-00-176, F-00-171, F-00-052). Черновик по
 * шагам живёт в `ConnectDraft`; «Подключить» создаёт бизнес+филиал+владельца+мастеров-приглашения+услуги+часы+
 * фото(auto)+бесплатный месяц+промокод одной транзакцией (PLAN §4.2 — как «замок на мастера», здесь без блокировки
 * строк: бизнес только что создан, пересечений времени с ним ещё ни у кого нет). Владелец входит на живом сайте
 * своим телефоном без отдельного приглашения — привязку делает `AuthService.verifyCode` (F-00-176, см. её докстринг).
 */
@Injectable()
export class ConnectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.connectDraft.findMany({ where: { status: 'draft' }, orderBy: { startedAt: 'desc' } });
    return rows.map(view);
  }

  async get(id: string) {
    const row = await this.prisma.connectDraft.findUnique({ where: { id } });
    if (!row) throw new ApiError('not_found', 'Draft not found');
    return view(row);
  }

  async start(ctx: RequestContext, input: { visitId?: string }) {
    const visit = input.visitId ? await this.prisma.salesVisit.findUnique({ where: { id: input.visitId } }) : null;
    const row = await this.prisma.connectDraft.create({
      data: {
        id: newId('connectDraft'),
        status: 'draft',
        step: 0,
        kind: 'salon',
        name: visit?.placeName ?? '',
        sphereId: visit?.sphereId ?? null,
        ownerName: visit?.contactName ?? '',
        ownerPhone: visit?.phone ? (normalizePhone(visit.phone) ?? visit.phone) : '',
        district: visit?.district ?? null,
        address: visit?.address ?? '',
        yandexMapsUrl: '',
        photos: [],
        invites: [],
        services: templateLines(visit?.sphereId ?? undefined) as unknown as Prisma.InputJsonValue,
        hours: defaultWeek() as unknown as Prisma.InputJsonValue,
        visitId: visit?.id ?? null,
        // Визит уже назначен кому-то из команды — тот и ведёт подключение; иначе тот, кто начал черновик
        responsibleId: visit?.responsibleId || ctx.session!.userId,
      },
    });
    return view(row);
  }

  async save(id: string, patch: ConnectDraftPatchBody) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.connectDraft.findUnique({ where: { id } });
      if (!row) throw new ApiError('not_found', 'Draft not found');
      if (row.status !== 'draft') throw new ApiError('conflict', 'Draft already finished');
      const updated = await tx.connectDraft.update({ where: { id }, data: toColumns(derive(row, patch)) });
      return view(updated);
    });
  }

  async delete(id: string) {
    await this.prisma.connectDraft.deleteMany({ where: { id } });
  }

  async addInvite(draftId: string, input: { name: string; phone: string }) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('validation', 'Bad phone', { phone: 'invalid' });
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.connectDraft.findUnique({ where: { id: draftId } });
      if (!row) throw new ApiError('not_found', 'Draft not found');
      if (row.status !== 'draft') throw new ApiError('conflict', 'Draft already finished');
      const invites = (row.invites ?? []) as unknown as StoredInvite[];
      if (invites.some((i) => i.phone === phone)) throw new ApiError('duplicate', 'Already invited');
      invites.push({ id: newId('connectInvite'), name: input.name.trim(), phone });
      const updated = await tx.connectDraft.update({ where: { id: draftId }, data: { invites: invites as unknown as Prisma.InputJsonValue } });
      return view(updated);
    });
  }

  async removeInvite(draftId: string, inviteId: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.connectDraft.findUnique({ where: { id: draftId } });
      if (!row) throw new ApiError('not_found', 'Draft not found');
      const invites = ((row.invites ?? []) as unknown as StoredInvite[]).filter((i) => i.id !== inviteId);
      const updated = await tx.connectDraft.update({ where: { id: draftId }, data: { invites: invites as unknown as Prisma.InputJsonValue } });
      return view(updated);
    });
  }

  /** Виден ли салон клиентам и чего не хватает (getConnectResult/ConnectHandoff — staffClientVisibility фронта,
   * упрощённо на уровне только что подключённого бизнеса, а не произвольного мастера сети). */
  private async catalogState(businessId: string): Promise<{ inCatalog: boolean; catalogReasons: string[] }> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) return { inCatalog: false, catalogReasons: ['staff_inactive'] };
    const owner = business.ownerStaffId ? await this.prisma.staff.findUnique({ where: { id: business.ownerStaffId } }) : null;
    if (!owner || owner.status !== 'active') return { inCatalog: false, catalogReasons: ['staff_inactive'] };
    if (business.status !== 'active') return { inCatalog: false, catalogReasons: ['business_inactive'] };
    const [servicesCount, scheduleCount] = await Promise.all([
      this.prisma.service.count({ where: { businessId, active: true } }),
      this.prisma.workSchedule.count({ where: { staffId: owner.id } }),
    ]);
    const ownerPhotos = Array.isArray(owner.photos) ? (owner.photos as unknown[]) : [];
    const bizPhotos = Array.isArray(business.photos) ? (business.photos as unknown[]) : [];
    const hasPhoto = ownerPhotos.length > 0 || bizPhotos.length > 0;
    const reasons: string[] = [];
    if (!servicesCount) reasons.push('no_services');
    if (!scheduleCount) reasons.push('no_schedule');
    if (!hasPhoto) reasons.push('no_photo');
    if (owner.calendarVisibility === 'link') reasons.push('link_only');
    if (owner.calendarVisibility === 'mine') reasons.push('mine_only');
    return { inCatalog: reasons.length === 0, catalogReasons: reasons };
  }

  /** Итог подключения — переживает перезагрузку (`?done=<businessId>`, F-00-176) */
  async getResult(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new ApiError('not_found', 'Business not found');
    const [meta, sub, servicesCount, staffCount] = await Promise.all([
      this.prisma.bizMeta.findUnique({ where: { businessId } }),
      this.prisma.subscription.findUnique({ where: { businessId } }),
      this.prisma.service.count({ where: { businessId } }),
      this.prisma.staff.count({ where: { businessId, deletedAt: null } }),
    ]);
    const promo = meta?.promoCodeId ? await this.prisma.promoCode.findUnique({ where: { id: meta.promoCodeId } }) : null;
    const catalog = await this.catalogState(businessId);
    const photos = Array.isArray(business.photos) ? (business.photos as unknown[]).length : 0;
    return {
      businessId: business.id,
      name: business.name,
      slug: business.slug,
      kind: business.kind as 'individual' | 'salon',
      ownerPhone: business.phone,
      freeUntil: sub?.freeUntil ? utcToLocalDate(sub.freeUntil) : undefined,
      services: servicesCount,
      staff: staffCount,
      photos,
      promoCode: promo?.code,
      ...catalog,
    };
  }

  /**
   * «Подключить» (F-00-176): одна транзакция, ничего не остаётся на полпути. Приглашённые мастера получают
   * настоящий staff_invite (F-00-042, роль всегда master — как и в мок-контракте ConnectInvite); владелец получает
   * доступ иначе — телефонным входом без инвайта (см. AuthService.verifyCode).
   */
  async finish(ctx: RequestContext, id: string, patch: ConnectDraftPatchBody) {
    const actorId = ctx.session!.userId;
    const { businessId } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.connectDraft.findUnique({ where: { id } });
      if (!row) throw new ApiError('not_found', 'Draft not found');
      if (row.status !== 'draft') throw new ApiError('conflict', 'Draft already finished');
      const f = derive(row, patch);
      const issues = issuesOf(f);
      const ownerPhone = normalizePhone(f.ownerPhone);
      if (issues.length || !f.sphereId || !ownerPhone) throw new ApiError('connect_incomplete', issues.join(','));
      const sphereId = f.sphereId;

      const now = new Date();
      const name = f.name.trim();
      const businessId = newId('business');
      const ownerId = newId('staff');
      const locationId = newId('location');
      const categoryId = newId('serviceCategory');
      const lines = f.services.filter((s) => s.selected);
      const serviceIds = lines.map(() => newId('service'));
      // F-00-052: салону — «всё свободно»; индивидуал выбрал сам (issuesOf уже проверил, что выбор есть)
      const calendarMode = f.kind === 'salon' ? 'free' : (f.calendarMode ?? 'free');

      const slug = await uniqueSlug(tx, name);

      await tx.business.create({
        data: {
          id: businessId,
          kind: f.kind,
          name,
          slug,
          sphereIds: [sphereId],
          ownerStaffId: ownerId,
          phone: ownerPhone,
          photos: f.photos as unknown as Prisma.InputJsonValue,
          status: 'draft', // grantFreeDays публикует ниже, той же транзакцией
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
      await tx.location.create({
        data: {
          id: locationId,
          businessId,
          name: { ru: name },
          address: { ru: f.address.trim() },
          district: f.district ?? 'kentron',
          yandexMapsUrl: f.yandexMapsUrl.trim() || null,
          lat: f.coords ? f.coords.lat.toFixed(6) : null,
          lng: f.coords ? f.coords.lng.toFixed(6) : null,
          coordsAt: f.coordsAt ?? null,
          openHours: f.hours as unknown as Prisma.InputJsonValue,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
      await tx.staff.create({
        data: {
          id: ownerId,
          businessId,
          name: f.ownerName.trim() || name,
          phone: ownerPhone,
          role: 'owner',
          roleTemplateId: defaultRoleTemplate('owner'),
          status: 'active',
          sphereIds: [sphereId],
          photos: f.photos as unknown as Prisma.InputJsonValue, // C4: портфолио, снятое на визите, уходит с мастером
          materials: [],
          workplaces: ['salon'],
          serviceIds: serviceIds as unknown as Prisma.InputJsonValue,
          calendarMode,
          confirmMode: 'manual', // В-03
          colorIndex: 1,
          hiredAt: utcToLocalDate(now),
          createdBy: actorId,
          updatedBy: actorId,
          locations: { create: [{ locationId }] },
        },
      });
      // Без графика мастер не попадёт ни в одно свободное окно — салон был бы невидим в каталоге (F-00-072)
      await tx.workSchedule.create({
        data: {
          id: newId('schedule'),
          businessId,
          staffId: ownerId,
          locationId,
          workplace: 'salon',
          week: f.hours as unknown as Prisma.InputJsonValue,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });

      // Приглашённые мастера — настоящий staff_invite (F-00-042, как staff.service.ts add()), не своя схема входа
      let colorSeed = 0;
      for (const invite of f.invites) {
        colorSeed += 1;
        const invPhone = normalizePhone(invite.phone) ?? invite.phone;
        const staffId = newId('staff');
        await tx.staff.create({
          data: {
            id: staffId,
            businessId,
            name: invite.name || invPhone,
            phone: invPhone,
            role: 'master',
            roleTemplateId: defaultRoleTemplate('master'),
            status: 'invited',
            sphereIds: [sphereId],
            photos: [],
            materials: [],
            workplaces: ['salon'],
            serviceIds: [],
            calendarMode: 'free',
            confirmMode: 'manual',
            colorIndex: (colorSeed % 8) + 1,
            hiredAt: utcToLocalDate(now),
            createdBy: actorId,
            updatedBy: actorId,
            locations: { create: [{ locationId }] },
          },
        });
        const token = randomBytes(24).toString('base64url');
        await tx.staffInvite.create({
          data: {
            id: newId('staffInvite'),
            businessId,
            staffId,
            role: 'master',
            phone: invPhone,
            email: null,
            tokenHash: inviteTokenHash(token),
            expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 24 * HOUR),
            createdBy: actorId,
            updatedBy: actorId,
          },
        });
        // Ссылку-инвайт этот токен даёт (inviteUrl), но ConnectResult её не несёт (как и мок): владелец, войдя
        // в свой кабинет по телефону (см. AuthService.verifyCode), увидит мастера «приглашён» на странице
        // «Сотрудники» и там же перевыпустит ссылку (staff.service.ts reissueInvite, этап 3) — готовый инструмент,
        // не новый; здесь важно только то, что строка приглашения существует и её токен рабочий.
      }

      await tx.serviceCategory.create({
        data: { id: categoryId, businessId, name: { ru: 'Услуги', en: 'Services' }, sortOrder: 1, createdBy: actorId, updatedBy: actorId },
      });
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const serviceId = serviceIds[i]!;
        await tx.service.create({
          data: {
            id: serviceId,
            businessId,
            categoryId,
            sphereId,
            name: line.name as unknown as Prisma.InputJsonValue,
            kind: 'individual',
            durationMin: line.durationMin,
            priceMin: BigInt(Math.trunc(line.price)),
            photos: [],
            materials: [],
            staffIds: [ownerId] as unknown as Prisma.InputJsonValue,
            workplaces: ['salon'],
            onlineBookable: true,
            active: true,
            order: i + 1,
            createdBy: actorId,
            updatedBy: actorId,
          },
        });
      }

      // Фото сняты нами на визите — без очереди, видны сразу (F-00-171). ModerationService.submit не годится:
      // он открывает свой this.prisma, а не tx — здесь нужен ОДИН атомарный проход, поэтому auto-запись инлайн.
      // refId — короткий ключ (VarChar(64)), НЕ сама картинка (комментарий ModerationItem в schema.prisma): мок
      // кладёт туда url потому что его демо-фото и есть короткая строка; настоящее фото — data URI до 4 МБ, поэтому
      // здесь свой короткий id (newId('file')), imageUrl несёт саму картинку (LongText).
      if (f.photos.length) {
        await tx.moderationItem.createMany({
          data: f.photos.map((url) => ({
            id: newId('moderationItem'),
            kind: 'salonPhoto',
            businessId,
            refId: newId('file'),
            imageUrl: url,
            status: 'auto',
            source: 'visit',
            submittedAt: now,
            decidedAt: now,
            history: [{ id: newId('moderationEvent'), at: utcToLocal(now), kind: 'auto' }] as unknown as Prisma.InputJsonValue,
          })),
        });
      }

      // Подписка: 30 дней всем, кого подключили на визите (F-00-019) — безусловно, независимо от промокода
      await grantFreeDays(tx, { businessId, days: FREE_DAYS, reason: 'visit', by: actorId });
      if (f.promoCodeId) {
        const promoRow = await tx.promoCode.findUnique({ where: { id: f.promoCodeId } });
        if (!promoRow) throw new ApiError('promo_not_found', 'Promo not found');
        const { promo, redemption } = await redeemPromo(tx, promoRow.code, businessId);
        if (promo.kind === 'freeMonth') {
          await grantFreeDays(tx, { businessId, days: promo.freeDays ?? 30, reason: 'promo', by: actorId, note: promo.code });
          await tx.subscription.update({ where: { businessId }, data: { promoCode: promo.code, promoRedemptionId: redemption.id } });
        } else {
          await tx.subscription.update({
            where: { businessId },
            data: { promoCode: promo.code, promoRedemptionId: redemption.id, promoTiers: promo.tiers as Prisma.InputJsonValue },
          });
        }
      }

      await tx.bizMeta.upsert({
        where: { businessId },
        create: { businessId, source: 'visit', responsibleId: f.responsibleId, promoCodeId: f.promoCodeId ?? null },
        update: { source: 'visit', responsibleId: f.responsibleId, promoCodeId: f.promoCodeId ?? null },
      });

      if (f.visitId) {
        const visit = await tx.salesVisit.findUnique({ where: { id: f.visitId } });
        if (visit) {
          const history = [...((visit.history ?? []) as unknown[]), { id: newId('salesVisitEvent'), at: utcToLocal(now), kind: 'connected' }];
          await tx.salesVisit.update({
            where: { id: visit.id },
            data: { status: 'connected', businessId, callbackDate: null, history: history as unknown as Prisma.InputJsonValue },
          });
        }
      }

      await tx.connectDraft.update({ where: { id }, data: { ...toColumns(f), status: 'done', businessId, finishedAt: now } });
      await this.audit.record(tx, ctx, {
        action: 'create',
        entityType: 'business',
        entityId: businessId,
        businessId,
        after: { name, kind: f.kind, sphereIds: [sphereId], slug, source: 'visit' },
      });

      return { businessId };
    });

    return this.getResult(businessId);
  }
}
