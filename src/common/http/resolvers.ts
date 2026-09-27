import type { MemberInfo, SessionInfo } from './context.js';

/**
 * «Розетки» доступа. Этап 1 ставит заглушки (никто не вошёл, членства нет — всё закрыто); этап 2 подключает
 * сессии из базы, этап 3 — членство в бизнесе и права. Код guards от этого не меняется.
 */
export interface SessionResolver {
  /** id сессии из cookie → сессия или null (истекла, «выйти везде», сотрудник уволен) */
  resolve(sessionId: string): Promise<SessionInfo | null>;
}

export interface MembershipResolver {
  /** Действующее членство человека в бизнесе (status = active) или null */
  resolve(userId: string, businessId: string): Promise<MemberInfo | null>;
}

export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');
export const MEMBERSHIP_RESOLVER = Symbol('MEMBERSHIP_RESOLVER');

export const noSessions: SessionResolver = { resolve: async () => null };
export const noMemberships: MembershipResolver = { resolve: async () => null };
