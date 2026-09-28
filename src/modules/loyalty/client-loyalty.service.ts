import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import type { Permission } from '../../common/permissions/permissions.js';
import { normalizePhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { DEFAULT_TZ, utcToLocal, utcToLocalDate } from '../../common/time/time.js';
import { LoyaltyInstancesService } from './loyalty-instances.service.js';
import { requireAny, resolveScopeBusinessIds } from './loyalty.owner.js';
import type { PendingRow } from './port/client-ops.js';
import { LoyaltyPortRunner } from './port/runner.service.js';

type Kind = 'membership' | 'certificate';
const PENDING = 'pending_confirmation';
/** Отметка клиента «Я оплатил» по заявке (В-17) — строка журнала лояльности; synthTx её в срез не переводит */
const PAYMENT_SENT = 'paymentSent';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const MANAGE: Permission[] = ['loyalty.manage'];
const SELL: Permission[] = ['loyalty.manage', 'finance.edit'];

/**
 * Этап 21, лейн client-loyalty: функции src/api/client.ts фронта про абонементы/сертификаты/кэшбэк (приложение
 * клиента, заявки В-17, визит-приложение кабинета). Правила — фасад лояльности на сервере (port/, через
 * LoyaltyPortRunner и port/client-ops.ts), заявки — строки этапа 11 (LoyaltyInstancesService), здесь только кто
 * что видит: клиент — только своё (appUserId из сессии), кабинет — только свой бизнес из пути.
 */
@Injectable()
export class ClientLoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: LoyaltyPortRunner,
    private readonly instances: LoyaltyInstancesService,
  ) {}

  // ─────────── клиент приложения ───────────

  async me(userId: string, op: string, args: unknown[]): Promise<unknown> {
    const run = async (fn: string, fnArgs: unknown[], pending: PendingRow[] = [], extraBiz: string[] = []) => {
      const scope = await this.userScope(userId, [...pending.map((p) => p.businessId), ...extraBiz]);
      return this.runner.run(fn, fnArgs, { scope, appUserId: userId, actor: userId });
    };
    switch (op) {
      case 'listMemberships': {
        const pending = await this.pendingRows({ appUserId: userId, kind: 'membership' });
        return run('appListMemberships', [userId, pending], pending);
      }
      case 'getMembership': {
        const pending = await this.pendingRows({ appUserId: userId, kind: 'membership', id: str(args[0]) });
        return run('appGetMembership', [userId, str(args[0]), pending], pending);
      }
      case 'toggleMembershipFreeze':
        return run('appToggleMembershipFreeze', [userId, str(args[0])]);
      case 'toggleMembershipAutoRenew':
        return run('appToggleMembershipAutoRenew', [userId, str(args[0])]);
      case 'listCertificates': {
        const pending = await this.pendingRows({ appUserId: userId, kind: 'certificate' });
        return run('appListCertificates', [userId, pending], pending);
      }
      case 'getCertificate': {
        const pending = await this.pendingRows({ appUserId: userId, kind: 'certificate', id: str(args[0]) });
        return run('appGetCertificate', [userId, str(args[0]), pending], pending);
      }
      case 'listLoyaltyCards':
        return run('appListLoyaltyCards', [userId]);
      case 'getCashbackForBusiness':
        return run('appGetCashbackForBusiness', [userId, str(args[0])]);
      case 'getBookingMembershipOption':
        return run('appGetBookingMembershipOption', [userId, str(args[0]), str(args[1])]);
      case 'listPendingMembershipReminders':
        return run('appListPendingMembershipReminders', [userId]);
      case 'markMembershipReminderSeen':
        await run('appMarkMembershipReminderSeen', [userId, str(args[0])]);
        return null;
      case 'purchaseMembership':
        return this.purchase(userId, 'membership', str(args[0]));
      case 'purchaseCertificate':
        return this.purchase(userId, 'certificate', str(args[0]));
      case 'markMembershipPaymentSent':
        return this.markPaymentSent(userId, 'membership', str(args[0]));
      case 'markCertificatePaymentSent':
        return this.markPaymentSent(userId, 'certificate', str(args[0]));
      default:
        throw new ApiError('not_found', `Unknown op ${op}`);
    }
  }

  /** В-17: «Купить» — заявка ждёт оплаты по реквизитам и подтверждения бизнесом; тип обязан продаваться онлайн */
  private async purchase(userId: string, kind: Kind, typeId: string) {
    const type = kind === 'membership' ? await this.prisma.membershipType.findUnique({ where: { id: typeId }, select: { businessId: true } }) : await this.prisma.certificateType.findUnique({ where: { id: typeId }, select: { businessId: true } });
    if (!type) throw new ApiError('not_found', 'Type not found');
    const scope = await resolveScopeBusinessIds(this.prisma, type.businessId);
    const info = (await this.runner.run('appSaleTypeInfo', [kind, typeId], { scope, businessId: type.businessId, actor: userId })) as { businessId: string };
    const created = kind === 'membership' ? await this.instances.requestMembership(userId, info.businessId, typeId) : await this.instances.requestCertificate(userId, info.businessId, typeId);
    const [row] = await this.pendingRows({ appUserId: userId, kind, id: created.id });
    if (!row) throw new ApiError('not_found', 'Purchase not found');
    return this.runner.run('appPendingView', [row], { scope, businessId: type.businessId, actor: userId });
  }

  private async markPaymentSent(userId: string, kind: Kind, id: string) {
    const row = kind === 'membership' ? await this.prisma.membershipSale.findUnique({ where: { id } }) : await this.prisma.certificate.findUnique({ where: { id } });
    if (!row || row.appUserId !== userId) throw new ApiError('forbidden', 'Not your purchase');
    if (row.status !== PENDING) throw new ApiError('not_allowed', 'Purchase already decided');
    const already = await this.prisma.loyaltyTx.findFirst({ where: { source: kind, refId: id, kind: PAYMENT_SENT } });
    if (!already) await this.prisma.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: row.businessId, source: kind, refId: id, kind: PAYMENT_SENT, amount: 0, note: 'client' } });
    const [pending] = await this.pendingRows({ appUserId: userId, kind, id });
    const scope = await resolveScopeBusinessIds(this.prisma, row.businessId);
    return this.runner.run('appPendingView', [pending], { scope, businessId: row.businessId, actor: userId });
  }

  // ─────────── страница места без входа ───────────

  async pub(businessId: string, op: string, args: unknown[]): Promise<unknown> {
    const fn = ({ listPurchasableMemberships: 'appListPurchasableMemberships', listPurchasableCertificates: 'appListPurchasableCertificates', findRenewTemplate: 'appFindRenewTemplate' } as Record<string, string>)[op];
    if (!fn) throw new ApiError('not_found', `Unknown op ${op}`);
    const exists = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!exists) throw new ApiError('not_found', 'Business not found');
    const scope = await resolveScopeBusinessIds(this.prisma, businessId);
    return this.runner.run(fn, [businessId, ...args], { businessId, scope, actor: 'public' });
  }

  // ─────────── кабинет ───────────

  async biz(ctx: RequestContext, businessId: string, op: string, args: unknown[]): Promise<unknown> {
    const run = async (fn: string, fnArgs: unknown[]) => this.runner.run(fn, fnArgs, { businessId, scope: await resolveScopeBusinessIds(this.prisma, businessId), actor: ctx.member!.staffId });
    switch (op) {
      case 'listPurchaseRequests':
        return this.listRequests(businessId, args[0] === 'all' ? 'all' : 'pendingConfirmation');
      case 'countPendingPurchaseRequests': {
        const where = { businessId, status: PENDING, appUserId: { not: null } };
        const [m, c] = await Promise.all([this.prisma.membershipSale.count({ where }), this.prisma.certificate.count({ where })]);
        return m + c;
      }
      case 'confirmMembershipPurchase':
      case 'confirmCertificatePurchase': {
        requireAny(ctx, SELL);
        const kind: Kind = op === 'confirmMembershipPurchase' ? 'membership' : 'certificate';
        const row = await this.ownRequest(kind, businessId, str(args[0]));
        const clientId = await this.linkClient(businessId, row.appUserId!);
        await this.decide(ctx, kind, row, 'confirm', clientId);
        return run(kind === 'membership' ? 'appGetMembership' : 'appGetCertificate', [row.appUserId, row.id]);
      }
      case 'rejectMembershipPurchase':
      case 'rejectCertificatePurchase': {
        requireAny(ctx, SELL);
        const kind: Kind = op === 'rejectMembershipPurchase' ? 'membership' : 'certificate';
        const row = await this.ownRequest(kind, businessId, str(args[0]));
        await this.decide(ctx, kind, row, 'reject');
        const [pending] = await this.pendingRows({ appUserId: row.appUserId!, kind, id: row.id });
        return run('appPendingView', [pending]);
      }
      case 'countVisitLoyaltyOptions':
        return run('appCountVisitLoyaltyOptions', [businessId, optStr(args[0])]);
      case 'issueLoyaltyCard':
        requireAny(ctx, SELL);
        return run('appIssueLoyaltyCard', [businessId, str(args[0]), optStr(args[1])]);
      case 'findLoyaltyByCode':
        return run('appFindLoyaltyByCode', [businessId, str(args[0])]);
      case 'getCashbackVisibleForBusiness':
        return run('appGetCashbackVisibleForBusiness', [businessId]);
      case 'setCashbackVisibleForBusiness':
        requireAny(ctx, MANAGE);
        await run('appSetCashbackVisibleForBusiness', [businessId, args[0] === true]);
        return null;
      default:
        throw new ApiError('not_found', `Unknown op ${op}`);
    }
  }

  /**
   * Решение по заявке (В-17): подтвердить — актив действует и привязан к карточке клиента бизнеса; отклонить —
   * остаётся видна клиенту отклонённой. Одна транзакция с условием «ещё ждёт» — два администратора не решат дважды.
   * (Не через LoyaltyInstancesService.confirm*: тот ищет тип по владельцу сессии, а бизнес заявки уже проверен по пути.)
   */
  private async decide(ctx: RequestContext, kind: Kind, row: { id: string; businessId: string; total?: bigint }, action: 'confirm' | 'reject', clientId?: string) {
    const data = action === 'confirm' ? { status: 'active', ...(clientId ? { clientId } : {}), updatedBy: ctx.member!.staffId, version: { increment: 1 } } : { status: 'rejected', updatedBy: ctx.member!.staffId, version: { increment: 1 } };
    await this.prisma.$transaction(async (tx) => {
      const res = kind === 'membership' ? await tx.membershipSale.updateMany({ where: { id: row.id, status: PENDING }, data }) : await tx.certificate.updateMany({ where: { id: row.id, status: PENDING }, data });
      if (res.count !== 1) throw new ApiError('already_confirmed', 'Purchase already decided');
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: row.businessId, clientId: clientId ?? null, source: kind, refId: row.id, kind: action, amount: row.total ?? 0n, staffId: ctx.member!.staffId } });
    });
  }

  /** Заявка приложения этого бизнеса (В-17) — чужой бизнес/не заявка приложения → 404 */
  private async ownRequest(kind: Kind, businessId: string, id: string) {
    const row = kind === 'membership' ? await this.prisma.membershipSale.findUnique({ where: { id } }) : await this.prisma.certificate.findUnique({ where: { id } });
    if (!row || row.businessId !== businessId || !row.appUserId) throw new ApiError('not_found', 'Purchase request not found');
    return row;
  }

  /** Список заявок бизнеса (раздел «Лояльность» → «Заявки на покупку»); 'all' — все покупки приложения */
  private async listRequests(businessId: string, status: 'pendingConfirmation' | 'all') {
    const where = { businessId, appUserId: { not: null }, ...(status === 'all' ? {} : { status: PENDING }) };
    const [mems, certs] = await Promise.all([this.prisma.membershipSale.findMany({ where, include: { type: true } }), this.prisma.certificate.findMany({ where })]);
    const ids = [...mems.map((m) => m.id), ...certs.map((c) => c.id)];
    const userIds = [...new Set([...mems, ...certs].map((r) => r.appUserId!))];
    const [users, sent] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true } }),
      ids.length ? this.prisma.loyaltyTx.findMany({ where: { refId: { in: ids }, kind: PAYMENT_SENT } }) : Promise.resolve([]),
    ]);
    const userOf = new Map(users.map((u) => [u.id, u]));
    const sentOf = new Map(sent.map((t) => [t.refId, utcToLocal(t.createdAt, DEFAULT_TZ)]));
    const label = (id: string) => {
      const u = userOf.get(id);
      return { clientName: u?.name || id, ...(u?.phone ? { clientPhone: u.phone } : {}) };
    };
    const st = (s: string) => (s === PENDING ? 'pendingConfirmation' : s === 'rejected' ? 'rejected' : 'confirmed');
    const rows = [
      ...mems.map((m) => {
        const data = (m.type.data ?? {}) as { onlineSale?: { title?: { ru?: string }; price?: number } };
        return {
          id: m.id,
          kind: 'membership' as const,
          businessId: m.businessId,
          itemName: data.onlineSale?.title?.ru || m.type.name,
          price: data.onlineSale?.price ?? Number(m.type.price),
          status: st(m.status),
          purchasedAt: utcToLocal(m.soldAt, DEFAULT_TZ),
          ...(sentOf.has(m.id) ? { paymentSentAt: sentOf.get(m.id) } : {}),
          ...label(m.appUserId!),
        };
      }),
      ...certs.map((c) => ({
        id: c.id,
        kind: 'certificate' as const,
        businessId: c.businessId,
        itemName: c.code,
        price: Number(c.total),
        status: st(c.status),
        purchasedAt: utcToLocal(c.soldAt, DEFAULT_TZ),
        ...(sentOf.has(c.id) ? { paymentSentAt: sentOf.get(c.id) } : {}),
        ...label(c.appUserId!),
      })),
    ];
    return rows.sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1));
  }

  // ─────────── общее ───────────

  /** Заявки клиента (ждут/отклонены), не входящие в срез раздела — форма для port/client-ops.ts */
  private async pendingRows(q: { appUserId: string; kind: Kind; id?: string }): Promise<PendingRow[]> {
    const where = { appUserId: q.appUserId, status: { in: [PENDING, 'rejected'] }, ...(q.id ? { id: q.id } : {}) };
    const rows =
      q.kind === 'membership'
        ? (await this.prisma.membershipSale.findMany({ where, orderBy: { soldAt: 'asc' } })).map((r) => ({ ...r, typeIdRef: r.typeId, total: 0n, visits: r.totalVisits ?? 0 }))
        : (await this.prisma.certificate.findMany({ where, orderBy: { soldAt: 'asc' } })).map((r) => ({ ...r, typeIdRef: r.typeId, visits: 0 }));
    if (!rows.length) return [];
    const sent = await this.prisma.loyaltyTx.findMany({ where: { refId: { in: rows.map((r) => r.id) }, kind: PAYMENT_SENT } });
    const sentOf = new Map(sent.map((t) => [t.refId, utcToLocal(t.createdAt, DEFAULT_TZ)]));
    return rows.map((r) => ({
      kind: q.kind,
      id: r.id,
      businessId: r.businessId,
      typeId: r.typeIdRef,
      appUserId: q.appUserId,
      code: r.code,
      status: r.status === PENDING ? 'pendingConfirmation' : 'rejected',
      soldAt: utcToLocal(r.soldAt, DEFAULT_TZ),
      expiresAt: utcToLocalDate(r.expiresAt, DEFAULT_TZ),
      total: Number(r.total),
      totalVisits: r.visits,
      ...(sentOf.has(r.id) ? { paymentSentAt: sentOf.get(r.id)! } : {}),
    }));
  }

  /** Бизнесы, где у клиента карточка (и их сети), плюс бизнесы его заявок */
  private async userScope(userId: string, extra: string[]): Promise<string[]> {
    const rows = await this.prisma.client.findMany({ where: { appUserId: userId, deletedAt: null }, select: { businessId: true } });
    const direct = [...new Set([...rows.map((r) => r.businessId), ...extra.filter(Boolean)])];
    const all = await Promise.all(direct.map((b) => resolveScopeBusinessIds(this.prisma, b)));
    return [...new Set(all.flat())];
  }

  /**
   * Карточка клиента бизнеса для подтверждённой покупки (В-17): уже привязанная к этому appUserId, иначе по его
   * телефону (и привязать), иначе новая — как клиент записи из приложения (journal/bookings.service.ts linkClient).
   */
  private async linkClient(businessId: string, appUserId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id: appUserId }, include: { appProfile: true } });
    if (!user) return undefined;
    const phone = user.phone ? (normalizePhone(user.phone) ?? user.phone) : null;
    const found =
      (await this.prisma.client.findFirst({ where: { businessId, appUserId, deletedAt: null } })) ??
      (phone ? await this.prisma.client.findFirst({ where: { businessId, phone, deletedAt: null } }) : null);
    if (found) {
      if (!found.appUserId) await this.prisma.client.update({ where: { id: found.id }, data: { appUserId } });
      return found.id;
    }
    if (!phone) return undefined;
    const id = newId('client');
    await this.prisma.client.create({
      data: { id, businessId, phone, name: user.name, gender: user.appProfile?.gender ?? 'unknown', birthday: user.appProfile?.birthday ?? null, tags: [], appUserId, source: 'app' },
    });
    return id;
  }
}
