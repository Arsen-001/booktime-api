import { FakePaymentProvider, type PaymentProvider } from '../../adapters/payments/payments.js';

/**
 * Провайдер оплаты для воркера (автопродление): тот же выбор, что `PAYMENTS` в adapters.ts. Провайдер не выбран
 * (PLAN §10, D8: ArCa / Idram / Telcell) — заглушка проводит платёж сразу. Настоящий адаптер вернёт `pending`,
 * и подписку продлит вебхук провайдера (`BillingService.settleCharge`).
 */
export function createPaymentProvider(): PaymentProvider {
  return new FakePaymentProvider();
}
