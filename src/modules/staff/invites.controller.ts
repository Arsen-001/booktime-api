import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { maskPhone } from '../../common/phone.js';
import { PrismaService } from '../../common/prisma.service.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { utcToLocal } from '../../common/time/time.js';
import { inviteTokenHash } from './staff.service.js';

const inviteInfo = z.object({
  token: z.string(),
  businessId: z.string(),
  businessName: z.string(),
  role: z.enum(['admin', 'master']),
  audience: z.enum(['new', 'existing']),
  phone: z.string().optional(),
  email: z.string().optional(),
  status: z.enum(['pending', 'accepted', 'revoked']),
  createdAt: z.string(),
});
const acceptBody = z.object({ name: z.string().max(120).optional(), consent: z.boolean().optional() });
const acceptOut = z.object({ businessId: z.string(), businessName: z.string(), role: z.enum(['admin', 'master']) });

/**
 * Приглашение в салон с согласием мастера (F-00-042, F-00-043, F-15-146). Ссылка несёт токен; в базе — только хэш.
 * Принять может только вошедший человек с тем же номером, на который звали; с него снимается «приглашён».
 */
@ApiTags('staff')
@Controller('v1')
export class InvitesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new ApiError('not_found', 'Invite not found');
    const invite = await this.prisma.staffInvite.findUnique({ where: { tokenHash: inviteTokenHash(token) }, include: { business: true, staff: true } });
    if (!invite) throw new ApiError('not_found', 'Invite not found');
    if (invite.status === 'pending' && invite.expiresAt.getTime() < Date.now()) {
      await this.prisma.staffInvite.update({ where: { id: invite.id }, data: { status: 'expired' } });
      invite.status = 'expired';
    }
    return invite;
  }

  @Get('public/invites/:token')
  @RateLimit({ bucket: 'invite-read', limit: 60, windowSec: 3600, by: 'ip' })
  @ApiOperation({ summary: 'Что за приглашение: бизнес, роль, номер под маской' })
  @ZodOk(inviteInfo.nullable())
  async info(@Param('token') token: string) {
    const invite = await this.byToken(token).catch(() => null);
    if (!invite) return null;
    const hasAccount = invite.phone ? Boolean(await this.prisma.user.findUnique({ where: { phone: invite.phone }, select: { id: true } })) : false;
    return {
      token,
      businessId: invite.businessId,
      businessName: invite.business.name,
      role: invite.role as 'admin' | 'master',
      audience: hasAccount ? ('existing' as const) : ('new' as const),
      phone: invite.phone ? maskPhone(invite.phone) : undefined,
      email: invite.email ?? undefined,
      status: (invite.status === 'pending' || invite.status === 'accepted' ? invite.status : 'revoked') as 'pending' | 'accepted' | 'revoked',
      createdAt: utcToLocal(invite.sentAt),
    };
  }

  @Post('me/invites/:token/accept')
  @HttpCode(200)
  @Authed()
  @ApiOperation({ summary: 'Принять приглашение: сотрудник привязывается к вошедшему человеку' })
  @ZodBody(acceptBody)
  @ZodOk(acceptOut)
  async accept(@Ctx() ctx: RequestContext, @Param('token') token: string, @Body(new Zod(acceptBody)) body: z.infer<typeof acceptBody>) {
    const invite = await this.byToken(token);
    if (invite.status === 'accepted') throw new ApiError('invite_used', 'Invite already used');
    if (invite.status === 'expired') throw new ApiError('invite_expired', 'Invite expired');
    if (invite.status !== 'pending') throw new ApiError('not_found', 'Invite revoked');
    const userId = ctx.session!.userId;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (invite.phone && user.phone !== invite.phone) throw new ApiError('invite_wrong_phone', 'Invite is for another phone');
    const other = await this.prisma.staff.findFirst({ where: { businessId: invite.businessId, userId, deletedAt: null, id: { not: invite.staffId } } });
    if (other) throw new ApiError('invite_used', 'Already a member of this business');
    const profile = await this.prisma.masterProfile.findUnique({ where: { userId } });
    await this.prisma.$transaction(async (tx) => {
      const staff = invite.staff;
      const photos = Array.isArray(staff.photos) && staff.photos.length ? staff.photos : (profile?.photos ?? []);
      const materials = Array.isArray(staff.materials) && staff.materials.length ? staff.materials : (profile?.materials ?? []);
      await tx.staff.update({
        where: { id: staff.id },
        data: {
          userId,
          status: staff.status === 'fired' ? 'fired' : 'active',
          accessEnabled: true,
          // C4 / F-00-043: портфолио приходит с мастером
          photos: photos as never,
          materials: materials as never,
          ...(body.name?.trim() ? { name: body.name.trim() } : {}),
          updatedBy: userId,
          version: { increment: 1 },
        },
      });
      await tx.staffInvite.update({ where: { id: invite.id }, data: { status: 'accepted', answeredAt: new Date(), updatedBy: userId, version: { increment: 1 } } });
      await this.audit.record(tx, ctx, { action: 'inviteAccepted', entityType: 'staff', entityId: staff.id, businessId: invite.businessId });
    });
    return { businessId: invite.businessId, businessName: invite.business.name, role: invite.role as 'admin' | 'master' };
  }

  @Post('me/invites/:token/decline')
  @HttpCode(204)
  @Authed()
  @ApiOperation({ summary: 'Отказаться от приглашения' })
  async decline(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    const invite = await this.byToken(token);
    if (invite.status !== 'pending') return;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.session!.userId } });
    if (invite.phone && user.phone !== invite.phone) throw new ApiError('invite_wrong_phone', 'Invite is for another phone');
    await this.prisma.staffInvite.update({ where: { id: invite.id }, data: { status: 'declined', answeredAt: new Date() } });
  }
}
