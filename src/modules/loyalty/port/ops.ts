import type { Permission } from '../../../common/permissions/permissions.js';

/**
 * Какие функции фасада лояльности (port/logic.ts) можно звать по сети и с каким правом (любое из списка).
 * `[]` — любой сотрудник бизнеса (чтения: окно записи, карточка клиента, касса читают лояльность, у мока
 * проверки прав не было). Функции нет в списке — 404: внутренние хелперы и склейки с journal/finance
 * (payVisitWithLoyalty, cancelVisitPaymentLine…) собирает фронт.
 */
const MANAGE: Permission[] = ['loyalty.manage'];
const SELL: Permission[] = ['loyalty.manage', 'finance.edit'];
const VISIT: Permission[] = ['loyalty.manage', 'finance.edit', 'journal.edit'];
const SERVICE_FLAG: Permission[] = ['loyalty.manage', 'services.edit'];
const ANY: Permission[] = [];

export const BIZ_OPS: Record<string, Permission[]> = {
  // типы карт, карты
  listCardTypes: ANY,
  getCardType: ANY,
  createCardType: MANAGE,
  updateCardType: MANAGE,
  deleteCardType: MANAGE,
  setCardTypeArchived: MANAGE,
  getCardSoldPaid: ANY,
  issueCard: SELL,
  deleteCard: MANAGE,
  adjustCardBalance: MANAGE,
  listCards: ANY,
  getCard: ANY,
  // акции
  listPromotions: ANY,
  getPromotionsReport: ANY,
  listServiceScopeOptions: ANY,
  createPromotion: MANAGE,
  getPromotion: ANY,
  updatePromotion: MANAGE,
  deletePromotion: MANAGE,
  // обзор, журнал операций, настройки
  getLoyaltyHubOverview: ANY,
  getLoyaltyBookingSummary: ANY,
  listTransactions: ANY,
  getAutoApply: ANY,
  setAutoApply: MANAGE,
  getDiscountNotify: ANY,
  setDiscountNotify: MANAGE,
  getReferralSettings: ANY,
  setReferralSettings: MANAGE,
  // сертификаты
  listCertificateTypes: ANY,
  getCertificateType: ANY,
  createCertificateType: MANAGE,
  updateCertificateType: MANAGE,
  deleteCertificateType: MANAGE,
  listCertificates: ANY,
  getCertificate: ANY,
  adjustCertificate: MANAGE,
  voidCertificateSale: SELL,
  refundCertificateAmount: SELL,
  sellCertificate: SELL,
  // абонементы
  listMembershipTypes: ANY,
  getMembershipType: ANY,
  createMembershipType: MANAGE,
  updateMembershipType: MANAGE,
  setMembershipTypeArchived: MANAGE,
  duplicateMembershipType: MANAGE,
  deleteMembershipType: MANAGE,
  listMemberships: ANY,
  getMembership: ANY,
  setMembershipFrozen: SELL,
  adjustMembership: MANAGE,
  deleteMembershipSale: SELL,
  refundMembershipPartial: SELL,
  sellMembership: SELL,
  hasWaivingMembership: ANY,
  // счета клиентов
  listAccountTypes: ANY,
  getAccountType: ANY,
  createAccountType: MANAGE,
  updateAccountType: MANAGE,
  listClientAccounts: ANY,
  listClientAccountBalances: ANY,
  listAccountOperationsForAccount: ANY,
  openAccount: SELL,
  topupAccount: SELL,
  chargeAccount: SELL,
  cancelAccountTopup: SELL,
  refundAccountAmount: SELL,
  getAccountReceipt: ANY,
  listAccounts: ANY,
  listAccountOperations: ANY,
  // флаги услуги (карточка услуги)
  getServiceAutoCharge: ANY,
  setServiceAutoCharge: SERVICE_FLAG,
  getOnlineRequireMembership: ANY,
  setOnlineRequireMembership: SERVICE_FLAG,
  hasOnlineMembership: ANY,
  // оплата визита лояльностью
  previewCashback: ANY,
  syncBookingCashback: VISIT,
  getLoyaltyCostReport: ANY,
  listApplicablePromotions: ANY,
  getBonusChargeInfo: ANY,
  findLoyaltyByCode: ANY,
  getReferralEligibility: ANY,
  getLoyaltyPaymentSummary: ANY,
  commitLoyaltyPayment: VISIT,
  reverseLoyaltyLine: VISIT,
  reverseLoyaltyPayment: VISIT,
  financeLinesOf: ANY,
  setTxFinanceLine: VISIT,
  // онлайн-продажи
  getOnlineSalePayment: ANY,
  setOnlineSalePayment: MANAGE,
  getOnlineSaleWidget: ANY,
  setOnlineSaleWidget: MANAGE,
  listOnlineSaleCatalog: ANY,
  createOnlineOrder: SELL,
  listOnlineOrders: ANY,
  confirmOnlineOrder: SELL,
  rejectOnlineOrder: SELL,
  refundOnlineOrder: SELL,
  // автосписание с абонемента участника события (F-16-062, port/extra-ops.ts)
  getBookingAutoCharge: ANY,
  chargeBookingAutoDebit: VISIT,
};

/** Клиент приложения (/v1/me): первый аргумент — его userId (listMyLoyalty) или бизнес (реквизиты оплаты) */
export const ME_OPS = new Set(['listMyLoyalty', 'getOnlineSalePayment']);

/** Страница записи без входа (/v1/public): только «нужен ли абонемент» и «есть ли он по телефону» (F-06-128) */
export const PUBLIC_OPS = new Set(['getOnlineRequireMembership', 'hasOnlineMembership']);
