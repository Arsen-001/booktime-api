export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');
export const MEMBERSHIP_RESOLVER = Symbol('MEMBERSHIP_RESOLVER');
export const MEMBERSHIP_LISTER = Symbol('MEMBERSHIP_LISTER');
/** Заглушка этапа 1 (оставлена для скриптов без базы) */
export const noSessions = { resolve: async () => null };
export const noMemberships = { resolve: async () => null };
export const noMembershipList = { list: async () => [] };
//# sourceMappingURL=resolvers.js.map