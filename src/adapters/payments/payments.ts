import { randomUUID } from 'node:crypto';
import { env } from '../../common/config/env.js';
import { ApiError } from '../../common/errors/api-error.js';
import type { Money } from '../../common/money/money.js';

/**
 * Оплата подписки и монет (PLAN.md §10, D8: ArCa / Idram / Telcell — не выбран). Заглушка проводит платёж сразу.
 * Настоящий адаптер вернёт pending и подтвердит платёж вебхуком провайдера.
 */
export interface PaymentRequest {
  amount: Money;
  /** Что оплачиваем — для выписки */
  purpose: string;
  businessId: string;
  idempotencyKey: string;
}

export interface PaymentResult {
  providerRef: string;
  status: 'succeeded' | 'pending' | 'failed';
}

export interface PaymentProvider {
  readonly kind: 'fake' | 'none' | 'arca' | 'idram' | 'telcell';
  /**
   * Принимает ли оплату картой / Idram / Telcell. false — провайдер не подключён: покупка монет, оплата подписки
   * картой, сохранение карты и автопродление отвечают 503 `payments_unavailable` и ничего не меняют (06.10.2026).
   * «Счёт для фирмы», бесплатные месяцы, пробный период и подарки монет из нашей панели работают без провайдера.
   */
  readonly available: boolean;
  charge(request: PaymentRequest): Promise<PaymentResult>;
}

/** Заглушка: любой платёж сразу успешен. Только разработка и тесты — см. createPaymentProvider */
export class FakePaymentProvider implements PaymentProvider {
  readonly kind = 'fake' as const;
  readonly available = true;
  async charge(): Promise<PaymentResult> {
    return { providerRef: `fake_${randomUUID()}`, status: 'succeeded' };
  }
}

/** Провайдер не подключён (production, пока владелец не выбрал ArCa / Idram / Telcell): оплаты выключены */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly kind = 'none' as const;
  readonly available = false;
  async charge(): Promise<PaymentResult> {
    throw paymentsUnavailable();
  }
}

export const paymentsUnavailable = () => new ApiError('payments_unavailable', 'Card payments are not available yet');

/** Бросает 503 `payments_unavailable`, если провайдер не принимает оплату, — до любых записей в базу */
export function assertPaymentsAvailable(payments: PaymentProvider): void {
  if (!payments.available) throw paymentsUnavailable();
}

export interface PaymentProviderConfig {
  nodeEnv: 'development' | 'production' | 'test';
  /** PAYMENTS_FAKE: '1' — заглушка в любом NODE_ENV (кроме Railway production), '0' — выключить и при разработке */
  fake?: '0' | '1';
  /** RAILWAY_ENVIRONMENT_NAME */
  railwayEnv?: string;
}

/**
 * Какой провайдер оплаты (06.10.2026, F-00-022/026): настоящего пока нет, поэтому заглушка — ТОЛЬКО при разработке
 * и в тестах (NODE_ENV development/test) или явно PAYMENTS_FAKE=1 (на Railway не задаётся; в окружении Railway
 * `production` игнорируется всегда). Иначе оплаты выключены — никаких «бесплатных» покупок и фальшивых карт.
 * Подключим ArCa / Idram / Telcell — выбор добавится здесь (по ключам провайдера).
 */
export function pickPaymentProvider(cfg: PaymentProviderConfig): PaymentProvider {
  if (cfg.fake === '0') return new DisabledPaymentProvider();
  if (cfg.fake === '1' && cfg.railwayEnv !== 'production') return new FakePaymentProvider();
  if (cfg.nodeEnv === 'development' || cfg.nodeEnv === 'test') return new FakePaymentProvider();
  return new DisabledPaymentProvider();
}

/** Провайдер для API (`PAYMENTS` в adapters.ts) и воркера (автопродление) — один выбор */
export function createPaymentProvider(): PaymentProvider {
  return pickPaymentProvider({ nodeEnv: env.NODE_ENV, fake: env.PAYMENTS_FAKE, railwayEnv: process.env.RAILWAY_ENVIRONMENT_NAME });
}
