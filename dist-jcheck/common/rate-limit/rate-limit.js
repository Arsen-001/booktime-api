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
import { applyDecorators, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../errors/api-error.js';
import { REDIS } from '../tokens.js';
/** Лимиты в Redis (PLAN.md §5): вход по коду, отправка кода, публичные страницы. Окно фиксированное. */
let RateLimitService = class RateLimitService {
    constructor(redis) {
        this.redis = redis;
    }
    /** Засчитать попытку; allowed=false — лимит исчерпан, retryAfter — секунд до нового окна */
    async hit(key, limit, windowSec) {
        const k = `rl:${key}`;
        const [[, count], [, ttl]] = (await this.redis.multi().incr(k).ttl(k).exec());
        if (ttl < 0)
            await this.redis.expire(k, windowSec);
        return { allowed: count <= limit, retryAfter: ttl > 0 ? ttl : windowSec };
    }
};
RateLimitService = __decorate([
    Injectable(),
    __param(0, Inject(REDIS)),
    __metadata("design:paramtypes", [Function])
], RateLimitService);
export { RateLimitService };
const RULE = 'bt:rate-limit';
let RateLimitGuard = class RateLimitGuard {
    constructor(reflector, limits) {
        this.reflector = reflector;
        this.limits = limits;
    }
    async canActivate(host) {
        const rule = this.reflector.get(RULE, host.getHandler());
        if (!rule)
            return true;
        const req = host.switchToHttp().getRequest();
        const who = rule.by === 'session' ? (req.ctx.session?.sessionId ?? req.ctx.ip) : req.ctx.ip;
        const res = await this.limits.hit(`${rule.bucket}:${who}`, rule.limit, rule.windowSec);
        if (!res.allowed) {
            host.switchToHttp().getResponse().setHeader('Retry-After', String(res.retryAfter));
            throw new ApiError('rate_limited', `Too many requests, retry in ${res.retryAfter}s`);
        }
        return true;
    }
};
RateLimitGuard = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [Reflector,
        RateLimitService])
], RateLimitGuard);
export { RateLimitGuard };
/** @RateLimit({ bucket: 'auth-code', limit: 5, windowSec: 600, by: 'ip' }) */
export function RateLimit(rule) {
    return applyDecorators(SetMetadata(RULE, rule), UseGuards(RateLimitGuard));
}
//# sourceMappingURL=rate-limit.js.map