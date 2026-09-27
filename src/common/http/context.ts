import type { Request } from 'express';
import type { Locale } from '../i18n/i18n.js';
import type { Permission, StaffRole } from '../permissions/permissions.js';

/** Кто вошёл (сессия в базе, PLAN.md Р8). Заполняет SessionResolver — этап 2. */
export interface SessionInfo {
  sessionId: string;
  userId: string;
  locale: Locale;
  /** Вход команды платформы (Р11) */
  platform?: boolean;
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
