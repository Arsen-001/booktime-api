import { z } from 'zod';
import { channel, locale } from '../auth/auth.schemas.js';

/** Аккаунт человека — /v1/me (docs/backend/02 §1) */
export const patchAccountBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  locale: locale.optional(),
  gender: z.enum(['female', 'male', 'unknown']).optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  district: z.string().max(40).nullable().optional(),
  photoUrl: z.string().max(500).nullable().optional(),
  bigFont: z.boolean().optional(),
  timeFormat: z.enum(['24h', '12h']).optional(),
});

export const phoneCodeBody = z.object({ phone: z.string().min(8).max(24), channel: channel.default('telegram') });
export const phoneConfirmBody = z.object({ phone: z.string().min(8).max(24), code: z.string().regex(/^\d{4}$/) });
export const twoFactorBody = z.object({ enabled: z.boolean() });
export const pushTokenBody = z.object({
  app: z.enum(['client', 'business']),
  platform: z.enum(['web', 'android', 'ios']),
  /** FCM-токен или endpoint подписки Web Push */
  token: z.string().min(10).max(512),
  /** Подписка Web Push целиком (keys.p256dh, keys.auth) */
  subscription: z.record(z.string(), z.unknown()).optional(),
});
export const pushTokenDeleteBody = z.object({ token: z.string().min(10).max(512) });

// ─────────── этап 21 (лейн client+online, попытка 2): мелкие настройки профиля приложения ───────────

/** F-14-136: пуш о новостях ПРОДУКТА (не «новости компании» бизнеса) */
export const newsPushOptOutBody = z.object({ optOut: z.boolean() });

/** F-14-163: филиал сети по умолчанию, выбранный клиентом */
export const networkDefaultLocationBody = z.object({ businessId: z.string().min(1) });

/** F-14-059: своя карточка профиля приложения (носы шоу считает сервер, не фронт) */
export const clientProfileView = z.object({
  appUser: z.object({ id: z.string(), phone: z.string().nullable(), name: z.string(), gender: z.string(), birthday: z.string().nullable(), district: z.string().nullable(), locale: locale, createdAt: z.string(), photoUrl: z.string().nullable() }),
  photoUrl: z.string().nullable(),
  timeFormat: z.string(),
  noShowCount: z.number(),
});

export const accountView = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  locale,
  twoFactorEnabled: z.boolean(),
  sessionsRevokedAt: z.string().nullable(),
  deleteRequestedAt: z.string().nullable(),
  /** Когда аккаунт удалится (через 25 дней после запроса) */
  deletionAt: z.string().nullable(),
  /** «Запрос на блокировку данных» подан и ждёт рассмотрения (F-15-155, этап 20) */
  dataBlockRequestedAt: z.string().nullable(),
  profile: z
    .object({
      gender: z.string(),
      birthday: z.string().nullable(),
      district: z.string().nullable(),
      photoUrl: z.string().nullable(),
      bigFont: z.boolean(),
      timeFormat: z.string(),
      consentAt: z.string().nullable(),
    })
    .nullable(),
  version: z.number(),
});

export const sessionRow = z.object({
  id: z.string(),
  app: z.string(),
  device: z.string(),
  ip: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  current: z.boolean(),
});

export const loginEventRow = z.object({
  id: z.string(),
  at: z.string(),
  method: z.string(),
  app: z.string(),
  result: z.string(),
  device: z.string(),
  ip: z.string(),
  current: z.boolean(),
});

// ─────────── этап 20: данные и удаление (F-15-154/155) ───────────

/** «Выгрузить мои данные» (F-15-154) — история заявок, новые сверху; готовность всегда мгновенная */
export const dataExportRow = z.object({
  id: z.string(),
  requestedAt: z.string(),
  ready: z.boolean(),
});
