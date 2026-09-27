import type { Id } from './core-types.js';
import type {
  AccountOperation,
  AccountType,
  AutoApplySettings,
  CardType,
  Certificate,
  CertificateType,
  ClientAccount,
  DiscountNotifySettings,
  LoyaltyCard,
  LoyaltyTransaction,
  Membership,
  MembershipType,
  OnlineOrder,
  OnlineSalePaymentSettings,
  OnlineSaleWidgetSettings,
  Promotion,
  ReferralSettings,
} from './domain.js';

/** Срез «loyalty» фронта (booking-platform/src/mock/slices/loyalty.ts, LoyaltyState) — один в один */
export interface LoyaltyState {
  cardTypes: CardType[];
  cards: LoyaltyCard[];
  promotions: Promotion[];
  transactions: LoyaltyTransaction[];
  autoApply: Record<Id, AutoApplySettings>;
  referral: Record<Id, ReferralSettings>;
  certificateTypes: CertificateType[];
  certificates: Certificate[];
  membershipTypes: MembershipType[];
  memberships: Membership[];
  accountTypes: AccountType[];
  accounts: ClientAccount[];
  accountOperations: AccountOperation[];
  serviceAutoCharge: Record<Id, { enabled: boolean; freeCancelHours: number }>;
  onlineRequireMembership: Record<Id, boolean>;
  paidBookingIds: Id[];
  onlineSalePayment: Record<Id, OnlineSalePaymentSettings>;
  onlineSaleWidget: Record<Id, OnlineSaleWidgetSettings>;
  onlineOrders: OnlineOrder[];
  discountNotify: Record<Id, DiscountNotifySettings>;
}

/** Настройки среза, которые не сущности: одна строка business_settings (area='loyalty-port') на бизнес */
export const SETTINGS_KEYS = ['autoApply', 'referral', 'serviceAutoCharge', 'onlineRequireMembership', 'onlineSalePayment', 'onlineSaleWidget', 'discountNotify'] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export interface SettingsBag {
  autoApply?: Record<Id, AutoApplySettings>;
  referral?: Record<Id, ReferralSettings>;
  serviceAutoCharge?: Record<Id, { enabled: boolean; freeCancelHours: number }>;
  onlineRequireMembership?: Record<Id, boolean>;
  onlineSalePayment?: Record<Id, OnlineSalePaymentSettings>;
  onlineSaleWidget?: Record<Id, OnlineSaleWidgetSettings>;
  discountNotify?: Record<Id, DiscountNotifySettings>;
  paidBookingIds?: Id[];
}

export function emptyState(): LoyaltyState {
  return {
    cardTypes: [],
    cards: [],
    promotions: [],
    transactions: [],
    autoApply: {},
    referral: {},
    certificateTypes: [],
    certificates: [],
    membershipTypes: [],
    memberships: [],
    accountTypes: [],
    accounts: [],
    accountOperations: [],
    serviceAutoCharge: {},
    onlineRequireMembership: {},
    paidBookingIds: [],
    onlineSalePayment: {},
    onlineSaleWidget: {},
    onlineOrders: [],
    discountNotify: {},
  };
}
