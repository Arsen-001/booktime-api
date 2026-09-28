import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestContext } from '../../common/http/context.js';
import { Biz, Ctx } from '../../common/http/guards.js';
import { ZodBody, ZodOk } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { branchDailyStatsQuery, servicesCsvImportBody } from './network.schemas.js';
import { NetworkCatalogService } from './network-catalog.controller.js';

const marketingOptOutBody = z.object({ phone: z.string().trim().min(1).max(32), optOut: z.boolean() });
const branchDailyStatsOut = z.array(z.object({ businessId: z.string(), revenue: z.number(), bookingsCount: z.number() }));

/**
 * Сеть с точки зрения ФИЛИАЛА (docs/backend/02 §15), а не панели сети — вызывает любой сотрудник кабинета,
 * не только владелец сети (`NetworkAccessService.require` там гейтит именно панель `/v1/net/{id}/…`, тут
 * гейт свой, обычный `@Biz`). Только `NetworkCatalogService` этого же модуля — без `NetworkService` модуля
 * `businesses` (риск цикла `network` ↔ `businesses`, см. докстринг `NetworkCatalogService.myNetwork()`).
 * Этап 21 «network+reports»:
 * - `mine` — `src/api/network.ts::listMyNetworks`: сеть этого бизнеса, если есть (0 или 1 — Business.networkId
 *   один, мок несёт массив «на будущее»); переключатель сети и «Данные сети» в окне записи это же зовут.
 * - `service-price-locks` — `src/api/network.ts::listPriceLockedServiceIds`: id услуг ЭТОГО бизнеса, цена
 *   которых заблокирована сетью (F-11-082) — экран «Услуги» филиала, не панель сети.
 */
@ApiTags('network')
@Controller('v1/biz/:businessId/network')
export class NetworkBusinessController {
  constructor(private readonly catalog: NetworkCatalogService) {}

  @Get('mine')
  @Biz()
  mine(@Param('businessId') businessId: string) {
    return this.catalog.myNetwork(businessId);
  }

  @Get('service-price-locks')
  @Biz('services.view')
  servicePriceLocks(@Param('businessId') businessId: string) {
    return this.catalog.listPriceLockedServiceIdsForBusiness(businessId);
  }

  /** `src/api/network.ts::getServiceNetworkInfo(serviceId)` — см. докстринг `getServiceNetworkInfoForService` */
  @Get('service-info/:serviceId')
  @Biz('services.view')
  serviceNetworkInfo(@Param('businessId') businessId: string, @Param('serviceId') serviceId: string) {
    return this.catalog.getServiceNetworkInfoForService(businessId, serviceId);
  }

  /** `src/api/network.ts::getStaffNetworkInfo(staffId)` — см. докстринг `getStaffNetworkInfoForStaff` */
  @Get('staff-info/:staffId')
  @Biz('staff.view')
  staffNetworkInfo(@Param('businessId') businessId: string, @Param('staffId') staffId: string) {
    return this.catalog.getStaffNetworkInfoForStaff(businessId, staffId);
  }

  /** `src/api/network.ts::setNetworkMarketingOptOut(phone, optOut)` — см. докстринг `setMarketingOptOutByBusiness` */
  @Patch('marketing-opt-out')
  @Biz('clients.edit')
  @ApiOperation({ summary: 'Согласие на рекламу клиента сети по телефону (F-11-058)' })
  @ZodBody(marketingOptOutBody)
  async marketingOptOut(@Param('businessId') businessId: string, @Body(new Zod(marketingOptOutBody)) body: z.infer<typeof marketingOptOutBody>) {
    await this.catalog.setMarketingOptOutByBusiness(businessId, body.phone, body.optOut);
    return { ok: true as const };
  }

  /** `src/api/network.ts::getNetworkBranchDailyStats(businessIds, date)` — см. докстринг `branchDailyStats` (F-11-156) */
  @Get('branch-daily-stats')
  @Biz()
  @ApiOperation({ summary: 'Статистика каждого филиала своей сети за один день (F-11-156)' })
  @ZodOk(branchDailyStatsOut)
  branchDailyStats(@Param('businessId') businessId: string, @Query(new Zod(branchDailyStatsQuery)) query: z.infer<typeof branchDailyStatsQuery>) {
    return this.catalog.branchDailyStats(businessId, query.businessIds.split(',').filter(Boolean), query.date);
  }

  /** `src/api/network.ts::importBusinessServicesCsv(targetId, rows)` — см. докстринг `importServicesCsv` (F-11-010) */
  @Post('services-csv-import')
  @Biz('services.edit')
  @ApiOperation({ summary: 'Импорт услуг из CSV в филиал (F-11-010)' })
  @ZodBody(servicesCsvImportBody)
  importServicesCsv(@Ctx() ctx: RequestContext, @Param('businessId') businessId: string, @Body(new Zod(servicesCsvImportBody)) body: z.infer<typeof servicesCsvImportBody>) {
    return this.catalog.importServicesCsv(ctx, businessId, body.rows);
  }
}
