export const SESSION_COOKIE = 'bt_session';
/** Сессия команды платформы — своя cookie: человек из команды может в том же браузере быть и клиентом */
export const PLATFORM_COOKIE = 'bt_platform';
/** Пути, для которых сессия берётся из PLATFORM_COOKIE */
export function isPlatformPath(path) {
    return path.startsWith('/v1/platform') || path.startsWith('/v1/auth/platform');
}
//# sourceMappingURL=context.js.map