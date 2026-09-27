import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { moneyToJson } from '../../common/money/money.js';
import { PrismaService } from '../../common/prisma.service.js';
import { LoyaltyInstancesService } from './loyalty-instances.service.js';
import { LoyaltyProgramService } from './loyalty-program.service.js';
import { resolveScopeBusinessIds } from './loyalty.owner.js';

/**
 * GET /v1/me/loyalty (F-06-156…163, В-06/В-09): своё в приложении — только если бизнес не выключил
 * «показывать клиенту», и только то, что найдено по CARD ряду клиента с ЭТИМ телефоном (сам вошёл этим
 * номером) в бизнесах ОДНОЙ сети (В-09 — «во всех салонах сети»), либо выдано прямо этому appUserId.
 * Открытый вопрос 02-api.md §11 («видно только купленное через приложение / после своей записи») не сузил
 * дальше — ANSWERS В-06 звучит без этого условия, а сама сессия уже доказывает «вошёл этим номером».
 */
@Injectable()
export class MeLoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: LoyaltyInstancesService,
    private readonly program: LoyaltyProgramService,
  ) {}

  async getMine(userId: string, businessId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!user) throw new ApiError('not_found', 'User not found');
    const businessIds = await resolveScopeBusinessIds(this.prisma, businessId);
    const clients = user.phone ? await this.prisma.client.findMany({ where: { businessId: { in: businessIds }, phone: user.phone, deletedAt: null }, select: { id: true, businessId: true } }) : [];
    const clientIds = clients.map((c) => c.id);

    // В-06: только бизнесы, где не выключили «показывать клиенту»
    const visibility = new Map<string, boolean>();
    for (const id of businessIds) visibility.set(id, await this.program.getShowToClient(id));
    const businesses = await this.prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } });
    const nameOf = new Map(businesses.map((b) => [b.id, b.name]));
    const visible = (bid: string) => visibility.get(bid) ?? true;

    const [cards, certificates, memberships, accounts] = await Promise.all([
      this.prisma.loyaltyCard.findMany({ where: { businessId: { in: businessIds }, OR: [{ clientId: { in: clientIds } }, { appUserId: userId }] }, include: { cardType: true } }),
      this.prisma.certificate.findMany({ where: { businessId: { in: businessIds }, status: 'active', OR: [{ clientId: { in: clientIds } }, { appUserId: userId }] }, include: { type: true } }),
      this.prisma.membershipSale.findMany({ where: { businessId: { in: businessIds }, status: { in: ['active', 'frozen'] }, OR: [{ clientId: { in: clientIds } }, { appUserId: userId }] }, include: { type: true } }),
      this.prisma.clientAccount.findMany({ where: { businessId: { in: businessIds }, clientId: { in: clientIds } }, include: { type: true } }),
    ]);

    return {
      cards: cards.filter((c) => visible(c.businessId)).map((c) => ({ id: c.id, businessId: c.businessId, businessName: nameOf.get(c.businessId) ?? '', cardTypeName: c.cardType.name, number: c.number, balance: moneyToJson(c.balance), cashbackVisibleInApp: c.cardType.cashbackVisibleInApp })),
      certificates: certificates.filter((c) => visible(c.businessId)).map((c) => ({ id: c.id, businessId: c.businessId, businessName: nameOf.get(c.businessId) ?? '', typeName: c.type.name, code: c.code, balance: moneyToJson(c.balance), total: moneyToJson(c.total), status: c.status, expiresAt: c.expiresAt.toISOString() })),
      memberships: memberships.filter((m) => visible(m.businessId)).map((m) => ({ id: m.id, businessId: m.businessId, businessName: nameOf.get(m.businessId) ?? '', typeName: m.type.name, code: m.code, remainingVisits: m.remainingVisits, totalVisits: m.totalVisits, status: m.status, expiresAt: m.expiresAt.toISOString() })),
      accounts: accounts.filter((a) => visible(a.businessId)).map((a) => ({ id: a.id, businessId: a.businessId, businessName: nameOf.get(a.businessId) ?? '', typeName: a.type.name, balance: moneyToJson(a.balance) })),
    };
  }

  /** В-17: «Абонемент/сертификат в приложении» — заявка → оплата по реквизитам → подтверждение мастером */
  async requestCertificate(userId: string, businessId: string, typeId: string) {
    return this.instances.requestCertificate(userId, businessId, typeId);
  }

  async requestMembership(userId: string, businessId: string, typeId: string) {
    return this.instances.requestMembership(userId, businessId, typeId);
  }

  /**
   * Каталог того, что бизнес продаёт (для экрана покупки, не архив, В-17). F-06-002: типы уже лежат одним
   * списком на владельца (сеть или сам бизнес) — просто тот же `ownerId`, что резолвит `LoyaltyCatalogService`
   * на стороне кабинета, без отдельного отбора «businessId ИЛИ networkWide» (это поле — про то, работает ли
   * уже ВЫДАННЫЙ экземпляр в других филиалах сети, а не про то, показывать ли ТИП в каталоге покупки).
   */
  async listBuyable(businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { networkId: true } });
    const ownerId = business?.networkId ?? businessId;
    const [certTypes, membershipTypes] = await Promise.all([
      this.prisma.certificateType.findMany({ where: { archived: false, ownerId } }),
      this.prisma.membershipType.findMany({ where: { archived: false, ownerId } }),
    ]);
    return {
      certificateTypes: certTypes.map((t) => ({ id: t.id, name: t.name, faceValue: moneyToJson(t.faceValue), validDays: t.validDays })),
      membershipTypes: membershipTypes.map((t) => ({ id: t.id, name: t.name, price: moneyToJson(t.price), validDays: t.validDays, totalVisits: t.totalVisits })),
    };
  }
}
