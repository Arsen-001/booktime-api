import { z } from 'zod';

/** Наша панель → «Пользователи» (03.10.2026): все зарегистрированные люди, фильтры, блокировка. */

export const USER_ROLE_FILTERS = ['client', 'owner', 'admin', 'master', 'multiple'] as const;
export const USER_STATUSES = ['active', 'blocked', 'delete_requested', 'deleted'] as const;
export const USER_SORTS = ['registered', 'last_login', 'bookings'] as const;
export const USER_PAGE_SIZES = [10, 20, 50, 100] as const;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const yesNo = z.enum(['yes', 'no']);

export const usersListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(USER_ROLE_FILTERS).optional(),
  regFrom: localDate.optional(),
  regTo: localDate.optional(),
  /** Был активен (любая сессия) за последние N дней */
  activeDays: z.coerce.number().int().min(1).max(365).optional(),
  telegram: yesNo.optional(),
  google: yesNo.optional(),
  status: z.enum(USER_STATUSES).optional(),
  sort: z.enum(USER_SORTS).default('registered'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (USER_PAGE_SIZES as readonly number[]).includes(n), 'page_size')
    .default(20),
});
export type UsersListQuery = z.infer<typeof usersListQuery>;

/** Заблокировать — причина обязательна (пишется в журнал); разблокировать — по желанию */
export const userBlockBody = z
  .object({
    blocked: z.boolean(),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((b) => !b.blocked || (b.reason?.length ?? 0) >= 3, { path: ['reason'], message: 'required' });
export type UserBlockBody = z.infer<typeof userBlockBody>;
