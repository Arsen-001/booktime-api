import { Body, Controller, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { translationOverrideBody, translationOwner } from './client.schemas.js';
import { TranslationsService } from './translations.service.js';

/**
 * Автоперевод (F-00-174), стадия 21 (лейн client+online, попытка 2): `client.ts::getTranslationOverride/
 * listTranslatable/setTranslationOverride` — экран `/biz/apps/translations`.
 */
@ApiTags('client')
@Controller('v1/biz/:businessId/translations')
export class TranslationsController {
  constructor(private readonly svc: TranslationsService) {}

  @Get()
  @Biz()
  @ApiOperation({ summary: 'Тексты бизнеса, ждущие проверки перевода на en (F-00-174)' })
  list(@Param('businessId') businessId: string) {
    return this.svc.listTranslatable(businessId);
  }

  @Get('override')
  @Biz()
  @ApiOperation({ summary: 'Правка перевода одного текста, если есть' })
  async getOverride(@Param('businessId') businessId: string, @Query('owner', new Zod(translationOwner)) owner: z.infer<typeof translationOwner>, @Query('ownerId', new Zod(z.string().min(1).max(40))) ownerId: string, @Query('field', new Zod(z.string().min(1).max(40))) field: string) {
    await this.svc.assertOwned(businessId, owner, ownerId);
    return this.svc.getOverride(owner, ownerId, field).then((text) => ({ text: text ?? null }));
  }

  @Put('override')
  @HttpCode(204)
  @Biz()
  @ApiOperation({ summary: 'Поправить перевод (пустой текст — снять правку)' })
  @ZodBody(translationOverrideBody)
  async setOverride(@Ctx() ctx: RequestContext, @Body(new Zod(translationOverrideBody)) body: z.infer<typeof translationOverrideBody>) {
    await this.svc.assertOwned(ctx.member!.businessId, body.owner, body.ownerId);
    await this.svc.setOverride(body.owner, body.ownerId, body.field, body.text, ctx.member!.staffId);
  }
}
