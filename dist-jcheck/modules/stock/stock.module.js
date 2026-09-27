var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { InventoriesService } from './inventories.service.js';
import { StockCatalogService } from './stock-catalog.service.js';
import { StockController } from './stock.controller.js';
import { StockOpsService } from './stock-ops.service.js';
import { TechCardsService } from './tech-cards.service.js';
/**
 * Этап 13: склад (PLAN §6 №13) — склады, категории, товары, приход/списание/перемещение/продажа,
 * техкарты + автосписание визита, инвентаризация, оборудование, напоминания, настройки.
 * `FinanceModule` — мост «Оплачено»/продажа → касса (F-00-138), тем же приёмом, что этап 12 сам собирался
 * принять от склада (см. FinanceModule PROGRESS.md §12 «Осталось: продажи вне визита ждут этапа 13»).
 * `TechCardsService` экспортируется отдельно — его зовёт `JournalModule` (автосписание по статусу «Пришёл»),
 * не весь модуль целиком, чтобы не тянуть контроллер и остальные сервисы туда, где они не нужны.
 */
let StockModule = class StockModule {
};
StockModule = __decorate([
    Module({
        imports: [FinanceModule],
        controllers: [StockController],
        providers: [StockCatalogService, StockOpsService, TechCardsService, InventoriesService],
        exports: [StockCatalogService, StockOpsService, TechCardsService, InventoriesService],
    })
], StockModule);
export { StockModule };
//# sourceMappingURL=stock.module.js.map