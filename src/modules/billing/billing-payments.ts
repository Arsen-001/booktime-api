/**
 * Провайдер оплаты для воркера (автопродление): тот же выбор, что `PAYMENTS` в adapters.ts
 * (adapters/payments/payments.ts::createPaymentProvider). Провайдер не выбран (PLAN §10, D8: ArCa / Idram / Telcell):
 * при разработке — заглушка, на production оплаты выключены. Настоящий адаптер вернёт `pending`, и подписку продлит
 * вебхук провайдера (`settleCharge`).
 */
export { createPaymentProvider } from '../../adapters/payments/payments.js';
