import { randomUUID } from 'node:crypto';
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
  readonly kind: 'fake' | 'arca' | 'idram' | 'telcell';
  charge(request: PaymentRequest): Promise<PaymentResult>;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly kind = 'fake' as const;
  async charge(): Promise<PaymentResult> {
    return { providerRef: `fake_${randomUUID()}`, status: 'succeeded' };
  }
}
