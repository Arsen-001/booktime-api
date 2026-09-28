import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { PrismaService } from '../../common/prisma.service.js';
import { view, type AppInstallConfig } from './connections.service.js';
import type { AppInstallOut } from './integrations.schemas.js';
import type {
  CatalogQuery,
  CreateDevAppBody,
  DevAppAction,
  InstallAction,
  PromoBlockDraftBody,
  RegisterDeveloperBody,
} from './marketplace.schemas.js';

/**
 * Этап 21 (сдача, попытка 6): маркетплейс интеграций на сервере — каталог, отзывы, подписка на категорию,
 * промоблоки виджета, кабинет разработчика, заявки партнёрам, демо-настройки конкретных приложений (b03/b04/b05).
 * Р19 соблюдён: с чужими приложениями по-прежнему нет настоящего обмена — сервер хранит статус и настройки,
 * «демо-кнопки» (одобрить имя отправителя, модерация своего приложения, проверить звонок…) меняют только наши
 * данные. Логика — порт src/api/integrations.ts (мок) один-в-один, чтобы экран вёл себя в api так же.
 */

type Json = Record<string, unknown>;
const J = (v: unknown) => v as Prisma.InputJsonValue;

/** Те же списки, что VISIBLE_/HIDDEN_CATEGORY_IDS в src/domain/integrations.ts */
const VISIBLE_CATEGORY_IDS = ['notifications', 'telephony', 'marketing', 'social', 'widgets', 'analytics', 'accounting', 'maps', 'payments', 'fiscal', 'aiAssistants', 'crm', 'personnel', 'other'];
const HIDDEN_CATEGORY_IDS = ['chatbots', 'tips'];

const PROMO_HEADLINE_MAX = 50;
const PROMO_DESCRIPTION_MAX = 220;
const PROMO_BUTTON_TEXT_MAX = 20;
const GA_STREAM_ID_RE = /^G-[A-Z0-9]{6,10}$/;
const WHO_TO_CALL_MAX = 10;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString();

interface CatalogRow {
  id: string;
  code: string;
  categoryId: string;
  builtin: boolean;
  hidden: boolean;
  featuredRank: number | null;
  installsCount: number;
  rating: number;
  reviewsCount: number;
  data: unknown;
}

export type CatalogAppOut = Json & {
  id: string;
  code: string;
  categoryId: string;
  name: string;
  subtitle: string;
  description?: string;
  features: string[];
  countries: string[];
  builtin?: boolean;
  hiddenFromCatalog?: boolean;
  featuredRank?: number;
  installsCount: number;
  rating: number;
  reviewsCount: number;
  price: { model: string; amount?: number; currency?: string };
  channels?: string[];
  notifyCapabilities?: string[];
  notifyAppKind?: string;
};

function toApp(row: CatalogRow): CatalogAppOut {
  const data = row.data as CatalogAppOut;
  return {
    ...data,
    id: row.id,
    code: row.code,
    categoryId: row.categoryId,
    installsCount: row.installsCount,
    rating: row.rating,
    reviewsCount: row.reviewsCount,
    ...(row.featuredRank !== null ? { featuredRank: row.featuredRank } : {}),
  };
}

function matchesQuery(app: CatalogAppOut, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [app.name, app.subtitle, app.description ?? '', ...(app.features ?? [])].join(' ').toLowerCase();
  if (haystack.includes(needle)) return true;
  if (needle.includes('book') || needle.includes('запис')) return app.categoryId === 'widgets' || app.categoryId === 'social';
  if (needle.includes('chat') || needle.includes('чат')) return (app.channels ?? []).length > 0 || app.categoryId === 'chatbots';
  return false;
}

const inCountry = (app: CatalogAppOut, country: string) => (country === 'AM' ? app.countries.includes('AM') || Boolean(app.builtin) : true);

export interface PromoBlockOut extends Json {
  id: string;
  businessId: string;
  locationId: string;
  enabled: boolean;
  createdAt: string;
}

function validPromoDraft(d: PromoBlockDraftBody): boolean {
  const headline = d.headline.trim();
  if (!headline || headline.length > PROMO_HEADLINE_MAX) return false;
  if (d.description.trim().length > PROMO_DESCRIPTION_MAX) return false;
  if (d.buttonText.trim().length > PROMO_BUTTON_TEXT_MAX) return false;
  if (d.buttonText.trim() && !d.buttonHref.trim()) return false;
  return d.placements.length > 0;
}

function promoData(d: PromoBlockDraftBody): Json {
  return {
    headline: d.headline.trim(),
    description: d.description.trim(),
    hasImage: d.hasImage,
    icon: d.icon,
    ...(d.buttonText.trim() ? { buttonText: d.buttonText.trim() } : {}),
    ...(d.buttonHref.trim() ? { buttonHref: d.buttonHref.trim() } : {}),
    placements: d.placements,
  };
}

function promoView(row: { id: string; businessId: string; locationId: string; enabled: boolean; data: unknown; createdAt: Date }): PromoBlockOut {
  return { ...(row.data as Json), id: row.id, businessId: row.businessId, locationId: row.locationId, enabled: row.enabled, createdAt: iso(row.createdAt) };
}

interface DevAppData {
  name: string;
  categoryId: string;
  isPrivate: boolean;
  about: { galleryCount: number; videoUrl?: string; byLocale: Record<string, { description: string; features: string[]; faq: { q: string; a: string }[] }> };
  devSettings: { registrationUrl: string; callbackUrl?: string; webhookUrl?: string; passUserData: boolean; iframeMode: boolean; allowMultiLocation: boolean };
  apiAccess: { systemUserId?: string; permissions: string[]; userToken?: string };
  monetization: Json & { isPaid: boolean; priceAmount?: number; currency?: string };
  publication: { connectInstructions: string; paymentInstructions: string };
  events: { id: string; type: string; at: string }[];
  rejectReason?: string;
  testInstalledAt?: string;
}

function devAppView(row: { id: string; ownerStaffId: string; businessId: string; appCode: string; status: string; data: unknown; createdAt: Date }): Json {
  const data = row.data as DevAppData;
  return { ...data, id: row.id, ownerStaffId: row.ownerStaffId, businessId: row.businessId, appCode: row.appCode, status: row.status, createdAt: iso(row.createdAt) };
}

/** F-13-047: обязательные пункты чек-листа (devAppPublishChecklist фронта) */
function canSubmitForReview(d: DevAppData): boolean {
  return (
    d.devSettings.registrationUrl.trim().length > 0 &&
    (d.about.byLocale.ru?.description.trim().length ?? 0) > 0 &&
    d.publication.connectInstructions.trim().length > 0 &&
    d.publication.paymentInstructions.trim().length > 0
  );
}

function demoToken(prefix: string): string {
  return `${prefix}_${Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')}`;
}

@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────── Каталог (F-13-002…004, F-13-013, F-13-027) ───────────

  private async allApps(): Promise<CatalogAppOut[]> {
    const rows = await this.prisma.integrationCatalogApp.findMany();
    return rows.map(toApp);
  }

  /** Весь каталог, включая скрытые карточки: экраны «Установлено»/чат/каналы достраивают имя по id */
  async catalogAll(): Promise<CatalogAppOut[]> {
    return this.allApps();
  }

  async listApps(q: CatalogQuery): Promise<CatalogAppOut[]> {
    const country = q.country ?? 'AM';
    return (await this.allApps())
      .filter((a) => !a.hiddenFromCatalog)
      .filter((a) => (q.categoryId ? a.categoryId === q.categoryId : !HIDDEN_CATEGORY_IDS.includes(a.categoryId)))
      .filter((a) => inCountry(a, country))
      .filter((a) => matchesQuery(a, q.q ?? ''))
      .filter((a) => (q.channel ? (a.channels ?? []).includes(q.channel) : true))
      .filter((a) => (q.capability ? (a.notifyCapabilities ?? []).includes(q.capability) : true))
      .filter((a) => (q.appKind ? a.notifyAppKind === q.appKind : true))
      .sort(
        (a, b) =>
          (a.featuredRank ?? 99) - (b.featuredRank ?? 99) ||
          (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0) ||
          (a.price.model === 'comingSoon' ? 1 : 0) - (b.price.model === 'comingSoon' ? 1 : 0) ||
          b.installsCount - a.installsCount,
      );
  }

  async featured(country: string): Promise<CatalogAppOut[]> {
    return (await this.allApps())
      .filter((a) => a.featuredRank !== undefined && !a.hiddenFromCatalog)
      .filter((a) => inCountry(a, country))
      .sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0));
  }

  async categoryCounts(country: string): Promise<{ categoryId: string; count: number }[]> {
    const apps = (await this.allApps()).filter((a) => !a.hiddenFromCatalog).filter((a) => inCountry(a, country));
    return VISIBLE_CATEGORY_IDS.map((categoryId) => ({ categoryId, count: apps.filter((a) => a.categoryId === categoryId).length }));
  }

  async getApp(id: string): Promise<CatalogAppOut> {
    const row = await this.prisma.integrationCatalogApp.findUnique({ where: { id } });
    if (!row) throw new ApiError('not_found', 'App not found');
    return toApp(row);
  }

  async getAppByCode(code: string): Promise<CatalogAppOut> {
    const row = await this.prisma.integrationCatalogApp.findUnique({ where: { code } });
    if (!row) throw new ApiError('not_found', 'App not found');
    return toApp(row);
  }

  // ─────────── Отзывы (F-13-011) ───────────

  async listReviews(appId: string): Promise<Json[]> {
    const rows = await this.prisma.integrationAppReview.findMany({ where: { appId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((r) => ({ id: r.id, appId: r.appId, businessId: r.businessId, authorName: r.authorName, rating: r.rating, text: r.text, createdAt: iso(r.createdAt) }));
  }

  async addReview(ctx: RequestContext, businessId: string, body: { appId: string; rating: number; text: string }): Promise<Json> {
    const live = await this.prisma.integrationConnection.count({ where: { businessId, appId: body.appId, status: { in: ['connected', 'pendingActivation'] } } });
    if (!live) throw new ApiError('not_installed', 'Review is allowed after connecting the app');
    const rating = Math.max(1, Math.min(5, Math.round(body.rating)));
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.integrationAppReview.create({
        data: { id: newId('integrationReview'), appId: body.appId, businessId, authorName: ctx.member?.name?.slice(0, 120) || 'Владелец', rating, text: body.text.trim() },
      });
      const agg = await tx.integrationAppReview.aggregate({ where: { appId: body.appId }, _avg: { rating: true }, _count: true });
      await tx.integrationCatalogApp.updateMany({
        where: { id: body.appId },
        data: { reviewsCount: agg._count, rating: Math.round((agg._avg.rating ?? rating) * 10) / 10 },
      });
      return created;
    });
    return { id: row.id, appId: row.appId, businessId: row.businessId, authorName: row.authorName, rating: row.rating, text: row.text, createdAt: iso(row.createdAt) };
  }

  // ─────────── Подписка на пустую категорию (F-13-005) ───────────

  async isSubscribed(businessId: string, categoryId: string): Promise<boolean> {
    return (await this.prisma.integrationCategorySubscription.count({ where: { businessId, categoryId } })) > 0;
  }

  async subscribe(businessId: string, categoryId: string): Promise<void> {
    await this.prisma.integrationCategorySubscription.createMany({ data: [{ businessId, categoryId }], skipDuplicates: true });
  }

  // ─────────── Настройки конкретных приложений (b03/b04/b05) ───────────

  async installAction(businessId: string, installId: string, action: InstallAction): Promise<{ install: AppInstallOut; result?: Json }> {
    const row = await this.prisma.integrationConnection.findFirst({ where: { id: installId, businessId } });
    if (!row) throw new ApiError('not_found', 'Install not found');
    const cfg: AppInstallConfig = { ...((row.config as AppInstallConfig | null) ?? {}) };
    const now = new Date();
    const data: Prisma.IntegrationConnectionUpdateInput = {};
    let result: Json | undefined;
    switch (action.action) {
      case 'payPartner': {
        // F-13-021/043: имитация оплаты подписки партнёра — продлевает «оплачено до» и пишет историю оплат
        const app = await this.prisma.integrationCatalogApp.findUnique({ where: { id: row.appId } });
        const price = ((app?.data as Json | undefined)?.price ?? {}) as { amount?: number; currency?: string };
        const paidUntil = new Date(now.getTime() + MONTH_MS);
        data.status = 'connected';
        data.paidUntil = paidUntil;
        data.errorText = null;
        cfg.paymentHistory = [...(cfg.paymentHistory ?? []), { id: newId('integrationPartnerPayment'), amount: price.amount ?? 0, currency: price.currency ?? 'AMD', paidUntil: iso(paidUntil), createdAt: iso(now) }];
        break;
      }
      case 'refund': {
        const last = cfg.paymentHistory?.at(-1);
        if (!last || last.refundedAt) throw new ApiError('nothing_to_refund', 'Nothing to refund');
        cfg.paymentHistory = [...cfg.paymentHistory!.slice(0, -1), { ...last, refundedAt: iso(now) }];
        break;
      }
      case 'smsAuth': {
        const key = action.authKey.trim();
        if (!key && !cfg.authKey) throw new ApiError('validation', 'Auth key is required', { authKey: 'required' });
        if (key) cfg.authKey = key;
        cfg.senderName = action.senderName.trim();
        cfg.senderNameStatus = 'pending';
        break;
      }
      case 'approveSender':
        cfg.senderNameStatus = 'approved';
        break;
      case 'topUp':
        cfg.messageBalanceAmd = (cfg.messageBalanceAmd ?? 0) + action.amountAmd;
        break;
      case 'sendTestMessage': {
        const balance = cfg.messageBalanceAmd ?? 0;
        if (balance >= action.pricePerMessageAmd) {
          cfg.messageBalanceAmd = balance - action.pricePerMessageAmd;
          result = { outcome: 'sent', balanceAmd: cfg.messageBalanceAmd };
        } else {
          result = { outcome: 'insufficientFunds', balanceAmd: balance };
        }
        break;
      }
      case 'whatsappMode':
        cfg.whatsappNumberMode = action.mode;
        if (action.mode === 'default') cfg.metaTemplatesApproved = true;
        break;
      case 'approveMeta':
        cfg.metaTemplatesApproved = true;
        break;
      case 'cascadeOrder':
        cfg.cascadeOrder = action.order;
        break;
      case 'chatbotTest': {
        const order = cfg.cascadeOrder?.length ? cfg.cascadeOrder : action.channels;
        const deliveredVia = order[order.length > 1 ? 1 : 0] ?? order[0] ?? 'whatsapp';
        cfg.lastChatbotTest = { at: iso(now), deliveredVia, confirmed: action.canConfirm };
        break;
      }
      case 'negativeIntercept':
        cfg.negativeReviewIntercept = action.on;
        break;
      case 'interceptReview':
        cfg.interceptedReviewsCount = (cfg.interceptedReviewsCount ?? 0) + 1;
        break;
      case 'retentionRun': {
        // Настоящий счёт: клиенты бизнеса, не бывавшие N+ дней (у мока — доля от всех клиентов)
        const since = new Date(now.getTime() - action.days * 24 * 60 * 60 * 1000);
        const recent = await this.prisma.booking.findMany({
          where: { businessId, deletedAt: null, clientId: { not: null }, startAt: { gte: since, lte: now } },
          select: { clientId: true },
          distinct: ['clientId'],
        });
        const total = await this.prisma.client.count({ where: { businessId, deletedAt: null } });
        cfg.lastRetentionRunCount = Math.max(0, total - recent.length);
        break;
      }
      case 'loyaltyVisit':
        cfg.demoLoyaltyStamps = (cfg.demoLoyaltyStamps ?? 0) + 1;
        break;
      case 'fastSign':
        cfg.fastSignFilledCount = (cfg.fastSignFilledCount ?? 0) + 1;
        break;
      case 'kommoMode':
        cfg.kommoSyncMode = action.mode;
        break;
      case 'kommoDedupe':
        cfg.kommoDedupe = action.dedupe;
        break;
      case 'gaAdd':
      case 'gaUpdate': {
        const streamId = action.streamId.trim().toUpperCase();
        const formLabel = action.formLabel.trim();
        if (!GA_STREAM_ID_RE.test(streamId)) throw new ApiError('invalid_stream_id', 'Invalid GA4 stream id');
        const editing = action.action === 'gaUpdate' ? action.streamPk : undefined;
        const streams = cfg.gaStreams ?? [];
        if (streams.some((s) => s.id !== editing && s.formLabel === formLabel)) throw new ApiError('duplicate_stream_form', 'This form already has a stream');
        cfg.gaStreams =
          action.action === 'gaUpdate'
            ? streams.map((s) => (s.id === action.streamPk ? { ...s, streamId, formLabel } : s))
            : [...streams, { id: newId('gaDataStream'), streamId, formLabel, createdAt: iso(now) }];
        break;
      }
      case 'gaDelete':
        cfg.gaStreams = (cfg.gaStreams ?? []).filter((s) => s.id !== action.streamPk);
        break;
    }
    data.config = J(cfg);
    const updated = await this.prisma.integrationConnection.update({ where: { id: installId }, data });
    return { install: view(updated), ...(result ? { result } : {}) };
  }

  // ─────────── Промоблоки виджета (F-13-172) ───────────

  async listPromoBlocks(businessId: string): Promise<PromoBlockOut[]> {
    const rows = await this.prisma.integrationPromoBlock.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    return rows.map(promoView);
  }

  async createPromoBlock(businessId: string, locationId: string, draft: PromoBlockDraftBody): Promise<PromoBlockOut> {
    if (!validPromoDraft(draft)) throw new ApiError('validation', 'Invalid promo block');
    const loc = await this.prisma.location.count({ where: { id: locationId, businessId } });
    if (!loc) throw new ApiError('forbidden', 'Location is not in this business');
    const row = await this.prisma.integrationPromoBlock.create({ data: { id: newId('integrationPromoBlock'), businessId, locationId, enabled: true, data: J(promoData(draft)) } });
    return promoView(row);
  }

  async updatePromoBlock(businessId: string, id: string, draft: PromoBlockDraftBody): Promise<PromoBlockOut> {
    if (!validPromoDraft(draft)) throw new ApiError('validation', 'Invalid promo block');
    const found = await this.prisma.integrationPromoBlock.findFirst({ where: { id, businessId } });
    if (!found) throw new ApiError('not_found', 'Promo block not found');
    return promoView(await this.prisma.integrationPromoBlock.update({ where: { id }, data: { data: J(promoData(draft)) } }));
  }

  async setPromoBlockEnabled(businessId: string, id: string, enabled: boolean): Promise<PromoBlockOut> {
    const found = await this.prisma.integrationPromoBlock.findFirst({ where: { id, businessId } });
    if (!found) throw new ApiError('not_found', 'Promo block not found');
    return promoView(await this.prisma.integrationPromoBlock.update({ where: { id }, data: { enabled } }));
  }

  async deletePromoBlock(businessId: string, id: string): Promise<void> {
    await this.prisma.integrationPromoBlock.deleteMany({ where: { id, businessId } });
  }

  // ─────────── Кабинет разработчика (F-13-028…048) — ключ ownerStaffId ───────────

  private staffOf(ctx: RequestContext): string {
    const staffId = ctx.member?.staffId;
    if (!staffId) throw new ApiError('forbidden', 'Staff member required');
    return staffId;
  }

  async getDeveloper(ctx: RequestContext): Promise<Json | null> {
    const row = await this.prisma.integrationDeveloperAccount.findUnique({ where: { ownerStaffId: this.staffOf(ctx) } });
    return row ? { ...(row.data as Json), businessId: row.businessId, ownerStaffId: row.ownerStaffId, createdAt: iso(row.createdAt) } : null;
  }

  async registerDeveloper(ctx: RequestContext, businessId: string, body: RegisterDeveloperBody): Promise<Json> {
    const ownerStaffId = this.staffOf(ctx);
    await this.prisma.integrationDeveloperAccount.createMany({ data: [{ ownerStaffId, businessId, data: J(body) }], skipDuplicates: true });
    return (await this.getDeveloper(ctx))!;
  }

  async listDevApps(ctx: RequestContext): Promise<Json[]> {
    const rows = await this.prisma.integrationDevApp.findMany({ where: { ownerStaffId: this.staffOf(ctx) }, orderBy: { createdAt: 'desc' } });
    return rows.map(devAppView);
  }

  async getDevApp(ctx: RequestContext, id: string): Promise<Json> {
    const row = await this.prisma.integrationDevApp.findFirst({ where: { id, ownerStaffId: this.staffOf(ctx) } });
    if (!row) throw new ApiError('not_found', 'App not found');
    return devAppView(row);
  }

  async getDevAppByCode(ctx: RequestContext, code: string): Promise<Json> {
    const row = await this.prisma.integrationDevApp.findFirst({ where: { appCode: code, ownerStaffId: this.staffOf(ctx) } });
    if (!row) throw new ApiError('not_found', 'App not found');
    return devAppView(row);
  }

  async createDevApp(ctx: RequestContext, businessId: string, body: CreateDevAppBody): Promise<Json> {
    const ownerStaffId = this.staffOf(ctx);
    const code = body.appCode.trim();
    if (!code) throw new ApiError('invalid_code', 'App code is required');
    const taken = (await this.prisma.integrationDevApp.count({ where: { appCode: code } })) + (await this.prisma.integrationCatalogApp.count({ where: { code } }));
    if (taken) throw new ApiError('code_taken', 'App code is taken');
    const data: DevAppData = {
      name: body.name.trim(),
      categoryId: body.categoryId,
      isPrivate: body.isPrivate,
      about: { galleryCount: 0, byLocale: {} },
      devSettings: { registrationUrl: '', passUserData: false, iframeMode: false, allowMultiLocation: false },
      apiAccess: { permissions: [] },
      monetization: { isPaid: false },
      publication: { connectInstructions: '', paymentInstructions: '' },
      events: [],
    };
    const row = await this.prisma.integrationDevApp.create({ data: { id: newId('integrationDevApp'), ownerStaffId, businessId, appCode: code, status: 'draft', data: J(data) } });
    return devAppView(row);
  }

  async devAppAction(ctx: RequestContext, id: string, action: DevAppAction): Promise<Json> {
    const row = await this.prisma.integrationDevApp.findFirst({ where: { id, ownerStaffId: this.staffOf(ctx) } });
    if (!row) throw new ApiError('not_found', 'App not found');
    const d = structuredClone(row.data as unknown as DevAppData);
    let status = row.status;
    const now = iso(new Date());
    const event = (type: string) => d.events.push({ id: newId('integrationDevAppEvent'), type, at: now });
    switch (action.action) {
      case 'about':
        if (action.galleryCount !== undefined) d.about.galleryCount = Math.max(0, Math.min(5, action.galleryCount));
        if (action.videoUrl !== undefined) d.about.videoUrl = action.videoUrl.trim() || undefined;
        d.about.byLocale[action.locale] = {
          description: action.text.description.slice(0, 3000),
          features: action.text.features.filter((f) => f.trim()).slice(0, 20),
          faq: action.text.faq.slice(0, 50).map((f) => ({ q: f.q.slice(0, 100), a: f.a.slice(0, 1000) })),
        };
        break;
      case 'devSettings':
        d.devSettings = { ...d.devSettings, ...action.patch };
        break;
      case 'apiAccess': {
        const sys = action.systemUserId.trim();
        d.apiAccess = { systemUserId: sys || undefined, permissions: action.permissions, userToken: sys ? (d.apiAccess.userToken ?? demoToken('utok')) : undefined };
        break;
      }
      case 'submit':
        if (!canSubmitForReview(d)) throw new ApiError('registration_url_required', 'Checklist is not complete');
        status = 'review';
        d.rejectReason = undefined;
        event('submitted');
        break;
      case 'moderate':
        if (status !== 'review') throw new ApiError('not_in_review', 'App is not in review');
        status = action.decision;
        d.rejectReason = action.decision === 'rejected' ? 'demoRejected' : undefined;
        event(action.decision);
        break;
      case 'testInstall':
        d.testInstalledAt = now;
        event('testInstalled');
        break;
      case 'testUninstall':
        d.testInstalledAt = undefined;
        event('testUninstalled');
        if (d.devSettings.webhookUrl || d.devSettings.callbackUrl) event('disabled');
        break;
      case 'monetization':
        d.monetization = { ...d.monetization, ...action.patch };
        break;
      case 'publication':
        d.publication = { ...d.publication, ...action.patch };
        break;
      case 'tariffSheet': {
        const currency = d.monetization.currency ?? 'AMD';
        const base = d.monetization.priceAmount ?? (currency === 'AMD' ? 9900 : 19);
        d.monetization.tariffPlans = [
          { name: 'Старт', price: base, currency, period: 'month', features: ['1 филиал', 'Базовые функции'] },
          { name: 'Бизнес', price: Math.round(base * 2.2), currency, period: 'month', features: ['До 5 филиалов', 'Приоритетная поддержка'] },
          { name: 'Сеть', price: Math.round(base * 4.5), currency, period: 'month', features: ['Без ограничения филиалов', 'Персональный менеджер'] },
        ];
        d.monetization.tariffSheetUploadedAt = now;
        d.monetization.tariffSheetFileName = action.fileName;
        break;
      }
    }
    const updated = await this.prisma.integrationDevApp.update({ where: { id }, data: { status, data: J(d) } });
    return devAppView(updated);
  }

  // ─────────── Заявка партнёру напрямую (F-13-137) ───────────

  async hasApplied(businessId: string, appId: string): Promise<boolean> {
    return (await this.prisma.integrationPartnerApplication.count({ where: { businessId, appId } })) > 0;
  }

  async apply(businessId: string, appId: string): Promise<Json> {
    const existing = await this.prisma.integrationPartnerApplication.findUnique({ where: { businessId_appId: { businessId, appId } } });
    const row = existing ?? (await this.prisma.integrationPartnerApplication.create({ data: { id: newId('integrationPartnerApplication'), businessId, appId } }));
    return { id: row.id, appId: row.appId, businessId: row.businessId, createdAt: iso(row.createdAt) };
  }

  // ─────────── Демо без обмена: звонок АТС, «Кого позвать», идентификаторы ───────────

  /** F-13-093: «Проверить звонок» — клиент бизнеса (телефон, имя, последний визит) либо «новый номер» */
  async demoIncomingCall(businessId: string): Promise<Json> {
    const total = await this.prisma.client.count({ where: { businessId, deletedAt: null } });
    if (total > 0 && Math.random() > 0.35) {
      const [client] = await this.prisma.client.findMany({ where: { businessId, deletedAt: null }, skip: Math.floor(Math.random() * total), take: 1, select: { id: true, name: true, phone: true } });
      if (client) {
        const last = await this.prisma.booking.findFirst({ where: { businessId, clientId: client.id, deletedAt: null, startAt: { lte: new Date() } }, orderBy: { startAt: 'desc' }, select: { startAt: true } });
        return { phone: client.phone, isKnown: true, clientId: client.id, clientName: client.name, ...(last ? { lastVisitAt: iso(last.startAt) } : {}) };
      }
    }
    const digits = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
    return { phone: `+374 ${digits.slice(0, 2)} ${digits.slice(2)}`, isKnown: false };
  }

  /** F-13-111: до 10 клиентов на завтрашнее окно с готовым текстом (демо-выбор, как мок) */
  async whoToCall(businessId: string, locationId: string): Promise<Json[]> {
    const location = await this.prisma.location.findFirst({ where: { id: locationId, businessId, deletedAt: null }, select: { id: true } });
    if (!location) return [];
    const [clients, staffLinks] = await Promise.all([
      this.prisma.client.findMany({ where: { businessId, deletedAt: null }, orderBy: { id: 'asc' }, take: WHO_TO_CALL_MAX, select: { id: true, name: true } }),
      this.prisma.staffLocation.findMany({ where: { locationId }, select: { staffId: true } }),
    ]);
    const staff = await this.prisma.staff.findMany({ where: { businessId, deletedAt: null, id: { in: staffLinks.map((s) => s.staffId) } }, orderBy: { id: 'asc' }, select: { name: true } });
    const tomorrow = iso(new Date(Date.now() + 24 * 60 * 60 * 1000));
    return clients.map((client, idx) => {
      const staffName = staff[idx % Math.max(staff.length, 1)]?.name ?? 'мастера';
      const firstName = client.name.split(' ')[0] ?? client.name;
      return {
        clientId: client.id,
        clientName: client.name,
        staffName,
        slotTime: tomorrow,
        reason: idx % 2 === 0 ? 'usualTime' : 'dueForService',
        message: `Привет, ${firstName}! У ${staffName} завтра свободно в ${10 + (idx % 8)}:00. Записать вас?`,
      };
    });
  }

  /** F-13-056: id филиалов/сотрудников/услуг для внешних систем; имена — как хранятся (JSON по языкам) */
  async identifiers(businessId: string): Promise<{ locations: { id: string; name: unknown }[]; staff: { id: string; name: string }[]; services: { id: string; name: unknown }[] }> {
    const [locations, staff, services] = await Promise.all([
      this.prisma.location.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true }, orderBy: { id: 'asc' } }),
      this.prisma.staff.findMany({ where: { businessId, deletedAt: null }, select: { id: true, name: true }, orderBy: { id: 'asc' } }),
      this.prisma.service.findMany({ where: { businessId }, select: { id: true, name: true }, orderBy: { id: 'asc' } }),
    ]);
    return { locations, staff, services };
  }
}
