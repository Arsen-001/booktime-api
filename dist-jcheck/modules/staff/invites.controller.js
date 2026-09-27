var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service.js';
import { ApiError } from '../../common/errors/api-error.js';
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
let InvitesController = class InvitesController {
    constructor(prisma, audit) {
        this.prisma = prisma;
        this.audit = audit;
    }
    async byToken(token) {
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token))
            throw new ApiError('not_found', 'Invite not found');
        const invite = await this.prisma.staffInvite.findUnique({ where: { tokenHash: inviteTokenHash(token) }, include: { business: true, staff: true } });
        if (!invite)
            throw new ApiError('not_found', 'Invite not found');
        if (invite.status === 'pending' && invite.expiresAt.getTime() < Date.now()) {
            await this.prisma.staffInvite.update({ where: { id: invite.id }, data: { status: 'expired' } });
            invite.status = 'expired';
        }
        return invite;
    }
    async info(token) {
        const invite = await this.byToken(token).catch(() => null);
        if (!invite)
            return null;
        const hasAccount = invite.phone ? Boolean(await this.prisma.user.findUnique({ where: { phone: invite.phone }, select: { id: true } })) : false;
        return {
            token,
            businessId: invite.businessId,
            businessName: invite.business.name,
            role: invite.role,
            audience: hasAccount ? 'existing' : 'new',
            phone: invite.phone ? maskPhone(invite.phone) : undefined,
            email: invite.email ?? undefined,
            status: (invite.status === 'pending' || invite.status === 'accepted' ? invite.status : 'revoked'),
            createdAt: utcToLocal(invite.sentAt),
        };
    }
    async accept(ctx, token, body) {
        const invite = await this.byToken(token);
        if (invite.status === 'accepted')
            throw new ApiError('invite_used', 'Invite already used');
        if (invite.status === 'expired')
            throw new ApiError('invite_expired', 'Invite expired');
        if (invite.status !== 'pending')
            throw new ApiError('not_found', 'Invite revoked');
        const userId = ctx.session.userId;
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (invite.phone && user.phone !== invite.phone)
            throw new ApiError('invite_wrong_phone', 'Invite is for another phone');
        const other = await this.prisma.staff.findFirst({ where: { businessId: invite.businessId, userId, deletedAt: null, id: { not: invite.staffId } } });
        if (other)
            throw new ApiError('invite_used', 'Already a member of this business');
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
                    photos: photos,
                    materials: materials,
                    ...(body.name?.trim() ? { name: body.name.trim() } : {}),
                    updatedBy: userId,
                    version: { increment: 1 },
                },
            });
            await tx.staffInvite.update({ where: { id: invite.id }, data: { status: 'accepted', answeredAt: new Date(), updatedBy: userId, version: { increment: 1 } } });
            await this.audit.record(tx, ctx, { action: 'inviteAccepted', entityType: 'staff', entityId: staff.id, businessId: invite.businessId });
        });
        return { businessId: invite.businessId, businessName: invite.business.name, role: invite.role };
    }
    async decline(ctx, token) {
        const invite = await this.byToken(token);
        if (invite.status !== 'pending')
            return;
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
        if (invite.phone && user.phone !== invite.phone)
            throw new ApiError('invite_wrong_phone', 'Invite is for another phone');
        await this.prisma.staffInvite.update({ where: { id: invite.id }, data: { status: 'declined', answeredAt: new Date() } });
    }
};
__decorate([
    Get('public/invites/:token'),
    RateLimit({ bucket: 'invite-read', limit: 60, windowSec: 3600, by: 'ip' }),
    ApiOperation({ summary: 'Что за приглашение: бизнес, роль, номер под маской' }),
    ZodOk(inviteInfo.nullable()),
    __param(0, Param('token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], InvitesController.prototype, "info", null);
__decorate([
    Post('me/invites/:token/accept'),
    HttpCode(200),
    Authed(),
    ApiOperation({ summary: 'Принять приглашение: сотрудник привязывается к вошедшему человеку' }),
    ZodBody(acceptBody),
    ZodOk(acceptOut),
    __param(0, Ctx()),
    __param(1, Param('token')),
    __param(2, Body(new Zod(acceptBody))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], InvitesController.prototype, "accept", null);
__decorate([
    Post('me/invites/:token/decline'),
    HttpCode(204),
    Authed(),
    ApiOperation({ summary: 'Отказаться от приглашения' }),
    __param(0, Ctx()),
    __param(1, Param('token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], InvitesController.prototype, "decline", null);
InvitesController = __decorate([
    ApiTags('staff'),
    Controller('v1'),
    __metadata("design:paramtypes", [PrismaService,
        AuditService])
], InvitesController);
export { InvitesController };
//# sourceMappingURL=invites.controller.js.map