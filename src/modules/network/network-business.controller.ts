import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Biz } from '../../common/http/guards.js';
import { NetworkCatalogService } from './network-catalog.controller.js';

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
}
