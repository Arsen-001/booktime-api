import { z } from 'zod';

/** Этап 21 (сдача, попытка 6): входы сторис/новостей/продвижения кабинета — формы как у client.ts фронта */

const storyLang = z.enum(['ru', 'hy', 'en']);

export const purchaseStoryBody = z.object({
  kind: z.enum(['generated', 'photo']),
  /** data URI картинки (сгенерированная SVG или своё фото), до ~5 МБ */
  imageUrl: z.string().min(1).max(6_000_000),
  lang: z.array(storyLang).max(3),
  showStaffNames: z.boolean(),
  windows: z.array(z.object({ staffId: z.string().max(32).optional(), staffName: z.string().max(120).optional(), times: z.array(z.string().max(5)).max(10) })).max(10),
  bookingTarget: z.object({ staffId: z.string().max(32).optional(), serviceId: z.string().max(32).optional() }).optional(),
  caption: z.string().max(200).optional(),
});
export type PurchaseStoryBody = z.infer<typeof purchaseStoryBody>;

export const newsPostBody = z.object({ text: z.string().max(4000), photoUrl: z.string().max(6_000_000).optional() });
export type NewsPostBody = z.infer<typeof newsPostBody>;

export const hotSlotBody = z.object({ percent: z.number().int().min(1).max(90).nullable() });
export const boostBody = z.object({ kind: z.enum(['search', 'home']) });
