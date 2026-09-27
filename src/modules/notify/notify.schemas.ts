import { z } from 'zod';

export const localizedText = z.object({ ru: z.string().min(1).max(600), hy: z.string().max(600).optional(), en: z.string().max(600).optional() });

export const updateTypeBody = z.object({
  kind: z.string().min(1).max(32),
  patch: z.object({
    enabled: z.boolean().optional(),
    channels: z.array(z.object({ channel: z.literal('push'), scenario: z.enum(['off', 'always']) })).optional(),
  }),
});

export const updateTemplatesBody = z.object({ push: localizedText.partial({ ru: true }).optional() });

export const createNewsBody = z.object({ text: localizedText });

export const staffNotifyPatchBody = z.object({
  new_booking: z.boolean().optional(),
  client_cancelled: z.boolean().optional(),
  client_rescheduled: z.boolean().optional(),
  empty_week: z.boolean().optional(),
});

export const clientNotifyPatchBody = z.object({
  marketingOptOut: z.boolean().optional(),
  channels: z.object({ push: z.boolean().optional(), sms: z.boolean().optional(), email: z.boolean().optional() }).optional(),
  disabledTypeCodes: z.array(z.number().int()).max(200).optional(),
});

export const webPopupBody = z.object({ bookingOps: z.boolean(), incomingCalls: z.boolean() });

export const emailChannelBody = z.object({ replyEmail: z.string().max(160) });

export const dismissBannerBody = z.object({ bannerId: z.string().min(1).max(64) });

export const channelOverviewBody = z.object({
  channel: z.enum(['push', 'adminApp', 'email', 'sms', 'brandedApp', 'whatsapp', 'telegram']),
  connected: z.boolean(),
});

export const sendStaffInviteBody = z.object({ target: z.string().min(3).max(160) });

export const inboxReadBody = z.object({ ids: z.array(z.string().min(1).max(32)).min(1).max(100) });

export const connectChannelBody = z.object({
  channel: z.enum(['sms', 'whatsapp']),
  senderName: z.string().min(1).max(40),
  apiKey: z.string().min(1).max(200),
});

export const sendTestChannelBody = z.object({ to: z.string().min(4).max(20) });

// ─────────── этап 21 «notify+integrations», попытка 3 ───────────

export const quietHoursBody = z.object({ enabled: z.boolean(), from: z.string().min(4).max(5), to: z.string().min(4).max(5) });

export const notifySettingsBody = z.object({
  language: z.enum(['ru', 'hy', 'en']),
  dateFormat: z.enum(['24h', '12h']),
  quietHours: quietHoursBody.optional(),
});

export const giftShowcaseBody = z.object({ enabled: z.boolean(), partnerName: z.string().max(60) });

export const openSlotsScheduleBody = z.object({
  enabled: z.boolean(),
  sendMorningToday: z.boolean(),
  sendEveningTomorrow: z.boolean(),
  timeMorning: z.string().min(4).max(5),
  timeEvening: z.string().min(4).max(5),
});

export const partnerSummaryBody = z.object({
  telegramEnabled: z.boolean(),
  telegramChatLabel: z.string().max(60),
  emailEnabled: z.boolean(),
  connectionWatchdog: z.boolean(),
});

export const altegioWhatsAppBody = z.object({
  mode: z.enum(['none', 'notificationSender', 'embeddedSignup', 'coexistence']),
  templatesApproved: z.boolean(),
  ownNumber: z.string().max(20).optional(),
  companyName: z.string().max(120).optional(),
});

export const altegioWhatsAppModeBody = z.object({ mode: z.enum(['none', 'notificationSender', 'embeddedSignup', 'coexistence']) });

export const agentFlagsBody = z.object({ sendToClient: z.boolean(), sendToAdmin: z.boolean() });

export const serviceReminderHoursBody = z.object({ hours: z.number().int().min(0).max(720).nullable() });

export const NOTIFY_WEBHOOK_ENTITIES = ['location', 'staff', 'clients', 'bookings', 'loyaltyCards', 'services', 'products', 'sales'] as const;

export const createWebhookBody = z.object({ url: z.string().min(8).max(500), entities: z.array(z.enum(NOTIFY_WEBHOOK_ENTITIES)).min(1) });

export const setWebhookActiveBody = z.object({ active: z.boolean() });

export const sendFiscalReceiptEmailBody = z.object({ clientId: z.string().min(1).max(32), receiptUrl: z.string().min(1).max(500), email: z.string().min(3).max(160) });

export const sendDataExportEmailBody = z.object({
  toEmail: z.string().min(3).max(160),
  reportLabel: localizedText,
  downloadUrl: z.string().min(1).max(500),
  staffId: z.string().max(32).optional(),
});

export const sendPlanReportEmailBody = z.object({
  toEmail: z.string().min(3).max(160),
  downloadUrl: z.string().min(1).max(500),
  frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
});

export const bookingNotifyOverrideBody = z.object({
  sendOnSave: z.boolean(),
  pushEnabled: z.boolean(),
  pushTimingHours: z.number().int().min(0).max(168),
  smsEnabled: z.boolean(),
  smsTimingHours: z.number().int().min(0).max(168),
  emailEnabled: z.boolean(),
  emailTimingHours: z.number().int().min(0).max(168),
});
