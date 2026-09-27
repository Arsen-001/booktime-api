import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { newId } from '../../common/ids/ids.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { nowLocal, utcToLocal } from '../../common/time/time.js';
import type { Business, Staff } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AvailabilityService } from '../availability/availability.service.js';
import type { FreeSlot } from '../availability/engine.js';
import { businessView, locationView } from '../businesses/views.js';
import { JournalService } from '../journal/journal.service.js';
import { sanitizePublicStaff } from '../online/online.service.js';
import { categoryView, serviceView } from '../services/services.views.js';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const norm = (s: string): string => s.trim().toLowerCase();

/** Синонимы поиска «что ищете?» на трёх языках → сфера (F-00-110, B22 — черновик до справочника в базе) */
const SPHERE_SYNONYMS: Record<string, string[]> = {
  nails: ['ноготь', 'ногти', 'маникюр', 'педикюр', 'гель лак', 'nail', 'nails', 'manicure', 'pedicure', 'եղունգ'],
  barber: ['барбер', 'стрижка', 'борода', 'barber', 'haircut', 'beard', 'մորուք'],
  hair: ['волос', 'парикмахер', 'окрашивание', 'hair', 'hairdresser', 'մազ'],
  cosmetology: ['косметолог', 'чистка лица', 'cosmetology', 'facial', 'կոսմետոլոգ'],
  massage: ['массаж', 'massage', 'մերսում'],
  dental: ['зуб', 'стоматолог', 'dental', 'teeth', 'ատամ'],
  fitness: ['тренер', 'фитнес', 'fitness', 'trainer', 'ֆիթնես'],
  carwash: ['мойка', 'автомойка', 'carwash', 'car wash', 'լվացում'],
};

const CATALOG_DAYS = 14;
const CATALOG_SLOT_LIMIT = 3;
const CATALOG_DEFAULT_DURATION = 30;
const MASTER_SLOT_LIMIT = 8;
/** Постоянный клиент (В-38, F-00-117) — то же правило, что публичная страница online (этап 8) */
const REGULAR_VISITS_THRESHOLD = 3;
/** Верхний предел кандидатов, которым каталог живьём считает окна за один запрос (Р20: до 500 салонов первый год;
 * дальше — кэш `04 §6` заводить отдельной таблицей, здесь эту роль уже играет versioned Redis-кеш AvailabilityService) */
const CATALOG_CANDIDATE_CAP = 300;

export interface CatalogQuery {
  search?: string;
  sphereId?: string;
  district?: string;
  workplace?: string;
  accepts?: string;
  material?: string;
  freeToday?: boolean;
  freeTomorrow?: boolean;
  lat?: number;
  lng?: number;
  businessId?: string;
  limit?: number;
}

const STAFF_INCLUDE = { locations: { select: { locationId: true } } } as const;
type StaffRow = Staff & { locations: { locationId: string }[] };

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function dedupeSlots(slots: FreeSlot[]): FreeSlot[] {
  const seen = new Set<string>();
  return slots.filter((s) => {
    const key = `${s.locationId}-${s.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Раздел «client» (docs/backend/02 §2, PLAN §6 №9): каталог «кто когда свободен», карточки мастера/места,
 * окна и дни для потока записи, оттенок, срок бесплатной отмены, «не нашли», «попросить перезвонить». Свободные
 * окна считает тот же `AvailabilityService`, что журнал/график (этапы 6–7) и виджет онлайн-записи (этап 8) — его
 * `freeSlots`/`nearestSlots` уже кешируются в Redis с версией бизнеса (04 §6), отдельная таблица кеша не нужна.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly journal: JournalService,
  ) {}

  private async candidateStaff(businessId?: string): Promise<StaffRow[]> {
    const where: Prisma.StaffWhereInput = {
      status: 'active',
      deletedAt: null,
      onlineBookingEnabled: true,
      // F-00-108: «По ссылке» и «Только мои» не в поиске (В-22 фильтрует их дальше по calendarVisibility='mine' —
      // тут достаточно исключить оба нежелательных режима, различие между ними неважно для каталога)
      calendarVisibility: { notIn: ['link', 'mine'] },
    };
    if (businessId) where.businessId = businessId;
    const rows = await this.prisma.staff.findMany({ where, include: STAFF_INCLUDE });
    if (!rows.length) return [];
    const scheduled = new Set((await this.prisma.workSchedule.findMany({ where: { staffId: { in: rows.map((r) => r.id) } }, select: { staffId: true } })).map((r) => r.staffId));
    return rows.filter((r) => scheduled.has(r.id));
  }

  private async businessesOf(rows: StaffRow[]): Promise<Map<string, Business>> {
    const ids = [...new Set(rows.map((r) => r.businessId))];
    const bs = await this.prisma.business.findMany({ where: { id: { in: ids }, status: 'active' } });
    return new Map(bs.map((b) => [b.id, b]));
  }

  private shortestService(services: { id: string; durationMin: number }[]): { id: string; durationMin: number } | undefined {
    return services.reduce<{ id: string; durationMin: number } | undefined>((best, s) => (!best || s.durationMin < best.durationMin ? s : best), undefined);
  }

  /** Постоянные клиенты мастера — состоявшиеся визиты (В-38, 3+ за 12 мес, как публичная страница online этапа 8) */
  private async countRegulars(staffId: string): Promise<number> {
    const rows = await this.prisma.booking.groupBy({
      by: ['clientId'],
      where: { staffId, deletedAt: null, clientId: { not: null }, status: { notIn: ['cancelled_by_client', 'cancelled_by_master'] } },
      _count: { _all: true },
    });
    return rows.filter((r) => r._count._all >= REGULAR_VISITS_THRESHOLD).length;
  }

  /** «Кто когда свободен»: каталог мастеров с ближайшими окнами (F-00-001, F-00-108…F-00-112) */
  async catalog(q: CatalogQuery): Promise<Record<string, unknown>[]> {
    const todayIso = nowLocal().slice(0, 10);
    const tomorrowIso = nowLocal().slice(0, 10);
    const search = q.search ? norm(q.search) : '';
    const searchSpheres = search
      ? Object.keys(SPHERE_SYNONYMS).filter((sphere) => SPHERE_SYNONYMS[sphere]!.some((word) => norm(word).includes(search) || search.includes(norm(word))))
      : [];

    let rows = await this.candidateStaff(q.businessId);
    if (q.sphereId) rows = rows.filter((s) => arr(s.sphereIds).includes(q.sphereId!));
    if (searchSpheres.length) rows = rows.filter((s) => arr(s.sphereIds).some((sp) => searchSpheres.includes(sp)));
    if (q.accepts) rows = rows.filter((s) => s.accepts === 'all' || s.accepts === q.accepts);
    if (q.workplace) rows = rows.filter((s) => arr(s.workplaces).includes(q.workplace!));
    if (q.material) rows = rows.filter((s) => arr(s.materials).some((m) => norm(m).includes(norm(q.material!))));

    const businesses = await this.businessesOf(rows);
    rows = rows.filter((s) => businesses.has(s.businessId));

    const businessIds = [...new Set(rows.map((r) => r.businessId))];
    const locations = await this.prisma.location.findMany({ where: { businessId: { in: businessIds }, deletedAt: null } });
    if (q.district) rows = rows.filter((s) => locations.some((l) => l.businessId === s.businessId && l.district === q.district));

    const serviceIds = [...new Set(rows.flatMap((s) => arr(s.serviceIds)))];
    const services = await this.prisma.service.findMany({ where: { id: { in: serviceIds }, active: true, onlineBookable: true } });
    const servicesOf = (s: StaffRow) => services.filter((sv) => arr<string>(s.serviceIds).includes(sv.id));

    if (search && !searchSpheres.length) {
      rows = rows.filter((s) => {
        const business = businesses.get(s.businessId)!;
        const bizLocs = locations.filter((l) => l.businessId === s.businessId);
        const nameHit = norm(s.name).includes(search);
        const placeHit = norm(business.name).includes(search) || bizLocs.some((l) => norm((l.name as Record<string, string>).ru ?? '').includes(search));
        const serviceHit = servicesOf(s).some((sv) => norm((sv.name as Record<string, string>).ru ?? '').includes(search));
        return nameHit || placeHit || serviceHit;
      });
    }

    if (rows.length > CATALOG_CANDIDATE_CAP) rows = rows.slice(0, CATALOG_CANDIDATE_CAP);

    const out: Record<string, unknown>[] = [];
    for (const s of rows) {
      const business = businesses.get(s.businessId)!;
      const svcList = servicesOf(s);
      if (!svcList.length) continue; // F-00-072: без опубликованной онлайн-услуги мастер в каталог не попадает
      let matched = svcList;
      if (search && !searchSpheres.length) {
        const filtered = svcList.filter((sv) => norm((sv.name as Record<string, string>).ru ?? '').includes(search));
        if (filtered.length) matched = filtered;
      }
      const service = this.shortestService(matched.length ? matched : svcList);
      const nearest = await this.availability.nearestSlots(business.id, { staffId: s.id, durationMin: service?.durationMin ?? CATALOG_DEFAULT_DURATION, serviceId: service?.id, days: CATALOG_DAYS, limit: CATALOG_SLOT_LIMIT });
      const deduped = dedupeSlots(nearest);
      if (!deduped.length) continue;
      const hotToday = deduped.some((sl) => sl.start.startsWith(todayIso));
      if (q.freeToday && !hotToday) continue;
      if (q.freeTomorrow && !deduped.some((sl) => sl.start.startsWith(tomorrowIso))) continue;
      const bizLocs = locations.filter((l) => l.businessId === business.id);
      const location = bizLocs.find((l) => l.id === deduped[0]?.locationId) ?? bizLocs[0];
      const distanceKm = q.lat !== undefined && q.lng !== undefined && location?.lat != null && location?.lng != null ? haversineKm({ lat: q.lat, lng: q.lng }, { lat: Number(location.lat), lng: Number(location.lng) }) : undefined;
      out.push({
        staff: sanitizePublicStaff(s),
        business: await this.businessOut(business),
        location: location ? locationView(location) : undefined,
        service: service ? serviceView(services.find((sv) => sv.id === service.id)!) : undefined,
        nearestSlots: deduped,
        hotToday,
        boosted: false,
        distanceKm,
      });
    }

    if (q.lat !== undefined && q.lng !== undefined) out.sort((a, b) => ((a.distanceKm as number) ?? Infinity) - ((b.distanceKm as number) ?? Infinity));
    else out.sort((a, b) => (a.nearestSlots as FreeSlot[])[0]!.start.localeCompare((b.nearestSlots as FreeSlot[])[0]!.start));

    return q.limit ? out.slice(0, q.limit) : out;
  }

  private async businessOut(b: Business) {
    const locationIds = (await this.prisma.location.findMany({ where: { businessId: b.id, deletedAt: null }, select: { id: true } })).map((l) => l.id);
    return businessView(b, locationIds);
  }

  // ─────────────────────────── карточка мастера (F-00-123) ───────────────────────────

  async masterCard(staffId: string, viewerAppUserId?: string): Promise<Record<string, unknown>> {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, status: 'active', deletedAt: null }, include: STAFF_INCLUDE });
    if (!staff || !staff.onlineBookingEnabled || staff.calendarVisibility === 'link') throw new ApiError('not_found', 'Staff not found');
    const business = await this.prisma.business.findFirst({ where: { id: staff.businessId, status: 'active' } });
    if (!business) throw new ApiError('not_found', 'Staff not found');
    const locations = await this.prisma.location.findMany({ where: { id: { in: staff.locations.map((l) => l.locationId) }, deletedAt: null } });
    const serviceIds = arr<string>(staff.serviceIds);
    const services = await this.prisma.service.findMany({ where: { id: { in: serviceIds }, active: true, onlineBookable: true } });
    const service = this.shortestService(services);
    // Студия «дома» у частного мастера — до подтверждённой записи только район (F-00-077)
    const workplaces = arr<string>(staff.workplaces);
    const homeOnly = business.kind === 'individual' && workplaces.length === 1 && workplaces[0] === 'home';
    const masterPlaces = locations.map((l) => (homeOnly ? { ...locationView(l), address: { ru: '' }, yandexMapsUrl: undefined, isHome: true } : { ...locationView(l), isHome: homeOnly }));
    const nearest = dedupeSlots(await this.availability.nearestSlots(business.id, { staffId, durationMin: service?.durationMin ?? CATALOG_DEFAULT_DURATION, serviceId: service?.id, days: CATALOG_DAYS, limit: MASTER_SLOT_LIMIT }));
    const starCount = await this.prisma.starRating.count({ where: { staffId } });
    let claimToken: string | undefined;
    const next = nearest[0];
    if (next) {
      // F-00-107: свитч мастера — addClaimLinkToMessage (staff.bookingRules, В-04-соседнее поле, включено по умолчанию)
      const addLink = ((staff.bookingRules as Record<string, unknown> | null)?.addClaimLinkToMessage as boolean | undefined) ?? true;
      if (addLink) {
        const viewer = viewerAppUserId ? await this.prisma.user.findUnique({ where: { id: viewerAppUserId }, select: { name: true, phone: true } }) : null;
        claimToken = await this.journal.mintClaim({ businessId: business.id, staffId, serviceId: service?.id, start: next.start, clientName: viewer?.name, clientPhone: viewer?.phone ?? undefined });
      }
    }
    const contacts = (staff.contacts as Record<string, unknown> | null) ?? { whatsapp: true, callMode: 'always' };
    return {
      staff: sanitizePublicStaff(staff),
      business: await this.businessOut(business),
      locations: masterPlaces,
      services: services.map(serviceView),
      contacts: { ...contacts, phone: contacts.whatsapp || contacts.callMode !== 'messages' ? staff.phone : undefined, callOpenNow: contacts.callMode === 'always' },
      regularsCount: await this.countRegulars(staffId),
      starCount,
      onPlatformSince: utcToLocal(business.createdAt).slice(0, 10),
      nearestSlots: nearest,
      slotService: service ? serviceView(services.find((sv) => sv.id === service.id)!) : undefined,
      claimToken,
    };
  }

  // ─────────────────────────── карточка места (F-14-028) ───────────────────────────

  async placeCard(businessId: string): Promise<Record<string, unknown>> {
    const business = await this.prisma.business.findFirst({ where: { id: businessId, status: 'active' } });
    if (!business) throw new ApiError('not_found', 'Business not found');
    const [locations, categories, staffRows] = await Promise.all([
      this.prisma.location.findMany({ where: { businessId, deletedAt: null } }),
      this.prisma.serviceCategory.findMany({ where: { businessId } }),
      this.prisma.staff.findMany({ where: { businessId, status: 'active', deletedAt: null, onlineBookingEnabled: true, calendarVisibility: { notIn: ['link', 'mine'] } }, include: STAFF_INCLUDE }),
    ]);
    const scheduled = new Set((await this.prisma.workSchedule.findMany({ where: { staffId: { in: staffRows.map((r) => r.id) } }, select: { staffId: true } })).map((r) => r.staffId));
    const staffList = staffRows.filter((s) => scheduled.has(s.id));
    const visibleIds = new Set(staffList.map((s) => s.id));
    const services = await this.prisma.service.findMany({ where: { businessId, active: true, onlineBookable: true } });
    const visibleServices = services.filter((s) => arr<string>(s.staffIds).some((id) => visibleIds.has(id)));
    let regularsCount = 0;
    for (const s of staffList) regularsCount += await this.countRegulars(s.id);
    const staffOut: Record<string, unknown>[] = [];
    for (const s of staffList) {
      const own = services.filter((sv) => arr<string>(s.serviceIds).includes(sv.id));
      const nextSlot = (await this.availability.nearestSlots(businessId, { staffId: s.id, durationMin: this.shortestService(own)?.durationMin ?? CATALOG_DEFAULT_DURATION, serviceId: this.shortestService(own)?.id, days: CATALOG_DAYS, limit: 1 }))[0];
      staffOut.push({ staff: sanitizePublicStaff(s), nextSlot });
    }
    return {
      business: await this.businessOut(business),
      locations: locations.map(locationView),
      categories: categories.map(categoryView),
      services: visibleServices.map(serviceView),
      staff: staffOut,
      regularsCount,
    };
  }

  // ─────────────────────────── дни/окна для потока записи (F-00-092, F-14-012) ───────────────────────────

  async bookingDays(staffId: string, serviceId: string, workplace?: string, days = 14): Promise<{ date: string; slots: FreeSlot[] }[]> {
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) throw new ApiError('not_found', 'Service not found');
    const out: { date: string; slots: FreeSlot[] }[] = [];
    let cursor = nowLocal().slice(0, 10);
    for (let i = 0; i < Math.min(60, days); i++) {
      const slots = dedupeSlots(await this.availability.freeSlots(staff.businessId, { staffId, date: cursor, durationMin: service.durationMin, durationMax: service.durationMax ?? undefined, bufferAfterMin: service.bufferAfterMin ?? undefined, serviceId })).filter((s) => !workplace || workplace === 'visit' || s.workplace === workplace);
      if (slots.length) out.push({ date: cursor, slots });
      const d = new Date(`${cursor}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      cursor = d.toISOString().slice(0, 10);
    }
    return out;
  }

  async slotsFor(staffId: string, date: string, serviceId?: string, workplace?: string): Promise<FreeSlot[]> {
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const service = serviceId ? await this.prisma.service.findUnique({ where: { id: serviceId } }) : null;
    const slots = dedupeSlots(await this.availability.freeSlots(staff.businessId, { staffId, date, durationMin: service?.durationMin ?? CATALOG_DEFAULT_DURATION, durationMax: service?.durationMax ?? undefined, bufferAfterMin: service?.bufferAfterMin ?? undefined, serviceId }));
    return workplace && workplace !== 'visit' ? slots.filter((s) => s.workplace === workplace) : slots;
  }

  // ─────────────────────────── оттенок/вариант (F-00-094…096) — склад не построен, честно пусто ───────────────────────────

  async shadeOptions(serviceId: string): Promise<{ requirement: string; options: unknown[] }> {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) return { requirement: 'none', options: [] };
    const shadeChoice = service.shadeChoice;
    const materials = arr<string>(service.materials);
    if (!shadeChoice || !materials.length) return { requirement: 'none', options: [] };
    return {
      requirement: shadeChoice,
      options: [...materials.map((material) => ({ value: material, mode: 'material', material })), { value: '__master__', mode: 'master' }, { value: '__own__', mode: 'own' }],
    };
  }

  // ─────────────────────────── срок бесплатной отмены (F-00-098) ───────────────────────────

  async cancelWindowHours(staffId: string): Promise<number> {
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { bookingRules: true } });
    const rules = (staff?.bookingRules as Record<string, unknown> | null) ?? {};
    if (typeof rules.cancelWindowMin === 'number') return Math.round((rules.cancelWindowMin as number) / 60);
    if (typeof rules.cancelWindowHours === 'number') return rules.cancelWindowHours as number;
    return 3;
  }

  // ─────────────────────────── «Не нашли?» (F-00-112, F-00-180) ───────────────────────────

  async submitDemand(input: { query: string; sphereId?: string; district?: string; phone?: string; appUserId?: string; notify?: boolean }): Promise<void> {
    await this.prisma.demandLead.create({
      data: { id: newId('demandLead'), query: input.query.slice(0, 200), sphereId: input.sphereId, district: input.district, phone: input.phone ? normalizePhone(input.phone) : undefined, appUserId: input.appUserId, notify: input.notify ?? false },
    });
  }

  // ─────────────────────────── «Попросить перезвонить» (F-00-106) ───────────────────────────

  async requestCallback(input: { staffId: string; phone: string; name?: string }): Promise<void> {
    const staff = await this.prisma.staff.findUnique({ where: { id: input.staffId }, select: { businessId: true } });
    if (!staff) throw new ApiError('not_found', 'Staff not found');
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ApiError('invalid_phone', 'Phone must be +374XXXXXXXX');
    await this.prisma.callbackRequest.create({ data: { id: newId('callbackRequest'), staffId: input.staffId, businessId: staff.businessId, phone, name: input.name } });
  }
}
