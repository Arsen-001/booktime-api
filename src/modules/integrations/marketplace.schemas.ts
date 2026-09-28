import { z } from 'zod';
import { appChannel } from './integrations.schemas.js';

/** Этап 21 (сдача, попытка 6): входы маркетплейса интеграций — формы как у фасада src/api/integrations.ts */

const country = z.enum(['AM', 'all']);

export const catalogQuery = z.object({
  categoryId: z.string().max(30).optional(),
  q: z.string().max(100).optional(),
  country: country.optional(),
  channel: z.string().max(20).optional(),
  capability: z.string().max(40).optional(),
  appKind: z.string().max(40).optional(),
});
export type CatalogQuery = z.infer<typeof catalogQuery>;

export const addReviewBody = z.object({ appId: z.string().min(1).max(40), rating: z.number().min(1).max(5), text: z.string().max(2000) });
export const subscribeCategoryBody = z.object({ categoryId: z.string().min(1).max(30) });
export const partnerApplicationBody = z.object({ appId: z.string().min(1).max(40) });

const gaFields = { streamId: z.string().min(1).max(40), formLabel: z.string().min(1).max(120) };

export const installAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('payPartner') }),
  z.object({ action: z.literal('refund') }),
  z.object({ action: z.literal('smsAuth'), authKey: z.string().max(200), senderName: z.string().trim().min(1).max(40) }),
  z.object({ action: z.literal('approveSender') }),
  z.object({ action: z.literal('topUp'), amountAmd: z.number().int().positive().max(100_000_000) }),
  z.object({ action: z.literal('sendTestMessage'), pricePerMessageAmd: z.number().min(0).max(1_000_000) }),
  z.object({ action: z.literal('whatsappMode'), mode: z.enum(['default', 'own']) }),
  z.object({ action: z.literal('approveMeta') }),
  z.object({ action: z.literal('cascadeOrder'), order: z.array(appChannel).max(8) }),
  z.object({ action: z.literal('chatbotTest'), channels: z.array(appChannel).max(8), canConfirm: z.boolean() }),
  z.object({ action: z.literal('negativeIntercept'), on: z.boolean() }),
  z.object({ action: z.literal('interceptReview') }),
  z.object({ action: z.literal('retentionRun'), days: z.number().int().min(1).max(3650) }),
  z.object({ action: z.literal('loyaltyVisit') }),
  z.object({ action: z.literal('fastSign') }),
  z.object({ action: z.literal('kommoMode'), mode: z.enum(['conditional', 'unconditional', 'none']) }),
  z.object({ action: z.literal('kommoDedupe'), dedupe: z.boolean() }),
  z.object({ action: z.literal('gaAdd'), ...gaFields }),
  z.object({ action: z.literal('gaUpdate'), streamPk: z.string().min(1).max(40), ...gaFields }),
  z.object({ action: z.literal('gaDelete'), streamPk: z.string().min(1).max(40) }),
]);
export type InstallAction = z.infer<typeof installAction>;

const promoIcon = z.enum(['gift', 'megaphone', 'star', 'percent', 'share2', 'sparkles']);
const promoPlacement = z.enum(['menu', 'serviceSelect', 'staffSelect', 'successScreen']);
export const promoBlockDraft = z.object({
  headline: z.string().max(200),
  description: z.string().max(1000),
  hasImage: z.boolean(),
  icon: promoIcon,
  buttonText: z.string().max(100),
  buttonHref: z.string().max(500),
  placements: z.array(promoPlacement).max(4),
});
export type PromoBlockDraftBody = z.infer<typeof promoBlockDraft>;
export const createPromoBlockBody = z.object({ locationId: z.string().min(1).max(32), draft: promoBlockDraft });
export const updatePromoBlockBody = z.object({ draft: promoBlockDraft });
export const setPromoBlockEnabledBody = z.object({ enabled: z.boolean() });

export const registerDeveloperBody = z.object({
  companyName: z.string().trim().min(1).max(200),
  purpose: z.string().max(2000),
  contactName: z.string().trim().min(1).max(160),
  contactPhone: z.string().max(40),
  contactEmail: z.string().max(200),
  contactWebsite: z.string().max(300).optional(),
  partnerBearer: z.string().max(300).optional(),
});
export type RegisterDeveloperBody = z.infer<typeof registerDeveloperBody>;

export const createDevAppBody = z.object({
  name: z.string().trim().min(1).max(120),
  appCode: z.string().max(80),
  categoryId: z.string().min(1).max(30),
  isPrivate: z.boolean(),
});
export type CreateDevAppBody = z.infer<typeof createDevAppBody>;

const devLocale = z.enum(['ru', 'en', 'hy']);
const aboutText = z.object({
  description: z.string().max(10_000),
  features: z.array(z.string().max(300)).max(100),
  faq: z.array(z.object({ q: z.string().max(1000), a: z.string().max(5000) })).max(200),
});
const devSettingsPatch = z
  .object({
    registrationUrl: z.string().max(500),
    callbackUrl: z.string().max(500),
    webhookUrl: z.string().max(500),
    passUserData: z.boolean(),
    iframeMode: z.boolean(),
    allowMultiLocation: z.boolean(),
  })
  .partial();
const planSchema = z.object({ name: z.string().max(120), price: z.number(), currency: z.string().max(3), period: z.string().max(20), features: z.array(z.string().max(200)).max(30) }).passthrough();
const monetizationPatch = z
  .object({
    isPaid: z.boolean(),
    priceAmount: z.number().min(0),
    currency: z.enum(['AMD', 'USD', 'EUR']),
    trialDays: z.number().int().min(0).max(365),
    tariffPlans: z.array(planSchema).max(20),
  })
  .partial();
const publicationPatch = z.object({ connectInstructions: z.string().max(5000), paymentInstructions: z.string().max(5000) }).partial();

export const devAppAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('about'), locale: devLocale, galleryCount: z.number().int().optional(), videoUrl: z.string().max(500).optional(), text: aboutText }),
  z.object({ action: z.literal('devSettings'), patch: devSettingsPatch }),
  z.object({ action: z.literal('apiAccess'), systemUserId: z.string().max(80), permissions: z.array(z.string().max(80)).max(100) }),
  z.object({ action: z.literal('submit') }),
  z.object({ action: z.literal('moderate'), decision: z.enum(['published', 'rejected']) }),
  z.object({ action: z.literal('testInstall'), locationId: z.string().max(32).optional() }),
  z.object({ action: z.literal('testUninstall') }),
  z.object({ action: z.literal('monetization'), patch: monetizationPatch }),
  z.object({ action: z.literal('publication'), patch: publicationPatch }),
  z.object({ action: z.literal('tariffSheet'), fileName: z.string().min(1).max(200) }),
]);
export type DevAppAction = z.infer<typeof devAppAction>;
