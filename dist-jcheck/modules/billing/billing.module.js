var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BillingPlatformController, PublicPricingController } from './billing-platform.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { FrozenInterceptor } from './frozen.interceptor.js';
/** Этап 18: подписка, счета, монеты, промокоды (docs/backend/06 §2–5, 02 §18) */
let BillingModule = class BillingModule {
};
BillingModule = __decorate([
    Module({
        controllers: [BillingController, BillingPlatformController, PublicPricingController],
        providers: [BillingService, { provide: APP_INTERCEPTOR, useClass: FrozenInterceptor }],
        exports: [BillingService],
    })
], BillingModule);
export { BillingModule };
//# sourceMappingURL=billing.module.js.map