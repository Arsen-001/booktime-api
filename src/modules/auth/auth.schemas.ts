import { z } from 'zod';

/** Схемы входа (docs/backend/02 §1). Они же — тела запросов в OpenAPI. */
export const channel = z.enum(['telegram', 'whatsapp', 'sms']);
export const locale = z.enum(['ru', 'hy', 'en']);
const code = z.string().regex(/^\d{4}$/, 'four_digits');

export const sendCodeBody = z.object({
  phone: z.string().min(8).max(24),
  /** Куда прислать; выключенный или не доставивший канал — код уйдёт в следующий включённый (ответ скажет куда) */
  channel: channel.default('telegram'),
  locale: locale.optional(),
});

export const verifyCodeBody = z.object({
  phone: z.string().min(8).max(24),
  code,
  /** Каким входом: клиент (F-00-032) или кабинет бизнеса (F-00-033) */
  app: z.enum(['client', 'business']).default('client'),
  name: z.string().max(120).optional(),
  consent: z.boolean().optional(),
  locale: locale.optional(),
  /** «Войти через Google» с непривязанным аккаунтом: токен из ответа /v1/auth/google — верный код привяжет Google к номеру */
  pendingGoogle: z.string().min(16).max(64).optional(),
});

/** «Войти через Google» (03.10.2026): ID token из Google Identity Services */
export const googleBody = z.object({
  idToken: z.string().min(20).max(4096),
  app: z.enum(['client', 'business']).default('client'),
  /** Клиент нажал кнопку под текстом «Продолжая, вы принимаете соглашение» (F-14-008) */
  consent: z.boolean().optional(),
});

/** Привязать Google из профиля вошедшего */
export const googleLinkBody = z.object({ idToken: z.string().min(20).max(4096) });

export const passwordBody = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  /** Канал кода для второго шага, если он включён */
  channel: channel.optional(),
});

export const challengeBody = z.object({ challengeId: z.string().min(4).max(32), code });

export const changePasswordBody = z.object({
  oldPassword: z.string().max(128).optional(),
  newPassword: z.string().max(128),
});

export const modeBody = z.object({
  mode: z.enum(['client', 'business']),
  businessId: z.string().max(32).optional(),
});

export const logoutAllBody = z.object({
  /** true — закрыть все сеансы, кроме этого устройства (F-15-152) */
  keepCurrent: z.boolean().default(true),
});

const user = z.object({ id: z.string(), name: z.string(), phone: z.string().nullable(), locale });
const membership = z.object({
  businessId: z.string(),
  businessName: z.string(),
  kind: z.string(),
  networkId: z.string().nullable(),
  staffId: z.string(),
  role: z.string(),
});

export const sessionView = z.object({
  user,
  app: z.enum(['client', 'business', 'platform']),
  mode: z.enum(['client', 'business']),
  activeBusinessId: z.string().nullable(),
  memberships: z.array(membership),
  staffLogin: z.string().nullable(),
  mustChangePassword: z.boolean(),
  consent: z.boolean(),
});

export const sessionOrGuest = z.object({ session: sessionView.nullable() });

/** Ответ verify: с pendingGoogle — привязался ли Google (false — токен истёк или этот Google уже у другого человека) */
export const verifyView = sessionView.extend({ googleLinked: z.boolean().optional() });

export const googleLogin = z.object({
  /** Google привязан — сессия открыта (cookie поставлена) */
  session: sessionView.nullable(),
  /** Не привязан — нужен номер и код один раз: token передать в /v1/auth/verify как pendingGoogle */
  pendingGoogle: z.object({ token: z.string(), email: z.string(), name: z.string().nullable(), expiresIn: z.number() }).nullable(),
});

/** Google в профиле: enabled — вход через Google настроен на сервере; email — привязанный аккаунт или null */
export const googleStatus = z.object({ enabled: z.boolean(), email: z.string().nullable() });

export const codeSent = z.object({
  challengeId: z.string(),
  resendAfter: z.number(),
  expiresIn: z.number(),
  /** Куда код ушёл на самом деле (запасной канал, если запрошенный не доставил) */
  channel,
  /** Включённые каналы — экран кода предлагает «Прислать в <другой>» */
  channels: z.array(channel),
});

export const codeChannels = z.object({ channels: z.array(channel) });

export const secondFactor = z.object({
  secondFactor: z.object({ challengeId: z.string(), phoneMasked: z.string(), resendAfter: z.number(), expiresIn: z.number() }),
});

export const platformView = z.object({ user, login: z.string(), role: z.string() });
