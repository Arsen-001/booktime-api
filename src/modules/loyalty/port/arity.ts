// СГЕНЕРИРОВАНО scripts/sync-loyalty-port.mjs из сигнатур logic.ts / extra-ops.ts / client-ops.ts; руками не править.
/** Обязательные аргументы функций фасада лояльности: грубый вид каждого (string | number | boolean | array | object | any) */
export const REQUIRED_ARGS: Record<string, readonly ('string' | 'number' | 'boolean' | 'array' | 'object' | 'any')[]> = {
  "clientOf": [
    "object",
    "string"
  ],
  "locationNameOf": [
    "object",
    "string",
    "string"
  ],
  "reverseLoyaltyPaymentLines": [
    "object",
    "string",
    "string",
    "boolean"
  ],
  "reconcileDeletedBookingPayments": [
    "string"
  ],
  "listCardTypes": [
    "string"
  ],
  "getCardType": [
    "string",
    "string"
  ],
  "createCardType": [
    "string",
    "object"
  ],
  "updateCardType": [
    "string",
    "string",
    "object"
  ],
  "deleteCardType": [
    "string",
    "string"
  ],
  "setCardTypeArchived": [
    "string",
    "string",
    "boolean"
  ],
  "getCardSoldPaid": [
    "string",
    "string"
  ],
  "genCardNumberSeed": [
    "string"
  ],
  "resolveCardNumber": [
    "string",
    "array",
    "any"
  ],
  "cardCaps": [
    "array",
    "string"
  ],
  "issueCard": [
    "string",
    "string",
    "string"
  ],
  "deleteCard": [
    "string",
    "string"
  ],
  "adjustCardBalance": [
    "string",
    "string",
    "string",
    "number"
  ],
  "listPromotions": [
    "string"
  ],
  "getPromotionsReport": [
    "string"
  ],
  "listServiceScopeOptions": [
    "string"
  ],
  "createPromotion": [
    "string",
    "object"
  ],
  "getPromotion": [
    "string",
    "string"
  ],
  "updatePromotion": [
    "string",
    "string",
    "object"
  ],
  "deletePromotion": [
    "string",
    "string"
  ],
  "listCards": [
    "string"
  ],
  "getCard": [
    "string",
    "string"
  ],
  "getLoyaltyHubOverview": [
    "string"
  ],
  "getLoyaltyBookingSummary": [
    "string",
    "string"
  ],
  "listTransactions": [
    "string"
  ],
  "defaultAutoApply": [
    "string"
  ],
  "getAutoApply": [
    "string"
  ],
  "setAutoApply": [
    "string",
    "object"
  ],
  "getDiscountNotify": [
    "string"
  ],
  "setDiscountNotify": [
    "string",
    "object"
  ],
  "defaultReferral": [
    "string"
  ],
  "getReferralSettings": [
    "string"
  ],
  "setReferralSettings": [
    "string",
    "object"
  ],
  "listCertificateTypes": [
    "string"
  ],
  "getCertificateType": [
    "string",
    "string"
  ],
  "createCertificateType": [
    "string",
    "object"
  ],
  "updateCertificateType": [
    "string",
    "string",
    "object"
  ],
  "deleteCertificateType": [
    "string",
    "string"
  ],
  "usedLocationsOf": [
    "object",
    "object",
    "string",
    "string"
  ],
  "certificateStatus": [
    "object",
    "string"
  ],
  "listCertificates": [
    "string"
  ],
  "getCertificate": [
    "string",
    "string"
  ],
  "adjustCertificate": [
    "string",
    "string",
    "object"
  ],
  "voidCertificateSale": [
    "string",
    "string"
  ],
  "refundCertificateAmount": [
    "string",
    "string",
    "number"
  ],
  "certificateExpiryFor": [
    "object",
    "object"
  ],
  "recordSaleOrRollback": [
    "string",
    "any",
    "object"
  ],
  "sellCertificate": [
    "string",
    "object"
  ],
  "listMembershipTypes": [
    "string"
  ],
  "getMembershipType": [
    "string",
    "string"
  ],
  "createMembershipType": [
    "string",
    "object"
  ],
  "updateMembershipType": [
    "string",
    "string",
    "object"
  ],
  "setMembershipTypeArchived": [
    "string",
    "string",
    "boolean"
  ],
  "duplicateMembershipType": [
    "string",
    "string"
  ],
  "deleteMembershipType": [
    "string",
    "string"
  ],
  "membershipStatus": [
    "object",
    "string"
  ],
  "reconcileFrozenMemberships": [
    "string"
  ],
  "listMemberships": [
    "string"
  ],
  "getMembership": [
    "string",
    "string"
  ],
  "setMembershipFrozen": [
    "string",
    "string",
    "boolean"
  ],
  "adjustMembership": [
    "string",
    "string",
    "object"
  ],
  "deleteMembershipSale": [
    "string",
    "string"
  ],
  "refundMembershipPartial": [
    "string",
    "string",
    "number"
  ],
  "membershipTotalVisits": [
    "object"
  ],
  "sellMembership": [
    "string",
    "object"
  ],
  "listAccountTypes": [
    "string"
  ],
  "getAccountType": [
    "string",
    "string"
  ],
  "createAccountType": [
    "string",
    "object"
  ],
  "updateAccountType": [
    "string",
    "string",
    "object"
  ],
  "listClientAccounts": [
    "string",
    "string"
  ],
  "listClientAccountBalances": [
    "string"
  ],
  "listAccountOperationsForAccount": [
    "string",
    "string"
  ],
  "openAccount": [
    "string",
    "string",
    "string",
    "string"
  ],
  "topupAccount": [
    "string",
    "string",
    "number"
  ],
  "chargeAccount": [
    "string",
    "string",
    "number"
  ],
  "cancelAccountTopup": [
    "string",
    "string",
    "string"
  ],
  "refundAccountAmount": [
    "string",
    "string",
    "number"
  ],
  "getAccountReceipt": [
    "string",
    "string"
  ],
  "hasWaivingMembership": [
    "string",
    "string"
  ],
  "isCertificateLikeExpired": [
    "string"
  ],
  "getServiceAutoCharge": [
    "string",
    "string"
  ],
  "setServiceAutoCharge": [
    "string",
    "string",
    "object"
  ],
  "getOnlineRequireMembership": [
    "string",
    "string"
  ],
  "setOnlineRequireMembership": [
    "string",
    "string",
    "boolean"
  ],
  "hasOnlineMembership": [
    "string",
    "string",
    "string"
  ],
  "listAccounts": [
    "string"
  ],
  "visitSums": [
    "object"
  ],
  "inServiceScope": [
    "object",
    "any",
    "string"
  ],
  "scopedSum": [
    "object",
    "any",
    "object",
    "string"
  ],
  "promoWorksAt": [
    "object",
    "any"
  ],
  "cardWorksAt": [
    "object",
    "object",
    "any"
  ],
  "cardPromotions": [
    "object",
    "object",
    "string",
    "any",
    "object"
  ],
  "pastVisits": [
    "object",
    "string",
    "string",
    "object",
    "object"
  ],
  "historySum": [
    "object",
    "array"
  ],
  "stepValue": [
    "object",
    "number"
  ],
  "applyValue": [
    "any",
    "number",
    "number"
  ],
  "promotionDiscountFor": [
    "object",
    "object",
    "object",
    "array"
  ],
  "cashbackFor": [
    "object",
    "object",
    "object",
    "object",
    "object",
    "number",
    "array"
  ],
  "computeCashback": [
    "object",
    "object",
    "string",
    "string",
    "object",
    "number"
  ],
  "moneyPaidOf": [
    "array"
  ],
  "previewCashback": [
    "string",
    "string",
    "object",
    "number"
  ],
  "syncBookingCashback": [
    "string",
    "string",
    "string",
    "string",
    "array",
    "object"
  ],
  "getLoyaltyCostReport": [
    "string"
  ],
  "reconcileBirthdayBonus": [
    "string"
  ],
  "cardBurnDays": [
    "object",
    "object"
  ],
  "cardLastActivity": [
    "object",
    "object",
    "object"
  ],
  "cardBurnsAt": [
    "object",
    "object",
    "object"
  ],
  "reconcileBonusBurn": [
    "string"
  ],
  "listApplicablePromotions": [
    "string",
    "string",
    "object"
  ],
  "bonusMax": [
    "object",
    "object",
    "object",
    "number"
  ],
  "getBonusChargeInfo": [
    "string",
    "string",
    "number"
  ],
  "certificateCover": [
    "object",
    "object",
    "object",
    "any"
  ],
  "membershipCover": [
    "object",
    "object",
    "object",
    "any"
  ],
  "findLoyaltyByCode": [
    "string",
    "string"
  ],
  "getReferralEligibility": [
    "string",
    "any",
    "string",
    "number"
  ],
  "getLoyaltyPaymentSummary": [
    "string",
    "string"
  ],
  "commitLoyaltyPayment": [
    "string",
    "string",
    "string",
    "string",
    "array"
  ],
  "undoLoyaltyTx": [
    "object",
    "object"
  ],
  "reverseLoyaltyLine": [
    "string",
    "string",
    "string"
  ],
  "reverseLoyaltyPayment": [
    "string",
    "string"
  ],
  "isLoyaltyPaymentRef": [
    "any"
  ],
  "isDiscountPayment": [
    "string"
  ],
  "payVisitWithLoyalty": [],
  "capLinesToDue": [
    "string",
    "string",
    "array"
  ],
  "mirrorToFinance": [
    "string",
    "string",
    "array"
  ],
  "setTxFinanceLine": [
    "string",
    "string",
    "string"
  ],
  "financeLinesOf": [
    "string",
    "string"
  ],
  "visitPaymentsForCashback": [
    "string",
    "string",
    "array"
  ],
  "unmirrorFromFinance": [
    "string",
    "array"
  ],
  "cancelVisitPaymentLine": [
    "object",
    "object"
  ],
  "cancelVisitPayments": [
    "object"
  ],
  "listAccountOperations": [
    "string"
  ],
  "getOnlineSalePayment": [
    "string"
  ],
  "setOnlineSalePayment": [
    "string",
    "object"
  ],
  "getOnlineSaleWidget": [
    "string"
  ],
  "setOnlineSaleWidget": [
    "string",
    "object"
  ],
  "listOnlineSaleCatalog": [
    "string"
  ],
  "createOnlineOrder": [
    "string",
    "object"
  ],
  "listOnlineOrders": [
    "string"
  ],
  "confirmOnlineOrder": [
    "string",
    "string"
  ],
  "rejectOnlineOrder": [
    "string",
    "string"
  ],
  "refundOnlineOrder": [
    "string",
    "string"
  ],
  "listMyLoyalty": [
    "string"
  ],
  "getBookingAutoCharge": [
    "string",
    "string",
    "string"
  ],
  "chargeBookingAutoDebit": [
    "string",
    "string",
    "string",
    "string"
  ],
  "myClientIds": [
    "object",
    "string"
  ],
  "businessNetwork": [
    "object",
    "any"
  ],
  "attachBusiness": [
    "object",
    "object"
  ],
  "typeTotalVisits": [
    "any"
  ],
  "typeServiceNames": [
    "object",
    "any"
  ],
  "membershipTitle": [
    "any"
  ],
  "membershipView": [
    "object",
    "object",
    "any",
    "string"
  ],
  "pendingMembershipView": [
    "object",
    "object",
    "object"
  ],
  "appliesTo": [
    "any"
  ],
  "certificateView": [
    "object",
    "object",
    "string"
  ],
  "pendingCertificateView": [
    "object",
    "object"
  ],
  "scopeServiceNames": [
    "object",
    "object"
  ],
  "cashbackView": [
    "object",
    "object",
    "object",
    "string"
  ],
  "myMemberships": [
    "string"
  ],
  "myCertificates": [
    "string"
  ],
  "myCards": [
    "string"
  ],
  "appListMemberships": [
    "string"
  ],
  "appGetMembership": [
    "string",
    "string"
  ],
  "appToggleMembershipFreeze": [
    "string",
    "string"
  ],
  "appToggleMembershipAutoRenew": [
    "string",
    "string"
  ],
  "appListCertificates": [
    "string"
  ],
  "appGetCertificate": [
    "string",
    "string"
  ],
  "appListLoyaltyCards": [
    "string"
  ],
  "appGetCashbackForBusiness": [
    "string",
    "string"
  ],
  "appGetBookingMembershipOption": [
    "string",
    "string",
    "string"
  ],
  "appListPendingMembershipReminders": [
    "string"
  ],
  "appMarkMembershipReminderSeen": [
    "string",
    "string"
  ],
  "appPendingView": [
    "object"
  ],
  "salesSourceBusinessId": [
    "string"
  ],
  "membershipTemplate": [
    "object",
    "object"
  ],
  "certificateValidDays": [
    "object"
  ],
  "appListPurchasableMemberships": [
    "string"
  ],
  "appListPurchasableCertificates": [
    "string"
  ],
  "appFindRenewTemplate": [
    "string",
    "object"
  ],
  "appSaleTypeInfo": [
    "string",
    "string"
  ],
  "appCountVisitLoyaltyOptions": [
    "string",
    "any"
  ],
  "appIssueLoyaltyCard": [
    "string",
    "string"
  ],
  "appFindLoyaltyByCode": [
    "string",
    "string"
  ],
  "appSetCashbackVisibleForBusiness": [
    "string",
    "boolean"
  ],
  "appGetCashbackVisibleForBusiness": [
    "string"
  ]
};
