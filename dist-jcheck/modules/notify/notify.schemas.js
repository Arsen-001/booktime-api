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
});
export const inboxReadBody = z.object({ ids: z.array(z.string().min(1).max(32)).min(1).max(100) });
export const connectChannelBody = z.object({
    channel: z.enum(['sms', 'whatsapp']),
    senderName: z.string().min(1).max(40),
    apiKey: z.string().min(1).max(200),
});
export const sendTestChannelBody = z.object({ to: z.string().min(4).max(20) });
//# sourceMappingURL=notify.schemas.js.map