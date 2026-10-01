import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Biz, BizAny } from '../../common/http/guards.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { UpsellService } from './upsell.service.js';

const list = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : []);

/**
 * ⭐ Допродажа при записи (01.10.2026): что предложить клиенту к услуге (публично — виджет, ссылка, приложение,
 * каталог) и «Допродано» в карточке услуги кабинета.
 */
@ApiTags('upsell')
@Controller('v1')
export class UpsellController {
  constructor(private readonly svc: UpsellService) {}

  @Get('public/upsell-offers')
  @RateLimit({ bucket: 'public-upsell', limit: 300, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Сопутствующие услуги и товары, которые помещаются в это время у этого мастера' })
  offers(
    @Query('staffId') staffId: string,
    @Query('serviceIds') serviceIds: string | undefined,
    @Query('start') start: string,
    @Query('added') added: string | undefined,
    @Query('locationId') locationId: string | undefined,
  ) {
    return this.svc.offers({ staffId, serviceIds: list(serviceIds), start, added: list(added), locationId: locationId || undefined });
  }

  @Get('biz/:businessId/upsell/configs')
  @BizAny('journal.view', 'services.view')
  @ApiOperation({ summary: 'Сопутствующие всех услуг бизнеса — подсказки «Предложить клиенту» в окне записи' })
  configs(@Param('businessId') businessId: string) {
    return this.svc.configs(businessId);
  }

  @Get('biz/:businessId/upsell/candidates')
  @Biz('services.view')
  @ApiOperation({ summary: 'Что можно выбрать в «Сопутствующие услуги и товары» карточки услуги' })
  candidates(@Param('businessId') businessId: string) {
    return this.svc.candidates(businessId);
  }

  @Get('biz/:businessId/services/:id/upsell-stats')
  @Biz('services.view')
  @ApiOperation({ summary: '«Допродано»: сколько сопутствующих клиенты взяли к услуге за N дней' })
  stats(@Param('businessId') businessId: string, @Param('id') id: string, @Query('days') days: string | undefined) {
    const n = Math.min(365, Math.max(7, Number(days) || 90));
    return this.svc.stats(businessId, id, n);
  }
}
