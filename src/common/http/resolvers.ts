import type { MemberInfo, SessionInfo } from './context.js';

/**
 * «Розетки» доступа. Этап 1 ставит заглушки (никто не вошёл, членства нет — всё закрыто); этап 2 подключает
 * сессии из базы, этап 3 — членство в бизнесе и права. Код guards от этого не меняется.
 */
export interface SessionResolver {
  /** id сессии из cookie → сессия или null (истекла, «выйти везде», сотрудник уволен) */
  resolve(sessionId: string): Promise<SessionInfo | null>;
}

/** Членство человека в бизнесе — для ответа входа и переключателя «Я клиент / Мой бизнес» (В-21) */
export interface MembershipSummary {
  businessId: string;
  businessName: string;
  /** salon | individual */
  kind: string;
  networkId: string | null;
  staffId: string;
  /** owner | admin | master */
  role: string;
}

/** Все действующие членства человека. Этап 2 — пусто (бизнесов ещё нет); этап 3 подключает таблицу staff. */
export interface MembershipLister {
  list(userId: string): Promise<MembershipSummary[]>;
}

export interface MembershipResolver {
  /** Действующее членство человека в бизнесе (status = active) или null */
  resolve(userId: string, businessId: string): Promise<MemberInfo | null>;
}

export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');
export const MEMBERSHIP_RESOLVER = Symbol('MEMBERSHIP_RESOLVER');
export const MEMBERSHIP_LISTER = Symbol('MEMBERSHIP_LISTER');

/** Заглушка этапа 1 (оставлена для скриптов без базы) */
export const noSessions: SessionResolver = { resolve: async () => null };
export const noMemberships: MembershipResolver = { resolve: async () => null };
export const noMembershipList: MembershipLister = { list: async () => [] };
