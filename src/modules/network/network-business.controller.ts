import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Biz } from '../../common/http/guards.js';
import { ZodBody } from '../../common/http/openapi.js';
import { Zod } from '../../common/http/validation.js';
import { NetworkCatalogService } from './network-catalog.controller.js';

const marketingOptOutBody = z.object({ phone: z.string().trim().min(1).max(32), optOut: z.boolean() });

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

  /** `src/api/network.ts::setNetworkMarketingOptOut(phone, optOut)` — см. докстринг `setMarketingOptOutByBusiness` */
  @Patch('marketing-opt-out')
  @Biz('clients.edit')
  @ApiOperation({ summary: 'Согласие на рекламу клиента сети по телефону (F-11-058)' })
  @ZodBody(marketingOptOutBody)
  async marketingOptOut(@Param('businessId') businessId: string, @Body(new Zod(marketingOptOutBody)) body: z.infer<typeof marketingOptOutBody>) {
    await this.catalog.setMarketingOptOutByBusiness(businessId, body.phone, body.optOut);
    return { ok: true as const };
  }
}
