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
  /** owner | admin | master | network (владелец сети в филиале) */
  role: string;
  /** Филиалы бизнеса (для сети — все филиалы сети) */
  locationIds: string[];
  /** Бизнесы сети (владельцу сети — все филиалы, остальным — только этот) */
  businessIds: string[];
  /** Итоговые права в этом бизнесе (шаблон роли + галочки владельца, 03 §2) */
  permissions: string[];
  /**
   * «Вход только с IP салона» (ответ 22): кабинет этого бизнеса закрыт для адреса, с которого пришёл запрос, — сам адрес.
   * Есть только в «кто я» (list с ip); сайт показывает экран «Вход закрыт: адрес не салона» вместо кабинета
   */
  blockedIp?: string;
}

/** Все действующие членства человека (этап 3: таблица staff + владение сетью, common/http/membership.ts) */
export interface MembershipLister {
  /**
   * staffLoginId — вход логином администратора: он даёт доступ только к своему бизнесу (F-00-034).
   * ip — адрес запроса: членство, закрытое «Вход только с IP салона», получает blockedIp, попытка запоминается
   */
  list(userId: string, staffLoginId?: string | null, ip?: string): Promise<MembershipSummary[]>;
}

export interface MembershipResolver {
  /**
   * Действующее членство вошедшего в бизнесе (status = active) или null. ip — адрес запроса (ctx.ip): сотрудник с
   * «Вход только с IP салона» не с адреса салона — тоже null (закрыто для всех, кто спрашивает членство)
   */
  resolve(session: SessionInfo, businessId: string, ip: string): Promise<MemberInfo | null>;
  /**
   * resolve вернул null — не из-за адреса ли? Да: попытка запомнена (salon_ip_attempts), ответ — адрес для ошибки
   * ip_not_allowed. Нет (не член бизнеса) — null
   */
  ipRefusal?(session: SessionInfo, businessId: string, ip: string): Promise<string | null>;
}

export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');
export const MEMBERSHIP_RESOLVER = Symbol('MEMBERSHIP_RESOLVER');
export const MEMBERSHIP_LISTER = Symbol('MEMBERSHIP_LISTER');

/** Заглушка этапа 1 (оставлена для скриптов без базы) */
export const noSessions: SessionResolver = { resolve: async () => null };
export const noMemberships: MembershipResolver = { resolve: async () => null };
export const noMembershipList: MembershipLister = { list: async () => [] };
