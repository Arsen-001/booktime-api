import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { newId } from '../../common/ids/ids.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { applyLineBody } from './loyalty.schemas.js';
import { networkBusinessIds, ownerOf } from './loyalty.owner.js';

type ApplyLine = z.infer<typeof applyLineBody>;

function genCode(): string {
  // 10 цифр — печатается на карте/сертификате, вводится в поиске окна записи (F-04-099)
  return String(Date.now()).slice(-6) + String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
}

@Injectable()
export class LoyaltyInstancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────── Карты клиентов (F-06-051…060) ───────────────────────────

  private cardView(r: { id: string; cardTypeId: string; businessId: string; clientId: string | null; appUserId: string | null; number: string; balance: bigint; version: number; createdAt: Date; cardType: { networkWide: boolean; cashbackVisibleInApp: boolean } }) {
    return { id: r.id, cardTypeId: r.cardTypeId, businessId: r.businessId, clientId: r.clientId, appUserId: r.appUserId, number: r.number, balance: moneyToJson(r.balance), networkWide: r.cardType.networkWide, cashbackVisibleInApp: r.cardType.cashbackVisibleInApp, createdAt: r.createdAt.toISOString(), version: r.version };
  }

  async listClientCards(ctx: RequestContext, clientId: string) {
    const rows = await this.prisma.loyaltyCard.findMany({ where: { clientId, cardType: { ownerId: ownerOf(ctx) } }, include: { cardType: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.cardView(r));
  }

  async issueCard(ctx: RequestContext, clientId: string, cardTypeId: string, number?: string) {
    const type = await this.prisma.loyaltyCardType.findFirst({ where: { id: cardTypeId, ownerId: ownerOf(ctx) } });
    if (!type) throw new ApiError('not_found', 'Card type not found');
    if (type.archived) throw new ApiError('not_active', 'Card type is archived');
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId: { in: await networkBusinessIds(this.prisma, ctx) }, deletedAt: null } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const id = newId('loyaltyCard');
    const num = number?.trim() || genCode();
    // номер карты уникален в бизнесе (этап 21, лейн loyalty: @@unique([businessId, number]))
    const dup = await this.prisma.loyaltyCard.findFirst({ where: { businessId: client.businessId, number: num } });
    if (dup) throw new ApiError('duplicate_number', 'Card number already issued');
    await this.prisma.$transaction(async (tx) => {
      await tx.loyaltyCard.create({ data: { id, cardTypeId, businessId: client.businessId, clientId, number: num, createdBy: ctx.member!.staffId, updatedBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'issue', entityType: 'loyaltyCard', entityId: id, businessId: client.businessId, after: { clientId, cardTypeId, number: num } });
    });
    return this.listClientCards(ctx, clientId).then((rows) => rows.find((r) => r.id === id)!);
  }

  /** Ручное начисление/списание бонусов (F-06-051…060) */
  async adjustBonus(ctx: RequestContext, cardId: string, kind: 'accrual' | 'charge', amount: number, note?: string) {
    const card = await this.prisma.loyaltyCard.findFirst({ where: { id: cardId, cardType: { ownerId: ownerOf(ctx) } }, include: { cardType: true } });
    if (!card) throw new ApiError('not_found', 'Card not found');
    const delta = BigInt(amount);
    await this.prisma.$transaction(async (tx) => {
      if (kind === 'accrual') {
        await tx.loyaltyCard.update({ where: { id: cardId }, data: { balance: { increment: delta }, version: { increment: 1 } } });
      } else {
        const res = await tx.loyaltyCard.updateMany({ where: { id: cardId, balance: { gte: delta } }, data: { balance: { decrement: delta }, version: { increment: 1 } } });
        if (res.count !== 1) throw new ApiError('insufficient_balance', 'Not enough bonus balance');
      }
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: card.businessId, clientId: card.clientId, source: 'card', refId: cardId, kind, amount: delta, note, staffId: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: kind, entityType: 'loyaltyCard', entityId: cardId, businessId: card.businessId, after: { amount } });
    });
    const updated = await this.prisma.loyaltyCard.findUniqueOrThrow({ where: { id: cardId }, include: { cardType: true } });
    return this.cardView(updated);
  }

  // ─────────────────────────── Транзакции (F-06-076/077) ───────────────────────────

  async listTx(ctx: RequestContext, clientId?: string) {
    const businessIds = await networkBusinessIds(this.prisma, ctx);
    const rows = await this.prisma.loyaltyTx.findMany({ where: { businessId: { in: businessIds }, ...(clientId ? { clientId } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map((r) => ({ id: r.id, businessId: r.businessId, clientId: r.clientId, source: r.source, refId: r.refId, kind: r.kind, amount: moneyToJson(r.amount), bookingId: r.bookingId, note: r.note, staffId: r.staffId, createdAt: r.createdAt.toISOString() }));
  }

  // ─────────────────────────── Сертификаты (F-06-086…104) ───────────────────────────

  private certView(r: { id: string; typeId: string; businessId: string; clientId: string | null; appUserId: string | null; code: string; total: bigint; balance: bigint; status: string; soldAt: Date; expiresAt: Date; version: number }) {
    return { id: r.id, typeId: r.typeId, businessId: r.businessId, clientId: r.clientId, appUserId: r.appUserId, code: r.code, total: moneyToJson(r.total), balance: moneyToJson(r.balance), status: r.status, soldAt: r.soldAt.toISOString(), expiresAt: r.expiresAt.toISOString(), version: r.version };
  }

  async sellCertificate(ctx: RequestContext, typeId: string, opts: { clientId?: string; appUserId?: string; total?: number }) {
    const type = await this.prisma.certificateType.findFirst({ where: { id: typeId, ownerId: ownerOf(ctx) } });
    if (!type) throw new ApiError('not_found', 'Certificate type not found');
    if (type.archived) throw new ApiError('not_active', 'Certificate type is archived');
    const id = newId('certificate');
    const now = new Date();
    const total = BigInt(opts.total ?? Number(type.faceValue));
    const code = genCode();
    await this.prisma.$transaction(async (tx) => {
      await tx.certificate.create({ data: { id, typeId, businessId: ctx.member!.businessId, clientId: opts.clientId, appUserId: opts.appUserId, code, total, balance: total, status: 'active', soldAt: now, expiresAt: new Date(now.getTime() + type.validDays * 86_400_000), createdBy: ctx.member!.staffId } });
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: ctx.member!.businessId, clientId: opts.clientId, source: 'certificate', refId: id, kind: 'issue', amount: total, staffId: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'sell', entityType: 'certificate', entityId: id, businessId: ctx.member!.businessId, after: { typeId, total: Number(total) } });
    });
    return this.prisma.certificate.findUniqueOrThrow({ where: { id } }).then((r) => this.certView(r));
  }

  /** В-17: клиент из приложения — заявка «ждёт подтверждения», без clientId (привязывается при подтверждении) */
  async requestCertificate(userId: string, businessId: string, typeId: string) {
    const type = await this.prisma.certificateType.findFirst({ where: { id: typeId } });
    if (!type) throw new ApiError('not_found', 'Certificate type not found');
    if (type.archived) throw new ApiError('not_active', 'Certificate type is archived');
    const id = newId('certificate');
    const now = new Date();
    await this.prisma.certificate.create({ data: { id, typeId, businessId, appUserId: userId, code: genCode(), total: type.faceValue, balance: type.faceValue, status: 'pending_confirmation', soldAt: now, expiresAt: new Date(now.getTime() + type.validDays * 86_400_000) } });
    return this.certView(await this.prisma.certificate.findUniqueOrThrow({ where: { id } }));
  }

  async confirmCertificate(ctx: RequestContext, id: string, clientId?: string) {
    const row = await this.prisma.certificate.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Certificate not found');
    if (row.status !== 'pending_confirmation') throw new ApiError('already_confirmed', 'Certificate already decided');
    await this.prisma.$transaction(async (tx) => {
      await tx.certificate.update({ where: { id }, data: { status: 'active', clientId: clientId ?? row.clientId, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: row.businessId, clientId: clientId ?? row.clientId, source: 'certificate', refId: id, kind: 'confirm', amount: row.total, staffId: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'confirm', entityType: 'certificate', entityId: id, businessId: row.businessId, after: { status: 'active' } });
    });
    return this.certView(await this.prisma.certificate.findUniqueOrThrow({ where: { id } }));
  }

  async rejectCertificate(ctx: RequestContext, id: string) {
    const row = await this.prisma.certificate.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Certificate not found');
    if (row.status !== 'pending_confirmation') throw new ApiError('already_confirmed', 'Certificate already decided');
    await this.prisma.certificate.update({ where: { id }, data: { status: 'rejected', updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    return this.certView(await this.prisma.certificate.findUniqueOrThrow({ where: { id } }));
  }

  /** В-17: заявки клиентов «ждут подтверждения» */
  async listPendingCertificates(ctx: RequestContext) {
    const rows = await this.prisma.certificate.findMany({ where: { status: 'pending_confirmation', type: { ownerId: ownerOf(ctx) } }, orderBy: { soldAt: 'asc' } });
    return rows.map((r) => this.certView(r));
  }

  async refundCertificate(ctx: RequestContext, id: string) {
    const row = await this.prisma.certificate.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Certificate not found');
    if (row.status !== 'active') throw new ApiError('not_active', 'Only an active certificate can be refunded');
    await this.prisma.$transaction(async (tx) => {
      await tx.certificate.update({ where: { id }, data: { status: 'refunded', updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: row.businessId, clientId: row.clientId, source: 'certificate', refId: id, kind: 'refund', amount: row.balance, staffId: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'refund', entityType: 'certificate', entityId: id, businessId: row.businessId, after: { status: 'refunded' } });
    });
    return this.certView(await this.prisma.certificate.findUniqueOrThrow({ where: { id } }));
  }

  // ─────────────────────────── Абонементы (F-06-105…134) ───────────────────────────

  private membershipView(r: { id: string; typeId: string; businessId: string; clientId: string | null; appUserId: string | null; code: string; totalVisits: number | null; remainingVisits: number | null; status: string; soldAt: Date; expiresAt: Date; frozenUntil: Date | null; version: number }) {
    return { id: r.id, typeId: r.typeId, businessId: r.businessId, clientId: r.clientId, appUserId: r.appUserId, code: r.code, totalVisits: r.totalVisits, remainingVisits: r.remainingVisits, status: r.status, soldAt: r.soldAt.toISOString(), expiresAt: r.expiresAt.toISOString(), frozenUntil: r.frozenUntil?.toISOString() ?? null, version: r.version };
  }

  async sellMembership(ctx: RequestContext, typeId: string, opts: { clientId?: string; appUserId?: string }) {
    const type = await this.prisma.membershipType.findFirst({ where: { id: typeId, ownerId: ownerOf(ctx) } });
    if (!type) throw new ApiError('not_found', 'Membership type not found');
    if (type.archived) throw new ApiError('not_active', 'Membership type is archived');
    const id = newId('membershipSale');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipSale.create({ data: { id, typeId, businessId: ctx.member!.businessId, clientId: opts.clientId, appUserId: opts.appUserId, code: genCode(), totalVisits: type.totalVisits, remainingVisits: type.totalVisits, status: 'active', soldAt: now, expiresAt: new Date(now.getTime() + type.validDays * 86_400_000), createdBy: ctx.member!.staffId } });
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: ctx.member!.businessId, clientId: opts.clientId, source: 'membership', refId: id, kind: 'issue', amount: type.price, staffId: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'sell', entityType: 'membershipSale', entityId: id, businessId: ctx.member!.businessId, after: { typeId } });
    });
    return this.membershipView(await this.prisma.membershipSale.findUniqueOrThrow({ where: { id } }));
  }

  /** В-17: заявка клиента из приложения */
  async requestMembership(userId: string, businessId: string, typeId: string) {
    const type = await this.prisma.membershipType.findFirst({ where: { id: typeId } });
    if (!type) throw new ApiError('not_found', 'Membership type not found');
    if (type.archived) throw new ApiError('not_active', 'Membership type is archived');
    const id = newId('membershipSale');
    const now = new Date();
    await this.prisma.membershipSale.create({ data: { id, typeId, businessId, appUserId: userId, code: genCode(), totalVisits: type.totalVisits, remainingVisits: type.totalVisits, status: 'pending_confirmation', soldAt: now, expiresAt: new Date(now.getTime() + type.validDays * 86_400_000) } });
    return this.membershipView(await this.prisma.membershipSale.findUniqueOrThrow({ where: { id } }));
  }

  /** В-17: заявки клиентов «ждут подтверждения» */
  async listPendingMemberships(ctx: RequestContext) {
    const rows = await this.prisma.membershipSale.findMany({ where: { status: 'pending_confirmation', type: { ownerId: ownerOf(ctx) } }, orderBy: { soldAt: 'asc' } });
    return rows.map((r) => this.membershipView(r));
  }

  async confirmMembership(ctx: RequestContext, id: string, clientId?: string) {
    const row = await this.prisma.membershipSale.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Membership not found');
    if (row.status !== 'pending_confirmation') throw new ApiError('already_confirmed', 'Membership already decided');
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipSale.update({ where: { id }, data: { status: 'active', clientId: clientId ?? row.clientId, updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'confirm', entityType: 'membershipSale', entityId: id, businessId: row.businessId, after: { status: 'active' } });
    });
    return this.membershipView(await this.prisma.membershipSale.findUniqueOrThrow({ where: { id } }));
  }

  async rejectMembership(ctx: RequestContext, id: string) {
    const row = await this.prisma.membershipSale.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Membership not found');
    if (row.status !== 'pending_confirmation') throw new ApiError('already_confirmed', 'Membership already decided');
    await this.prisma.membershipSale.update({ where: { id }, data: { status: 'rejected', updatedBy: ctx.member!.staffId, version: { increment: 1 } } });
    return this.membershipView(await this.prisma.membershipSale.findUniqueOrThrow({ where: { id } }));
  }

  async freezeMembership(ctx: RequestContext, id: string, frozen: boolean, toAt?: string) {
    const row = await this.prisma.membershipSale.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Membership not found');
    if (frozen) {
      if (row.status !== 'active') throw new ApiError('not_active', 'Only an active membership can be frozen');
      const until = toAt ? new Date(toAt) : new Date(Date.now() + 7 * 86_400_000);
      await this.prisma.$transaction(async (tx) => {
        await tx.membershipSale.update({ where: { id }, data: { status: 'frozen', frozenUntil: until, expiresAt: new Date(row.expiresAt.getTime() + (until.getTime() - Date.now())), version: { increment: 1 } } });
        await tx.membershipFreeze.create({ data: { id: newId('membershipFreeze'), membershipId: id, fromAt: new Date(), toAt: until, createdBy: ctx.member!.staffId } });
        await this.audit.record(tx, ctx, { action: 'freeze', entityType: 'membershipSale', entityId: id, businessId: row.businessId, after: { frozenUntil: until.toISOString() } });
      });
    } else {
      if (row.status !== 'frozen') throw new ApiError('not_active', 'Membership is not frozen');
      await this.prisma.membershipSale.update({ where: { id }, data: { status: 'active', frozenUntil: null, version: { increment: 1 } } });
    }
    return this.membershipView(await this.prisma.membershipSale.findUniqueOrThrow({ where: { id } }));
  }

  async refundMembership(ctx: RequestContext, id: string) {
    const row = await this.prisma.membershipSale.findFirst({ where: { id, type: { ownerId: ownerOf(ctx) } } });
    if (!row) throw new ApiError('not_found', 'Membership not found');
    if (row.status !== 'active' && row.status !== 'frozen') throw new ApiError('not_active', 'Only an active/frozen membership can be refunded');
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipSale.update({ where: { id }, data: { status: 'refunded', version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'refund', entityType: 'membershipSale', entityId: id, businessId: row.businessId, after: { status: 'refunded' } });
    });
    return this.membershipView(await this.prisma.membershipSale.findUniqueOrThrow({ where: { id } }));
  }

  // ─────────────────────────── Счета клиентов (F-06-135…146) ───────────────────────────

  private accountView(r: { id: string; typeId: string; businessId: string; clientId: string; balance: bigint; version: number }) {
    return { id: r.id, typeId: r.typeId, businessId: r.businessId, clientId: r.clientId, balance: moneyToJson(r.balance), version: r.version };
  }

  // ─────────── CRM клиента: сертификаты+абонементы одного клиента, поиск по коду (F-04-093/099, этап 21 «rest») ───────────
  // Форма ровно `@/domain/clients` (Certificate/Subscription простой мока, НЕ `@/domain/loyalty`'s более богатый тип
  // порта этапа 21 «loyalty» — колонки Prisma достаточно, `data` JSON не нужен для этой пары экранов).

  async listClientAssets(businessId: string, clientId: string) {
    // Мок не фильтрует по статусу вообще (отдаёт всё, что есть у клиента) — держим то же самое: сид пишет
    // статусы порта этапа 21 «loyalty» (`issued`/`used`/`deactivated`…, `port/domain.ts::MembershipStatus`),
    // не старый список колонки, фильтр по одному-двум значениям молча терял бы половину сида.
    const [certs, subs] = await Promise.all([
      this.prisma.certificate.findMany({ where: { businessId, clientId }, include: { type: true } }),
      this.prisma.membershipSale.findMany({ where: { businessId, clientId }, include: { type: true } }),
    ]);
    const now = Date.now();
    return {
      certificates: certs.map((c) => ({
        id: c.id,
        businessId: c.businessId,
        clientId: c.clientId!,
        name: c.type.name,
        total: moneyToJson(c.total),
        balance: moneyToJson(c.balance),
        soldAt: c.soldAt.toISOString().slice(0, 10),
        expiresAt: c.expiresAt.toISOString().slice(0, 10),
        code: c.code,
      })),
      subscriptions: subs.map((s) => ({
        id: s.id,
        businessId: s.businessId,
        clientId: s.clientId!,
        name: s.type.name,
        status: (s.expiresAt.getTime() < now ? 'expired' : 'active') as 'active' | 'expired',
        frozen: s.status === 'frozen',
        soldAt: s.soldAt.toISOString().slice(0, 10),
        expiresAt: s.expiresAt.toISOString().slice(0, 10),
        totalVisits: s.totalVisits ?? 0,
        remainingVisits: s.remainingVisits ?? 0,
        code: s.code,
      })),
    };
  }

  async findClientByCode(businessId: string, code: string): Promise<{ clientId: string; clientName: string } | undefined> {
    const trimmed = code.trim();
    if (!trimmed) return undefined;
    const sub = await this.prisma.membershipSale.findFirst({ where: { businessId, code: trimmed } });
    const clientId = sub?.clientId ?? (await this.prisma.certificate.findFirst({ where: { businessId, code: trimmed } }))?.clientId;
    if (!clientId) return undefined;
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId, deletedAt: null } });
    if (!client) return undefined;
    return { clientId, clientName: client.name };
  }

  async listClientAccounts(ctx: RequestContext, clientId: string) {
    const rows = await this.prisma.clientAccount.findMany({ where: { clientId, type: { ownerId: ownerOf(ctx) } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.accountView(r));
  }

  async openAccount(ctx: RequestContext, typeId: string, clientId: string) {
    const type = await this.prisma.clientAccountType.findFirst({ where: { id: typeId, ownerId: ownerOf(ctx) } });
    if (!type) throw new ApiError('not_found', 'Account type not found');
    if (type.archived) throw new ApiError('not_active', 'Account type is archived');
    const existing = await this.prisma.clientAccount.findFirst({ where: { typeId, clientId } });
    if (existing) throw new ApiError('conflict', 'Account already open');
    const id = newId('clientAccount');
    await this.prisma.$transaction(async (tx) => {
      await tx.clientAccount.create({ data: { id, typeId, businessId: ctx.member!.businessId, clientId, createdBy: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: 'open', entityType: 'clientAccount', entityId: id, businessId: ctx.member!.businessId, after: { typeId, clientId } });
    });
    return this.accountView(await this.prisma.clientAccount.findUniqueOrThrow({ where: { id } }));
  }

  async accountOp(ctx: RequestContext, accountId: string, kind: 'topup' | 'charge' | 'refund', amount: number, note?: string, bookingId?: string) {
    const account = await this.prisma.clientAccount.findFirst({ where: { id: accountId, type: { ownerId: ownerOf(ctx) } } });
    if (!account) throw new ApiError('not_found', 'Account not found');
    const delta = BigInt(amount);
    await this.prisma.$transaction(async (tx) => {
      if (kind === 'topup') {
        await tx.clientAccount.update({ where: { id: accountId }, data: { balance: { increment: delta }, version: { increment: 1 } } });
      } else {
        const res = await tx.clientAccount.updateMany({ where: { id: accountId, balance: { gte: delta } }, data: { balance: { decrement: delta }, version: { increment: 1 } } });
        if (res.count !== 1) throw new ApiError('insufficient_balance', 'Not enough account balance');
      }
      await tx.clientAccountOp.create({ data: { id: newId('clientAccountOp'), accountId, kind, amount: delta, bookingId, note, staffId: ctx.member!.staffId } });
      await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId: account.businessId, clientId: account.clientId, source: 'account', refId: accountId, kind: kind === 'topup' ? 'topup' : kind === 'charge' ? 'apply' : 'refund', amount: delta, bookingId, staffId: ctx.member!.staffId } });
      await this.audit.record(tx, ctx, { action: kind, entityType: 'clientAccount', entityId: accountId, businessId: account.businessId, after: { amount } });
    });
    return this.accountView(await this.prisma.clientAccount.findUniqueOrThrow({ where: { id: accountId } }));
  }

  // ─────────────────────────── Применение при оплате визита (F-06-061…075) ───────────────────────────

  /** Списывает лояльность и дописывает строки оплаты в booking.extras.payments (finance.edit) */
  async applyToBooking(ctx: RequestContext, businessId: string, bookingId: string, lines: ApplyLine[]) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!booking) throw new ApiError('not_found', 'Booking not found');
    if (booking.deletedAt) throw new ApiError('not_found', 'Booking not found');

    const extras = (booking.extras && typeof booking.extras === 'object' ? { ...(booking.extras as Record<string, unknown>) } : {}) as { payments?: { id: string; method: string; amount: number; label: string; refId?: string; at: string }[] };
    const payments = Array.isArray(extras.payments) ? [...extras.payments] : [];
    let totalApplied = 0n;

    await this.prisma.$transaction(async (tx) => {
      for (const line of lines) {
        const amount = BigInt(line.amount);
        let label = '';
        if (line.method === 'card_bonus') {
          const card = await tx.loyaltyCard.findFirst({ where: { id: line.refId, cardType: { ownerId: ownerOf(ctx) } } });
          if (!card) throw new ApiError('not_found', 'Card not found');
          const res = await tx.loyaltyCard.updateMany({ where: { id: line.refId, balance: { gte: amount } }, data: { balance: { decrement: amount }, version: { increment: 1 } } });
          if (res.count !== 1) throw new ApiError('insufficient_balance', 'Not enough bonus balance');
          await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId, clientId: booking.clientId, source: 'card', refId: line.refId, kind: 'apply', amount, bookingId, staffId: ctx.member!.staffId } });
          label = `Бонусами карты №${card.number}`;
        } else if (line.method === 'certificate') {
          const cert = await tx.certificate.findFirst({ where: { id: line.refId, type: { ownerId: ownerOf(ctx) } } });
          if (!cert) throw new ApiError('not_found', 'Certificate not found');
          if (cert.status !== 'active') throw new ApiError('not_active', 'Certificate is not active');
          if (cert.expiresAt.getTime() < Date.now()) throw new ApiError('expired', 'Certificate expired');
          const res = await tx.certificate.updateMany({ where: { id: line.refId, balance: { gte: amount } }, data: { balance: { decrement: amount }, version: { increment: 1 } } });
          if (res.count !== 1) throw new ApiError('insufficient_balance', 'Not enough certificate balance');
          await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId, clientId: booking.clientId, source: 'certificate', refId: line.refId, kind: 'apply', amount, bookingId, staffId: ctx.member!.staffId } });
          label = `Сертификат №${cert.code}`;
        } else if (line.method === 'membership') {
          const m = await tx.membershipSale.findFirst({ where: { id: line.refId, type: { ownerId: ownerOf(ctx) } } });
          if (!m) throw new ApiError('not_found', 'Membership not found');
          if (m.status !== 'active') throw new ApiError('not_active', 'Membership is not active');
          if (m.expiresAt.getTime() < Date.now()) throw new ApiError('expired', 'Membership expired');
          if (m.remainingVisits !== null) {
            if (m.remainingVisits < 1) throw new ApiError('insufficient_balance', 'No visits left on membership');
            const remaining = m.remainingVisits - 1;
            await tx.membershipSale.update({ where: { id: line.refId }, data: { remainingVisits: remaining, status: remaining <= 0 ? 'expired' : m.status, version: { increment: 1 } } });
          }
          await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId, clientId: booking.clientId, source: 'membership', refId: line.refId, kind: 'apply', amount, bookingId, staffId: ctx.member!.staffId } });
          label = `Абонемент №${m.code}`;
        } else {
          const account = await tx.clientAccount.findFirst({ where: { id: line.refId, type: { ownerId: ownerOf(ctx) } } });
          if (!account) throw new ApiError('not_found', 'Account not found');
          const res = await tx.clientAccount.updateMany({ where: { id: line.refId, balance: { gte: amount } }, data: { balance: { decrement: amount }, version: { increment: 1 } } });
          if (res.count !== 1) throw new ApiError('insufficient_balance', 'Not enough account balance');
          await tx.clientAccountOp.create({ data: { id: newId('clientAccountOp'), accountId: line.refId, kind: 'charge', amount, bookingId, staffId: ctx.member!.staffId } });
          await tx.loyaltyTx.create({ data: { id: newId('loyaltyTx'), businessId, clientId: booking.clientId, source: 'account', refId: line.refId, kind: 'apply', amount, bookingId, staffId: ctx.member!.staffId } });
          label = 'Личный счёт';
        }
        payments.push({ id: newId('payment'), method: line.method, amount: Number(amount), label, refId: line.refId, at: new Date().toISOString() });
        totalApplied += amount;
      }
      await tx.booking.update({ where: { id: bookingId }, data: { extras: { ...extras, payments } as Prisma.InputJsonValue, paidAmount: { increment: totalApplied }, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'loyaltyApply', entityType: 'booking', entityId: bookingId, businessId, after: { lines } });
    });

    return { paidAmount: moneyToJson(booking.paidAmount + totalApplied), payments };
  }
}
