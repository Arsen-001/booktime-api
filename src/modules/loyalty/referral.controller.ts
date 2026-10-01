import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestContext } from '../../common/http/context.js';
import { Authed, Biz, Ctx } from '../../common/http/guards.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { ReferralService } from './referral.service.js';

/**
 * «Пригласи подругу» (наше решение 01.10.2026): личная ссылка клиента, приглашённые и бонусы. Привязку нового
 * клиента делает единый поток записи (поле referralCode у POST /v1/me/bookings и /v1/public/b/{slug}/bookings).
 */
@ApiTags('loyalty')
@Controller('v1/me/referrals')
export class MeReferralController {
  constructor(private readonly svc: ReferralService) {}

  @Get()
  @Authed()
  @ApiOperation({ summary: 'Мои ссылки по салонам с программой, приглашённые (имя «Анна К.», статус) и бонусы' })
  list(@Ctx() ctx: RequestContext) {
    return this.svc.myReferrals(ctx.session!.userId);
  }

  @Get(':businessId')
  @Authed()
  @ApiOperation({ summary: 'Моя ссылка в салоне («Вы записаны»); нет карточки или программы — null' })
  one(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string) {
    return this.svc.myInvite(ctx.session!.userId, businessId);
  }
}

@ApiTags('loyalty')
@Controller('v1/public')
export class PublicReferralController {
  constructor(private readonly svc: ReferralService) {}

  @Get('bookings/:id/referral')
  @RateLimit({ bucket: 'public-referral', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: '«Вы записаны» без входа: ссылка клиента этой записи по хэшу (?h=)' })
  booking(@Param('id') id: string, @Query('h') h?: string) {
    return this.svc.bookingInvite(id, h);
  }

  @Get('b/:slug/referral/:code')
  @RateLimit({ bucket: 'public-referral', limit: 60, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Подруга открыла ссылку: кто пригласил и скидка первого визита; код неизвестен — null' })
  landing(@Param('slug') slug: string, @Param('code') code: string) {
    return this.svc.landing(slug, code);
  }
}

@ApiTags('loyalty')
@Controller('v1/biz/:businessId/clients/:clientId/referral')
export class BizReferralController {
  constructor(private readonly svc: ReferralService) {}

  @Get()
  @Biz('clients.view')
  @ApiOperation({ summary: 'Карточка клиента: «пришёл по приглашению …» и кого привёл он' })
  info(@Param('businessId') businessId: string, @Param('clientId') clientId: string) {
    return this.svc.clientInfo(businessId, clientId);
  }
}
