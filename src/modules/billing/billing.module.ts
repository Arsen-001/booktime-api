import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BillingPlatformController, PublicPricingController } from './billing-platform.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { FrozenInterceptor } from './frozen.interceptor.js';

/** Этап 18: подписка, счета, монеты, промокоды (docs/backend/06 §2–5, 02 §18) */
@Module({
  controllers: [BillingController, BillingPlatformController, PublicPricingController],
  providers: [BillingService, { provide: APP_INTERCEPTOR, useClass: FrozenInterceptor }],
  exports: [BillingService],
})
export class BillingModule {}
