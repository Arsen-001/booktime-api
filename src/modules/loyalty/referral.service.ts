import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiError } from '../../common/errors/api-error.js';
import { logger } from '../../common/logging/logger.js';
import { PrismaService } from '../../common/prisma.service.js';
import { utcToLocal } from '../../common/time/time.js';
import {
  makeReferralCode,
  normalizeReferralCode,
  referralDenied,
  referralInvitePath,
  referralInviteeStatus,
  referralPublicName,
  type ReferralDenied,
  type ReferralInviteeStatus,
} from './referral.rules.js';

/**
 * «Пригласи подругу» (наше решение 01.10.2026; фронт — src/api/referral.ts): личная ссылка клиента бизнеса, привязка
 * нового клиента при записи по ссылке (attachReferralInTx — внутри транзакции place()), списки приглашённых и
 * бонусов. Награду начисляет оплата первого визита (port: getReferralEligibility видит привязку через ядро порта).
 *
 * Таблицы referral_codes / client_referrals (миграция 20261001170000_client_referrals). Пока миграция не применена,
 * чтения отвечают «программы нет», а привязка молча пропускается — запись клиента никогда не падает из-за рефералки.
 */

type Db = Prisma.TransactionClient | PrismaService;

const SETTINGS_AREA = 'loyalty-port';
const CANCELLED = ['cancelled_by_client', 'cancelled_by_master'];

export interface ReferralReward {
  valueType: 'percent' | 'fixed';
  value: number;
}

export interface ReferralInvite {
  businessId: string;
  businessName: string;
  slug: string;
  code: string;
  path: string;
  inviteeReward?: ReferralReward;
  referrerReward?: ReferralReward;
}

/** Таблицы ещё не созданы (миграция не применена) — P2021 у Prisma */
function missingTable(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === 'P2021' || /doesn't exist|does not exist/i.test(String((e as Error)?.message ?? ''));
}

interface Program {
  active: boolean;
  inviteeReward?: ReferralReward;
  referrerReward?: ReferralReward;
}

/** Настройки рефералки бизнеса (срез loyalty-port: referral[businessId]) и награды из её акций */
async function programOf(db: Db, businessId: string): Promise<Program> {
  const row = await db.businessSetting.findUnique({ where: { businessId_area: { businessId, area: SETTINGS_AREA } }, select: { data: true } });
  const bag = (row?.data ?? {}) as { referral?: Record<string, { active?: boolean; inviteePromotionId?: string; referrerPromotionId?: string }> };
  const s = bag.referral?.[businessId];
  if (!s?.active || !s.inviteePromotionId || !s.referrerPromotionId) return { active: false };
  const promos = await db.promotion.findMany({ where: { id: { in: [s.inviteePromotionId, s.referrerPromotionId] } }, select: { id: true, valueType: true, value: true } });
  const reward = (id: string): ReferralReward | undefined => {
    const p = promos.find((x) => x.id === id);
    return p && p.value ? { valueType: p.valueType === 'percent' ? 'percent' : 'fixed', value: p.value } : undefined;
  };
  return { active: true, inviteeReward: reward(s.inviteePromotionId), referrerReward: reward(s.referrerPromotionId) };
}

/**
 * Привязать нового клиента к пригласившему по коду из ссылки — в той же транзакции, что и запись. Правила — как у
 * фронта (referral.rules.ts): программа включена, код этого бизнеса, не сам себе, один пригласивший, клиент новый
 * (нет неотменённых записей, кроме создаваемой). Отказ или ошибка — без исключения: запись создаётся всё равно.
 */
export async function attachReferralInTx(
  tx: Prisma.TransactionClient,
  input: { businessId: string; inviteeClientId: string; code: string | undefined; bookingId: string },
): Promise<ReferralDenied | null> {
  const code = normalizeReferralCode(input.code);
  if (!code) return 'unknown_code';
  try {
    const link = await tx.referralCode.findUnique({ where: { code } });
    if (!link || link.businessId !== input.businessId) return 'unknown_code';
    const [program, referrer, invitee, existing, prior] = await Promise.all([
      programOf(tx, input.businessId),
      tx.client.findFirst({ where: { id: link.clientId, businessId: input.businessId }, select: { id: true, phone: true, appUserId: true, deletedAt: true } }),
      tx.client.findFirst({ where: { id: input.inviteeClientId, businessId: input.businessId }, select: { id: true, phone: true, appUserId: true } }),
      tx.clientReferral.findUnique({ where: { inviteeClientId: input.inviteeClientId }, select: { referrerClientId: true } }),
      tx.booking.count({ where: { businessId: input.businessId, clientId: input.inviteeClientId, id: { not: input.bookingId }, deletedAt: null, status: { notIn: CANCELLED } } }),
    ]);
    if (!invitee) return 'unknown_code';
    const denied = referralDenied({ programActive: program.active, referrer, invitee: { ...invitee, referredByClientId: existing?.referrerClientId }, priorBookings: prior });
    if (denied) return denied;
    await tx.clientReferral.create({ data: { inviteeClientId: invitee.id, businessId: input.businessId, referrerClientId: link.clientId, code, bookingId: input.bookingId } });
    return null;
  } catch (e) {
    if (!missingTable(e)) logger.warn({ err: e, businessId: input.businessId }, 'referral attach failed');
    return 'unknown_code';
  }
}

/** Кто пригласил этих клиентов — для ядра порта лояльности (getReferralEligibility без телефона). Нет таблицы — пусто */
export async function referrersOf(db: Db, clientIds: string[]): Promise<Map<string, { referrerClientId: string; at: Date }>> {
  if (!clientIds.length) return new Map();
  try {
    const rows = await db.clientReferral.findMany({ where: { inviteeClientId: { in: clientIds } }, select: { inviteeClientId: true, referrerClientId: true, createdAt: true } });
    return new Map(rows.map((r) => [r.inviteeClientId, { referrerClientId: r.referrerClientId, at: r.createdAt }]));
  } catch (e) {
    if (!missingTable(e)) logger.warn({ err: e }, 'referral lookup failed');
    return new Map();
  }
}

/** Все привязки бизнесов области — ядру порта лояльности (оплата визита приглашённой без телефона). Нет таблицы — пусто */
export async function referralsInScope(db: Db, businessIds: string[]): Promise<Map<string, { referrerClientId: string; at: Date }>> {
  try {
    const rows = await db.clientReferral.findMany({ where: { businessId: { in: businessIds } }, select: { inviteeClientId: true, referrerClientId: true, createdAt: true } });
    return new Map(rows.map((r) => [r.inviteeClientId, { referrerClientId: r.referrerClientId, at: r.createdAt }]));
  } catch (e) {
    if (!missingTable(e)) logger.warn({ err: e }, 'referral lookup failed');
    return new Map();
  }
}

@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  /** Код карточки; нет — заводится (уникален во всей базе, повтор при совпадении) */
  private async ensureCode(client: { id: string; businessId: string }): Promise<string> {
    const found = await this.prisma.referralCode.findUnique({ where: { clientId: client.id }, select: { code: true } });
    if (found) return found.code;
    for (let i = 0; i < 6; i++) {
      const code = makeReferralCode();
      try {
        await this.prisma.referralCode.create({ data: { code, businessId: client.businessId, clientId: client.id } });
        return code;
      } catch (e) {
        if (missingTable(e)) throw e;
        // занят код или параллельный запрос уже завёл код этой карточке — перечитываем
        const again = await this.prisma.referralCode.findUnique({ where: { clientId: client.id }, select: { code: true } });
        if (again) return again.code;
      }
    }
    throw new ApiError('internal', 'Could not allocate referral code');
  }

  private async invite(client: { id: string; businessId: string }): Promise<ReferralInvite | null> {
    try {
      const business = await this.prisma.business.findUnique({ where: { id: client.businessId }, select: { id: true, name: true, brandName: true, slug: true } });
      if (!business) return null;
      const program = await programOf(this.prisma, business.id);
      if (!program.active) return null;
      const code = await this.ensureCode(client);
      return {
        businessId: business.id,
        businessName: business.brandName || business.name,
        slug: business.slug,
        code,
        path: referralInvitePath(business.slug, code),
        ...(program.inviteeReward ? { inviteeReward: program.inviteeReward } : {}),
        ...(program.referrerReward ? { referrerReward: program.referrerReward } : {}),
      };
    } catch (e) {
      if (missingTable(e)) return null;
      throw e;
    }
  }

  /** Карточки клиента приложения: по appUserId и по номеру (как linkClient записи) */
  private async cardsOf(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    return this.prisma.client.findMany({
      where: { deletedAt: null, OR: [{ appUserId: userId }, ...(user?.phone ? [{ phone: user.phone }] : [])] },
      select: { id: true, businessId: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Приглашённые клиента и бонусы за них: одна выборка записей и начислений на всех */
  private async invitees(referrer: { id: string; businessId: string }) {
    let links: { inviteeClientId: string; createdAt: Date }[];
    try {
      links = await this.prisma.clientReferral.findMany({ where: { businessId: referrer.businessId, referrerClientId: referrer.id }, orderBy: { createdAt: 'desc' }, select: { inviteeClientId: true, createdAt: true } });
    } catch (e) {
      if (missingTable(e)) return [];
      throw e;
    }
    if (!links.length) return [];
    const ids = links.map((l) => l.inviteeClientId);
    const [clients, bookings, txs] = await Promise.all([
      this.prisma.client.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true } }),
      this.prisma.booking.findMany({ where: { clientId: { in: ids }, deletedAt: null }, select: { id: true, clientId: true, status: true } }),
      this.prisma.loyaltyTx.findMany({ where: { businessId: referrer.businessId, clientId: referrer.id, bookingId: { not: null } }, select: { bookingId: true, amount: true, data: true } }),
    ]);
    const accrualByBooking = new Map<string, number>();
    for (const tx of txs) {
      const type = (tx.data as { type?: string } | null)?.type;
      if (type !== 'referralAccrual' || !tx.bookingId) continue;
      accrualByBooking.set(tx.bookingId, (accrualByBooking.get(tx.bookingId) ?? 0) + Number(tx.amount));
    }
    return links.flatMap((l) => {
      const c = clients.find((x) => x.id === l.inviteeClientId);
      if (!c) return [];
      const own = bookings.filter((b) => b.clientId === c.id);
      const bonus = own.reduce((sum, b) => sum + (accrualByBooking.get(b.id) ?? 0), 0);
      const status: ReferralInviteeStatus = referralInviteeStatus(own, bonus > 0);
      return [{ clientId: c.id, name: c.name, at: utcToLocal(l.createdAt), status, bonus }];
    });
  }

  // ─────────── маршруты ───────────

  async myInvite(userId: string, businessId: string): Promise<ReferralInvite | null> {
    const card = (await this.cardsOf(userId)).find((c) => c.businessId === businessId);
    return card ? this.invite(card) : null;
  }

  async myReferrals(userId: string) {
    const out = [];
    for (const card of await this.cardsOf(userId)) {
      const invite = await this.invite(card);
      if (!invite) continue;
      const rows = await this.invitees(card);
      out.push({
        ...invite,
        invitees: rows.map((r) => ({ name: referralPublicName(r.name), at: r.at, status: r.status, bonus: r.bonus })),
        bonusTotal: rows.reduce((sum, r) => sum + r.bonus, 0),
      });
    }
    return out.sort((a, b) => b.invitees.length - a.invitees.length || a.businessName.localeCompare(b.businessName));
  }

  /** «Вы записаны» без входа: по хэшу записи (тот же, что у «моей записи», B8/B19) */
  async bookingInvite(bookingId: string, hash: string | undefined): Promise<ReferralInvite | null> {
    const row = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { accessHash: true, accessHashExpiresAt: true, clientId: true, businessId: true } });
    const ok = hash && row?.accessHash && row.accessHash === createHash('sha256').update(hash).digest('hex') && !(row.accessHashExpiresAt && row.accessHashExpiresAt.getTime() < Date.now());
    if (!ok || !row) throw new ApiError('not_found', 'Booking not found');
    if (!row.clientId) return null;
    const client = await this.prisma.client.findFirst({ where: { id: row.clientId, deletedAt: null }, select: { id: true, businessId: true } });
    return client ? this.invite(client) : null;
  }

  /** Подруга открыла ссылку: кто пригласил (имя «Анна К.») и что ей положено */
  async landing(slug: string, rawCode: string) {
    const code = normalizeReferralCode(rawCode);
    if (!code) return null;
    try {
      const business = await this.prisma.business.findUnique({ where: { slug }, select: { id: true, name: true, brandName: true } });
      if (!business) return null;
      const link = await this.prisma.referralCode.findUnique({ where: { code } });
      if (!link || link.businessId !== business.id) return null;
      const [program, referrer] = await Promise.all([
        programOf(this.prisma, business.id),
        this.prisma.client.findFirst({ where: { id: link.clientId, deletedAt: null }, select: { name: true } }),
      ]);
      if (!program.active || !referrer) return null;
      return { businessName: business.brandName || business.name, referrerName: referralPublicName(referrer.name), ...(program.inviteeReward ? { inviteeReward: program.inviteeReward } : {}) };
    } catch (e) {
      if (missingTable(e)) return null;
      throw e;
    }
  }

  /** Карточка клиента в кабинете: кто привёл и кого привёл он (полные имена — сотрудник видит CRM) */
  async clientInfo(businessId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, businessId }, select: { id: true, businessId: true } });
    if (!client) throw new ApiError('not_found', 'Client not found');
    const by = (await referrersOf(this.prisma, [clientId])).get(clientId);
    const referrer = by ? await this.prisma.client.findFirst({ where: { id: by.referrerClientId, businessId }, select: { id: true, name: true } }) : null;
    return {
      ...(referrer ? { referredBy: { clientId: referrer.id, name: referrer.name, at: utcToLocal(by!.at) } } : {}),
      invitees: await this.invitees(client),
    };
  }
}
