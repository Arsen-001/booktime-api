import type { Request } from 'express';
import type { Locale } from '../i18n/i18n.js';
import type { Permission, StaffRole } from '../permissions/permissions.js';

export type SessionApp = 'client' | 'business' | 'platform';
export type SessionMode = 'client' | 'business';

/** Кто вошёл (сессия в базе, PLAN.md Р8). Заполняет SessionResolver (common/http/session-resolver.ts). */
export interface SessionInfo {
  sessionId: string;
  userId: string;
  locale: Locale;
  /** Вход команды платформы (Р11) — отдельная cookie PLATFORM_COOKIE */
  platform?: boolean;
  /** Каким входом открыта сессия */
  app: SessionApp;
  /** Переключатель «Я клиент / Мой бизнес» (В-21) */
  mode: SessionMode;
  activeBusinessId: string | null;
  /** Вход логином администратора (F-00-034) */
  staffLoginId: string | null;
  platformMemberId: string | null;
  /** Пароль выдан владельцем и не сменён: экран просит сменить (F-00-034) */
  mustChangePassword: boolean;
}

/** В какой роли человек действует в бизнесе из пути (docs/backend/03 §2). Заполняет MembershipResolver — этап 3. */
export interface MemberInfo {
  businessId: string;
  staffId: string;
  role: StaffRole;
  permissions: ReadonlySet<Permission>;
  /** Имя для журнала изменений (снимок) */
  name: string;
}

/** Контекст одного запроса: кладётся в req.ctx промежуточным слоем ContextMiddleware */
export interface RequestContext {
  requestId: string;
  ip: string;
  device: string;
  session: SessionInfo | null;
  member: MemberInfo | null;
}

export type RequestWithContext = Request & { ctx: RequestContext };

export const SESSION_COOKIE = 'bt_session';
/** Сессия команды платформы — своя cookie: человек из команды может в том же браузере быть и клиентом */
export const PLATFORM_COOKIE = 'bt_platform';

/** Пути, для которых сессия берётся из PLATFORM_COOKIE */
export function isPlatformPath(path: string): boolean {
  return path.startsWith('/v1/platform') || path.startsWith('/v1/auth/platform');
}
