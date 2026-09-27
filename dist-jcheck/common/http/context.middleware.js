var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PLATFORM_COOKIE, SESSION_COOKIE, isPlatformPath } from './context.js';
import { SESSION_RESOLVER } from './resolvers.js';
export function readCookie(header, name) {
    if (!header)
        return undefined;
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name)
            return decodeURIComponent(v.join('='));
    }
    return undefined;
}
/** Собирает req.ctx: id запроса (заголовок X-Request-Id или новый), IP, устройство, сессия из httpOnly cookie */
let ContextMiddleware = class ContextMiddleware {
    constructor(sessions) {
        this.sessions = sessions;
    }
    async use(req, res, next) {
        const incoming = req.header('x-request-id');
        const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', requestId);
        const platform = isPlatformPath(req.originalUrl ?? req.path);
        const token = readCookie(req.headers.cookie, platform ? PLATFORM_COOKIE : SESSION_COOKIE);
        const resolved = token ? await this.sessions.resolve(token) : null;
        // Сессия платформы действует только на путях платформы, обычная — только вне их
        const session = resolved && Boolean(resolved.platform) === platform ? resolved : null;
        req.ctx = {
            requestId,
            ip: req.ip ?? '',
            device: (req.header('user-agent') ?? '').slice(0, 200),
            session,
            member: null,
        };
        next();
    }
};
ContextMiddleware = __decorate([
    Injectable(),
    __param(0, Inject(SESSION_RESOLVER)),
    __metadata("design:paramtypes", [Object])
], ContextMiddleware);
export { ContextMiddleware };
//# sourceMappingURL=context.middleware.js.map