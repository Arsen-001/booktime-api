import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { LiveService } from '../../common/live/live.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import { nextPlatformNumber } from '../platform/counters.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;
type Section = 'brand' | 'contacts' | 'gallery' | 'legal' | 'system' | 'categories';

const TAX_ID_RE = /^\d{8}$/;
const TELEGRAM_RE = /^https:\/\/t\.me\/[a-zA-Z0-9_]{3,}$/;
const SYSTEM_CATEGORIES = [
  { key: 'fullPrepay', colorIndex: 3 },
  { key: 'partialPrepay', colorIndex: 4 },
  { key: 'specialistImportant', colorIndex: 1 },
  { key: 'anySpecialist', colorIndex: 5 },
] as const;

export interface RecordCategory {
  id: string;
  businessId: string;
  name: string;
  colorIndex: number;
  icon?: string;
  system?: boolean;
  systemKey?: string;
}

/**
 * Настройки компании (02 §18, F4 «JSON по разделам»): реквизиты, основные, категории записи, анкета/тур — в
 * `business_settings` по разделам (`legal`, `system`, `recordCategories`, `onboarding`, `brand`); бренд, контакты и
 * галерея — поля бизнеса и первого филиала. Каждая правка — строка журнала «было → стало» (F-15-180).
 * Проверка текстов/фото нашей модерацией (F-00-168) — этап 19; до него сохранённое видно сразу.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  // ─────────── разделы JSON ───────────

  private async area<T extends object>(db: Db, businessId: string, area: string, fallback: T): Promise<T> {
    const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area } } });
    return (row?.data as T | undefined) ?? fallback;
  }

  private async putArea(tx: Tx, ctx: RequestContext, businessId: string, area: string, data: object) {
    await tx.businessSetting.upsert({
      where: { businessId_area: { businessId, area } },
      create: { businessId, area, data: data as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId },
      update: { data: data as Prisma.InputJsonValue, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
    });
  }

  private async log(tx: Tx, ctx: RequestContext, businessId: string, section: Section, fieldKey: string, before: string, after: string) {
    if (before === after) return;
    await tx.settingsChangeLog.create({
      data: { id: newId('settingsChangeLog'), businessId, section, fieldKey, before: before.slice(0, 2000), after: after.slice(0, 2000), staffId: ctx.member!.staffId, staffName: ctx.member!.name },
    });
  }

  private changed(businessId: string) {
    void this.live.publish(`biz:${businessId}`, { type: 'business.changed', data: { businessId, area: 'settings' } });
  }

  async changeLog(businessId: string, section?: Section) {
    const rows = await this.prisma.settingsChangeLog.findMany({ where: { businessId, ...(section ? { section } : {}) }, orderBy: { at: 'desc' }, take: 300 });
    return rows.map((r) => ({ id: r.id, businessId, section: r.section as Section, fieldKey: r.fieldKey, before: r.before, after: r.after, staffId: r.staffId, staffName: r.staffName, at: utcToLocal(r.at) }));
  }

  // ─────────── реквизиты (F-15-112, F-15-085/086/088) ───────────

  legal(businessId: string) {
    return this.area<Record<string, unknown>>(this.prisma, businessId, 'legal', {});
  }

  async saveLegal(ctx: RequestContext, businessId: string, input: Record<string, unknown> & { taxId?: string; companyName?: string }) {
    if (input.taxId && !TAX_ID_RE.test(input.taxId.trim())) throw new ApiError('bad_tax_id', 'Tax id must be 8 digits', { taxId: 'format' });
    await this.prisma.$transaction(async (tx) => {
      const before = await this.area<Record<string, string | undefined>>(tx, businessId, 'legal', {});
      await this.putArea(tx, ctx, businessId, 'legal', input);
      await this.log(tx, ctx, businessId, 'legal', 'companyName', before.companyName ?? '', input.companyName ?? '');
      await this.log(tx, ctx, businessId, 'legal', 'taxId', before.taxId ?? '', input.taxId ?? '');
    });
    this.changed(businessId);
    return this.legal(businessId);
  }

  async saveBillingAddress(ctx: RequestContext, businessId: string, billingAddress: string) {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.area<Record<string, unknown>>(tx, businessId, 'legal', {});
      await this.putArea(tx, ctx, businessId, 'legal', { ...before, billingAddress });
    });
    return this.legal(businessId);
  }

  // ─────────── основные (F-15-113…117, F-15-030, F-15-136) ───────────

  async system(businessId: string) {
    const s = await this.area<Record<string, unknown>>(this.prisma, businessId, 'system', {});
    return { businessId, city: 'Yerevan', dateTimeFormat: '24', messageLanguage: 'ru', ...s };
  }

  async saveSystem(ctx: RequestContext, businessId: string, input: { city: string; dateTimeFormat: '24' | '12'; messageLanguage: 'ru' | 'hy' | 'en'; sphereSubtype?: string; internalName?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const before = { city: 'Yerevan', dateTimeFormat: '24', messageLanguage: 'ru', ...(await this.area<Record<string, string>>(tx, businessId, 'system', {})) };
      const { internalName, ...rest } = input;
      await this.putArea(tx, ctx, businessId, 'system', rest);
      if (internalName !== undefined && internalName.trim()) {
        const b = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } });
        if (b.name !== internalName.trim()) {
          await tx.business.update({ where: { id: businessId }, data: { name: internalName.trim(), updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
          await this.log(tx, ctx, businessId, 'system', 'internalName', b.name, internalName.trim());
        }
      }
      for (const k of ['dateTimeFormat', 'messageLanguage', 'city'] as const) await this.log(tx, ctx, businessId, 'system', k, String(before[k] ?? ''), String(rest[k] ?? ''));
    });
    this.changed(businessId);
    return this.system(businessId);
  }

  // ─────────── бренд, контакты, галерея (F-15-100…111) ───────────

  async brand(businessId: string) {
    const b = await this.prisma.business.findUnique({ where: { id: businessId }, select: { brandName: true, description: true, logoUrl: true } });
    if (!b) throw new ApiError('not_found', 'Business not found');
    const extra = await this.area<{ descriptionAutoLangs?: ('hy' | 'en')[] }>(this.prisma, businessId, 'brand', {});
    return { brandName: b.brandName ?? '', descriptionRu: ((b.description ?? {}) as { ru?: string }).ru ?? '', descriptionAutoLangs: extra.descriptionAutoLangs ?? [], logoUrl: b.logoUrl ?? undefined };
  }

  /**
   * Описание пишется на своём языке и переводится на hy/en с пометкой (F-00-174) — движка перевода нет,
   * поэтому копия текста с пометкой «автоперевод», как в моке.
   */
  async saveBrand(ctx: RequestContext, businessId: string, input: { brandName: string; descriptionRu: string; logoUrl?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { brandName: true, description: true, logoUrl: true } });
      const beforeDesc = ((b.description ?? {}) as { ru?: string }).ru ?? '';
      const d = input.descriptionRu.trim();
      await tx.business.update({
        where: { id: businessId },
        data: {
          brandName: input.brandName.trim() || null,
          description: d ? { ru: d, hy: d, en: d } : Prisma.DbNull,
          logoUrl: input.logoUrl ?? null,
          updatedBy: ctx.member!.staffId,
          version: { increment: 1 },
        },
      });
      await this.putArea(tx, ctx, businessId, 'brand', { descriptionAutoLangs: d ? ['hy', 'en'] : [] });
      await this.log(tx, ctx, businessId, 'brand', 'name', b.brandName ?? '', input.brandName.trim());
      await this.log(tx, ctx, businessId, 'brand', 'description', beforeDesc, d);
      if ((b.logoUrl ?? '') !== (input.logoUrl ?? '')) await this.log(tx, ctx, businessId, 'brand', 'logo', b.logoUrl ? '✓' : '—', input.logoUrl ? '✓' : '—');
    });
    this.changed(businessId);
    return this.brand(businessId);
  }

  private async primaryLocation(db: Db, businessId: string) {
    return db.location.findFirst({ where: { businessId }, orderBy: { createdAt: 'asc' } });
  }

  async contacts(businessId: string) {
    const b = await this.prisma.business.findUnique({ where: { id: businessId }, select: { phone: true, socials: true } });
    if (!b) throw new ApiError('not_found', 'Business not found');
    const loc = await this.primaryLocation(this.prisma, businessId);
    return {
      locationId: loc?.id,
      addressRu: ((loc?.address ?? {}) as { ru?: string }).ru ?? '',
      district: loc?.district,
      yandexMapsUrl: loc?.yandexMapsUrl ?? undefined,
      hasPin: loc?.lat != null && loc?.lng != null,
      hoursText: loc?.hoursText ?? undefined,
      phones: [b.phone, ...((loc?.extraPhones ?? []) as string[])].filter(Boolean),
      socials: (b.socials ?? {}) as Record<string, string>,
    };
  }

  async saveContacts(ctx: RequestContext, businessId: string, input: { addressRu: string; yandexMapsUrl?: string; hoursText?: string; phones: string[]; socials: Record<string, unknown> }) {
    const tg = input.socials.telegramUrl;
    if (typeof tg === 'string' && tg && !TELEGRAM_RE.test(tg.trim())) throw new ApiError('bad_telegram_url', 'Telegram link must be https://t.me/username', { telegramUrl: 'format' });
    const [first, ...rest] = input.phones.map((p) => p.trim()).filter(Boolean);
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { phone: true } });
      const loc = await this.primaryLocation(tx, businessId);
      if (loc) {
        const addr = (loc.address ?? {}) as Record<string, string>;
        await tx.location.update({
          where: { id: loc.id },
          data: { address: { ...addr, ru: input.addressRu }, yandexMapsUrl: input.yandexMapsUrl ?? null, hoursText: input.hoursText ?? null, ...(first ? { phone: first } : {}), extraPhones: rest, updatedBy: ctx.member!.staffId, version: { increment: 1 } },
        });
        await this.log(tx, ctx, businessId, 'contacts', 'address', addr.ru ?? '', input.addressRu);
      }
      const socials = Object.fromEntries(Object.entries(input.socials).filter(([, v]) => (typeof v === 'string' ? v.trim() : v !== undefined && v !== null))) as Prisma.InputJsonValue;
      await tx.business.update({ where: { id: businessId }, data: { phone: first ?? b.phone, socials, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.log(tx, ctx, businessId, 'contacts', 'phone', b.phone, first ?? b.phone);
    });
    this.changed(businessId);
    return this.contacts(businessId);
  }

  async gallery(businessId: string) {
    const b = await this.prisma.business.findUnique({ where: { id: businessId }, select: { photos: true } });
    if (!b) throw new ApiError('not_found', 'Business not found');
    return (b.photos ?? []) as string[];
  }

  async saveGallery(ctx: RequestContext, businessId: string, photos: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { photos: true } });
      await tx.business.update({ where: { id: businessId }, data: { photos, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.log(tx, ctx, businessId, 'gallery', 'photos', String(((b.photos ?? []) as string[]).length), String(photos.length));
    });
    this.changed(businessId);
    return photos;
  }

  // ─────────── категории записи (F-15-121…124) ───────────

  private async categoriesOf(db: Db, businessId: string): Promise<RecordCategory[]> {
    const data = await this.area<{ items?: RecordCategory[] }>(db, businessId, 'recordCategories', {});
    if (data.items) return data.items;
    return SYSTEM_CATEGORIES.map((c) => ({ id: `rcat_${businessId}_${c.key}`.slice(0, 32), businessId, name: `system.${c.key}`, colorIndex: c.colorIndex, system: true, systemKey: c.key }));
  }

  async categories(businessId: string) {
    const items = await this.categoriesOf(this.prisma, businessId);
    return [...items].sort((a, b) => Number(Boolean(b.system)) - Number(Boolean(a.system)));
  }

  async saveCategory(ctx: RequestContext, businessId: string, id: string | undefined, input: { name: string; colorIndex: number; icon?: string }) {
    const name = input.name.trim();
    if (!name) throw new ApiError('name_required', 'Category name required');
    return this.prisma.$transaction(async (tx) => {
      const items = await this.categoriesOf(tx, businessId);
      let result: RecordCategory;
      if (id) {
        const i = items.findIndex((c) => c.id === id && !c.system);
        if (i < 0) throw new ApiError('not_found', 'Category not found');
        const before = items[i]!;
        result = { ...before, name, colorIndex: input.colorIndex, icon: input.icon };
        items[i] = result;
        await this.log(tx, ctx, businessId, 'categories', 'edit', before.name, name);
      } else {
        result = { id: newId('recordCategory'), businessId, name, colorIndex: input.colorIndex, icon: input.icon };
        items.push(result);
        await this.log(tx, ctx, businessId, 'categories', 'add', '', name);
      }
      await this.putArea(tx, ctx, businessId, 'recordCategories', { items });
      return result;
    });
  }

  async deleteCategory(ctx: RequestContext, businessId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const items = await this.categoriesOf(tx, businessId);
      const found = items.find((c) => c.id === id);
      if (!found) throw new ApiError('not_found', 'Category not found');
      if (found.system) throw new ApiError('forbidden', 'System category cannot be deleted');
      await this.putArea(tx, ctx, businessId, 'recordCategories', { items: items.filter((c) => c.id !== id) });
      await this.log(tx, ctx, businessId, 'categories', 'delete', found.name, '—');
    });
  }

  // ─────────── анкета, тур, профиль, быстрый старт (F-15-007, F-15-021…023) ───────────

  onboarding(businessId: string) {
    return this.area<{ goals?: string[]; tourSeen?: boolean }>(this.prisma, businessId, 'onboarding', {});
  }

  async saveOnboarding(ctx: RequestContext, businessId: string, input: { goals?: string[]; tourSeen?: boolean }) {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.area<Record<string, unknown>>(tx, businessId, 'onboarding', {});
      await this.putArea(tx, ctx, businessId, 'onboarding', { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) });
    });
    return this.onboarding(businessId);
  }

  async companyProfile(businessId: string) {
    const b = await this.prisma.business.findUnique({ where: { id: businessId }, select: { kind: true, name: true, description: true, logoUrl: true, phone: true, photos: true } });
    if (!b) throw new ApiError('not_found', 'Business not found');
    const legal = await this.area<{ taxId?: string }>(this.prisma, businessId, 'legal', {});
    const fields = [
      { id: 'name' as const, done: b.name.trim().length > 0 },
      { id: 'description' as const, done: Boolean(((b.description ?? {}) as { ru?: string }).ru?.trim()) },
      { id: 'logo' as const, done: Boolean(b.logoUrl) },
      { id: 'contacts' as const, done: Boolean(b.phone) },
      { id: 'photos' as const, done: ((b.photos ?? []) as string[]).length > 0 },
      { id: 'legal' as const, done: Boolean(legal.taxId) },
    ];
    return { businessId, kind: b.kind, fields, percent: Math.round((fields.filter((f) => f.done).length / fields.length) * 100) };
  }

  async checklist(businessId: string) {
    const [staffCount, services, schedules, profile] = await Promise.all([
      this.prisma.staff.count({ where: { businessId, deletedAt: null, status: { not: 'fired' } } }),
      this.prisma.service.findMany({ where: { businessId }, select: { staffIds: true, onlineBookable: true } }),
      this.prisma.workSchedule.count({ where: { businessId } }),
      this.companyProfile(businessId),
    ]);
    return [
      { id: 'services', done: services.length > 0, href: '/biz/services' },
      { id: 'staff', done: staffCount > 1, href: '/biz/staff' },
      { id: 'staffServices', done: services.some((s) => Array.isArray(s.staffIds) && s.staffIds.length > 0), href: '/biz/services' },
      { id: 'schedule', done: schedules > 0, href: '/biz/schedule' },
      { id: 'online', done: services.some((s) => s.onlineBookable), href: '/biz/online' },
      { id: 'profile', done: profile.percent >= 100, href: '/biz/settings/brand' },
    ];
  }

  // ─────────── обращения: помощь, своё приложение (В-29), новая сфера (F-15-005, F-00-152) ───────────

  private requestView(r: Prisma.BizRequestGetPayload<object>) {
    return { id: r.id, businessId: r.businessId, authorStaffId: r.authorStaffId, ...(r.topic ? { topic: r.topic } : {}), ...(r.message ? { message: r.message } : {}), createdAt: utcToLocal(r.createdAt), status: r.status };
  }

  async requests(businessId: string, kind: 'help' | 'mobileApp') {
    const rows = await this.prisma.bizRequest.findMany({ where: { businessId, kind }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((r) => this.requestView(r));
  }

  /** kind='help' попадает в единую очередь поддержки нашей панели (этап 19, F-00-182) — номер из общего счётчика */
  async createRequest(ctx: RequestContext, businessId: string, kind: 'help' | 'mobileApp', input: { topic?: string; message?: string }) {
    const row = await this.prisma.$transaction(async (tx) => {
      const number = kind === 'help' ? await nextPlatformNumber(tx, 'support') : null;
      return tx.bizRequest.create({ data: { id: newId('bizRequest'), businessId, authorStaffId: ctx.member!.staffId, kind, topic: input.topic ?? null, message: input.message ?? null, number } });
    });
    return this.requestView(row);
  }

  /**
   * Статус этой таблицы решает наша панель (этап 19: open|agreed|inProgress|done, F-00-151/152) — кабинет
   * знает только open|answered|closed (HelpRequestStatus фронта, как у help-requests); сведено картой, а не
   * общим словарём — то же решение, что PLATFORM_STATUS/BIZ_TO_QUEUE у поддержки того же этапа.
   */
  private static readonly SPHERE_STATUS_TO_BIZ: Record<string, 'open' | 'answered' | 'closed'> = {
    open: 'open',
    agreed: 'answered',
    inProgress: 'answered',
    done: 'closed',
    answered: 'answered',
    closed: 'closed',
  };

  private sphereView(r: Prisma.SphereRequestGetPayload<object>) {
    return {
      id: r.id,
      businessId: r.businessId ?? undefined,
      authorStaffId: r.authorStaffId ?? undefined,
      name: r.name,
      message: r.message ?? undefined,
      createdAt: utcToLocal(r.createdAt),
      status: SettingsService.SPHERE_STATUS_TO_BIZ[r.status] ?? 'open',
      checklist: (r.checklist ?? undefined) as { id: string; labelKey: string; done: boolean }[] | undefined,
      etaDate: r.etaDate ?? undefined,
      readyAt: r.readyAt ?? undefined,
    };
  }

  async sphereRequests(businessId: string) {
    const rows = await this.prisma.sphereRequest.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.sphereView(r));
  }

  async sphereRequest(businessId: string, id: string) {
    const r = await this.prisma.sphereRequest.findFirst({ where: { id, businessId } });
    if (!r) throw new ApiError('not_found', 'Sphere request not found');
    return this.sphereView(r);
  }

  async createSphereRequest(ctx: RequestContext, businessId: string, input: { name: string; message?: string }) {
    const r = await this.prisma.sphereRequest.create({ data: { id: newId('sphereRequest'), businessId, authorStaffId: ctx.member!.staffId, name: input.name.trim(), message: input.message?.trim() || null } });
    return this.sphereView(r);
  }

  // ─────────── личные настройки в кабинете (F-15-150…157) ───────────

  async prefs(staffId: string) {
    const p = await this.prisma.staffAccountPref.findUnique({ where: { staffId } });
    return {
      notificationPrefs: (p?.notificationPrefs ?? { news: true, marketing: true, system: true }) as { news: boolean; marketing: boolean; system: boolean },
      startPage: p?.startPage ?? undefined,
      startLocationId: p?.startLocationId ?? undefined,
    };
  }

  async savePrefs(staffId: string, input: { notificationPrefs?: { news: boolean; marketing: boolean; system: boolean }; startPage?: string | null; startLocationId?: string | null }) {
    const current = await this.prefs(staffId);
    const notificationPrefs = input.notificationPrefs ?? current.notificationPrefs;
    const data = {
      notificationPrefs: { ...notificationPrefs, system: true } as Prisma.InputJsonValue,
      startPage: input.startPage === undefined ? (current.startPage ?? null) : input.startPage,
      startLocationId: input.startLocationId === undefined ? (current.startLocationId ?? null) : input.startLocationId,
    };
    await this.prisma.staffAccountPref.upsert({ where: { staffId }, create: { staffId, ...data }, update: data });
    return this.prefs(staffId);
  }
}
